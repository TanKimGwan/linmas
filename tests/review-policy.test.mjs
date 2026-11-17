import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runReview } from '../src/review/run-review.mjs';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';

const providerResult = JSON.stringify({
  schemaVersion: 1,
  caseId: 'review/local',
  specialist: 'secure-code-reviewer',
  modelMetadata: { provider: 'fake', model: 'test' },
  scopeAndAssumptions: ['local fixture'],
  findings: [],
  deterministicChecks: [{ id: 'security regression test', completed: true }],
  safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' }
});

const fakeDependencies = {
  rootDir: fileURLToPath(new URL('..', import.meta.url)),
  providerRegistry: new Map([['fake', { create: () => ({ run: async () => ({ rawResponse: providerResult, provider: 'fake', model: 'test' }) }) }]]),
  loadPolicy: () => ({
    schemaVersion: 1,
    id: 'baseline-appsec',
    version: '1.0.0',
    specialists: ['secure-code-reviewer'],
    modes: ['advisor-review'],
    rules: [{ id: 'checks', type: 'minimum-checks', checks: ['security regression test'] }]
  })
};

function executionArgs(overrides = {}) {
  return {
    inputPath: null,
    useStdin: true,
    skillName: 'secure-code-reviewer',
    provider: 'fake',
    model: null,
    output: 'json',
    assumeYes: true,
    policyId: null,
    policyFile: null,
    ...overrides
  };
}

test('evaluates selected policy after normalized review', async () => {
  const result = await runReview(executionArgs({ policyId: 'baseline-appsec' }), {
    ...fakeDependencies,
    io: { stdin: Readable.from(['safe']), stdout: { write() {} }, isTTY: false }
  });
  const value = JSON.parse(result.output);
  assert.equal(value.review.schemaVersion, 1);
  assert.equal(value.policy.schemaVersion, 1);
  assert.equal(value.policy.humanReviewRequired, true);
});

test('policy flags require provider and exactly one source', async () => {
  await assert.rejects(
    () => runReview(executionArgs({ provider: null, policyId: 'baseline-appsec' }), { ...fakeDependencies, io: { stdin: Readable.from(['safe']), stdout: { write() {} } } }),
    /policy evaluation requires --provider/
  );
  await assert.rejects(
    () => runReview(executionArgs({ policyId: 'baseline-appsec', policyFile: './team.json' }), { ...fakeDependencies, io: { stdin: Readable.from(['safe']), stdout: { write() {} } } }),
    /exactly one policy/
  );
});

async function rejectedBeforeTransmission(overrides, { cwd } = {}) {
  const output = [];
  let created = false;
  let ran = false;
  const providerRegistry = new Map([['fake', { create: () => { created = true; return { run: async () => { ran = true; return { rawResponse: providerResult, provider: 'fake', model: 'test' }; } }; } }]]);
  const error = await runReview(executionArgs(overrides), {
    rootDir: fakeDependencies.rootDir,
    cwd,
    providerRegistry,
    io: { stdin: Readable.from(['safe']), stdout: { write(value) { output.push(value); } }, isTTY: false }
  }).then(() => null, (failure) => failure);
  assert.ok(error instanceof ReviewError, `expected ReviewError, got ${error}`);
  assert.equal(error.category, 'input');
  assert.equal(error.exitCode, EXIT_CODES.INPUT);
  assert.equal(created, false, 'runner must not be created');
  assert.equal(ran, false, 'runner must not run');
  assert.doesNotMatch(output.join(''), /Outbound review/);
  return error;
}

test('unknown built-in policy id is an input error before any transmission', async () => {
  const error = await rejectedBeforeTransmission({ policyId: 'no-such-policy' });
  assert.match(error.message, /unknown built-in policy: no-such-policy/);
});

test('invalid policy file is an input error before any transmission', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-policy-invalid-'));
  try {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const error = await rejectedBeforeTransmission({ policyFile: 'broken.json' }, { cwd: dir });
    assert.match(error.message, /invalid JSON/);
    const missing = await rejectedBeforeTransmission({ policyFile: 'missing.json' }, { cwd: dir });
    assert.match(missing.message, /unable to read policy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('specialist not accepted by the policy is rejected before any transmission', async () => {
  const error = await rejectedBeforeTransmission({ policyId: 'baseline-appsec', skillName: 'cloud-hardening-architect' });
  assert.match(error.message, /policy does not accept specialist: cloud-hardening-architect/);
});

test('mode not accepted by the policy is rejected before any transmission', async () => {
  const output = [];
  let created = false;
  const providerRegistry = new Map([['fake', { create: () => { created = true; return { run: async () => ({ rawResponse: providerResult, provider: 'fake', model: 'test' }) }; } }]]);
  await assert.rejects(
    runReview(executionArgs({ policyId: 'baseline-appsec' }), {
      ...fakeDependencies,
      providerRegistry,
      loadPolicy: () => ({ ...fakeDependencies.loadPolicy(), modes: ['other-mode'] }),
      io: { stdin: Readable.from(['safe']), stdout: { write(value) { output.push(value); } }, isTTY: false }
    }),
    (error) => error instanceof ReviewError && error.exitCode === EXIT_CODES.INPUT && /policy does not accept mode: advisor-review/.test(error.message)
  );
  assert.equal(created, false);
  assert.doesNotMatch(output.join(''), /Outbound review/);
});

test('matching built-in policy still evaluates after the review', async () => {
  const result = await runReview(executionArgs({ policyId: 'baseline-appsec' }), {
    rootDir: fakeDependencies.rootDir,
    providerRegistry: fakeDependencies.providerRegistry,
    io: { stdin: Readable.from(['safe']), stdout: { write() {} }, isTTY: false }
  });
  const value = JSON.parse(result.output);
  assert.equal(value.policy.policy.id, 'baseline-appsec');
});

test('provider response with a specialist the policy does not accept is rejected after transmission', async () => {
  let ran = false;
  const foreignResult = JSON.stringify({ ...JSON.parse(providerResult), specialist: 'cloud-hardening-architect' });
  const providerRegistry = new Map([['fake', { create: () => ({ run: async () => { ran = true; return { rawResponse: foreignResult, provider: 'fake', model: 'test' }; } }) }]]);
  const outcome = await runReview(executionArgs({ policyId: 'baseline-appsec' }), {
    rootDir: fakeDependencies.rootDir,
    providerRegistry,
    io: { stdin: Readable.from(['safe']), stdout: { write() {} }, isTTY: false }
  }).then((result) => ({ result }), (error) => ({ error }));
  assert.equal(ran, true, 'request specialist matches the policy, so the provider runs');
  assert.equal(outcome.result, undefined, `expected rejection, got output: ${outcome.result?.output}`);
  assert.ok(outcome.error instanceof ReviewError);
  assert.equal(outcome.error.exitCode, EXIT_CODES.INPUT);
  assert.match(outcome.error.message, /policy does not accept specialist: cloud-hardening-architect/);
});
