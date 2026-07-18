import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runReview } from '../src/review/run-review.mjs';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';

function fakeIo(lines = [], { isTTY = false } = {}) {
  const output = [];
  const errors = [];
  return {
    stdin: Readable.from([]),
    isTTY,
    stdout: { write(value) { output.push(value); } },
    stderr: { write(value) { errors.push(value); } },
    async readLine() { return lines.shift() ?? ''; },
    written() { return output.join(''); },
    errors() { return errors.join(''); }
  };
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-review-run-'));
fs.writeFileSync(path.join(fixtureDir, 'input.txt'), 'review this safe input');

const validResult = JSON.stringify({
  schemaVersion: 1,
  caseId: 'review/local',
  specialist: 'secure-code-reviewer',
  modelMetadata: { provider: 'fake', model: 'fake-model', usage: {}, requestId: 'fake-request' },
  scopeAndAssumptions: ['Review is limited to the supplied input.'],
  findings: [{
    id: 'input handling',
    status: 'Recommendation',
    severity: 'Low',
    evidence: 'The input is supplied as a bounded fixture.',
    affectedSurface: 'review input',
    preconditions: 'A user supplies a review request.',
    remediation: 'Keep the input boundary explicit.',
    verification: 'Run the bounded input test.'
  }],
  deterministicChecks: ['security regression test'],
  safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' }
});

test('prepare mode never resolves or runs a provider', async () => {
  let called = false;
  const result = await runReview({ inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: null, output: 'text' }, {
    cwd: fixtureDir,
    io: fakeIo(),
    providerRegistry: new Map([['claude', { create() { called = true; } }]])
  });
  assert.equal(result.exitCode, 0);
  assert.equal(called, false);
  assert.match(result.output, /No data was transmitted/);
});

test('execution reports outbound boundary and requires confirmation', async () => {
  const io = fakeIo(['no'], { isTTY: true });
  const providerRegistry = new Map([['fake', { create() { throw new Error('must not run'); } }]]);
  await assert.rejects(() => runReview({ inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: 'fake', output: 'text' }, { cwd: fixtureDir, io, providerRegistry }), /not confirmed/);
  assert.match(io.written(), /source: input\.txt[\s\S]*bytes:[\s\S]*provider: fake[\s\S]*data leaves this machine: yes/i);
});

test('execution fails closed on EOF, undefined, blank, and whitespace confirmation', async () => {
  for (const confirmation of [null, undefined, '', '   ']) {
    let created = false;
    const io = fakeIo([], { isTTY: true });
    io.readLine = async () => confirmation;
    const providerRegistry = new Map([['fake', { create() { created = true; return { run() {} }; } }]]);
    await assert.rejects(
      runReview({ inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: 'fake', output: 'text' }, { cwd: fixtureDir, io, providerRegistry }),
      (error) => error instanceof ReviewError && error.category === 'input' && error.exitCode === EXIT_CODES.INPUT && /not confirmed/.test(error.message)
    );
    assert.equal(created, false, `provider must not be created for confirmation ${String(confirmation)}`);
  }
});

test('execution accepts mixed-case yes confirmation', async () => {
  let called = false;
  const io = fakeIo([' YeS '], { isTTY: true });
  const providerRegistry = new Map([['fake', { create() { return { async run() { called = true; return { provider: 'fake', model: 'fake-model', rawResponse: validResult }; } }; } }]]);
  const result = await runReview({ inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: 'fake', output: 'json' }, { cwd: fixtureDir, io, providerRegistry });
  assert.equal(result.exitCode, EXIT_CODES.OK);
  assert.equal(called, true);
});

test('execution invokes the fake provider only after --yes', async () => {
  let called = false;
  const io = fakeIo();
  const providerRegistry = new Map([['fake', { create() { return { async run() { called = true; return { provider: 'fake', model: 'fake-model', rawResponse: validResult, usage: {}, requestId: 'fake-request' }; } }; } }]]);
  const result = await runReview({ inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: 'fake', output: 'json', assumeYes: true }, { cwd: fixtureDir, io, providerRegistry });
  assert.equal(called, true);
  assert.equal(JSON.parse(result.output).schemaVersion, 1);
});

test('descriptor creation failures remain provider errors', async () => {
  const providerRegistry = new Map([['fake', { create() { throw Object.assign(new Error('missing configuration'), { failureClass: 'provider-configuration' }); } }]]);
  await assert.rejects(
    runReview({ inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: 'fake', output: 'json', assumeYes: true }, { cwd: fixtureDir, io: fakeIo(), providerRegistry }),
    (error) => error instanceof ReviewError && error.category === 'provider-configuration' && error.exitCode === EXIT_CODES.PROVIDER
  );
});

test('outbound summary displays verified auth class and exact model without account PII', async () => {
  let created = false;
  const io = fakeIo();
  const providerRegistry = new Map([['codex', {
    id: 'codex',
    async prepareExecution() {
      return {
        model: 'gpt-5.6-sol',
        authMode: 'chatgpt',
        modelVerified: true,
        email: 'must-not-appear@example.test'
      };
    },
    create({ model }) {
      created = true;
      return {
        id: 'codex',
        model,
        async run() { return { provider: 'codex', model, rawResponse: validResult, usage: null, requestId: 'request' }; }
      };
    }
  }]]);

  const result = await runReview({
    inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: 'codex', output: 'json', assumeYes: true
  }, { cwd: fixtureDir, io, providerRegistry });

  assert.equal(result.exitCode, EXIT_CODES.OK);
  assert.equal(created, true);
  assert.match(io.written(), /provider: codex[\s\S]*auth: chatgpt[\s\S]*model: gpt-5\.6-sol[\s\S]*model verified: yes/i);
  assert.doesNotMatch(io.written(), /must-not-appear|example\.test/);
});

test('capability failure occurs before confirmation and provider runner creation', async () => {
  let created = false;
  let prompted = false;
  const io = fakeIo(['yes'], { isTTY: true });
  io.readLine = async () => { prompted = true; return 'yes'; };
  const providerRegistry = new Map([['codex', {
    id: 'codex',
    async prepareExecution() {
      throw new ReviewError('Codex is not authenticated', 'provider-authentication', EXIT_CODES.PROVIDER);
    },
    create() { created = true; return { run() {} }; }
  }]]);

  await assert.rejects(
    runReview({ inputPath: 'input.txt', useStdin: false, skillName: 'secure-code-reviewer', provider: 'codex', output: 'json' }, { cwd: fixtureDir, io, providerRegistry }),
    (error) => error.category === 'provider-authentication' && error.exitCode === EXIT_CODES.PROVIDER
  );
  assert.equal(prompted, false);
  assert.equal(created, false);
  assert.equal(io.written(), '');
});
