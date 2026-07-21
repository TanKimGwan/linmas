import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runReview } from '../src/review/run-review.mjs';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';

const providers = ['claude', 'codex'];
const providerFailures = [
  ['missing configuration', 'provider-configuration'],
  ['authentication', 'provider-authentication'],
  ['nonzero exit', 'provider-transport'],
  ['timeout', 'provider-timeout'],
  ['rate limit', 'provider-rate-limit'],
  ['cancellation', 'provider-transport']
];
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-provider-parity-'));
fs.writeFileSync(path.join(fixtureDir, 'input.txt'), 'review this bounded fixture');

const validResult = JSON.stringify({
  schemaVersion: 1,
  scopeAndAssumptions: ['Review is limited to the supplied input.'],
  findings: [],
  deterministicChecks: ['security regression test'],
  safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' }
});

function args(provider) {
  return {
    inputPath: 'input.txt',
    useStdin: false,
    skillName: 'secure-code-reviewer',
    provider,
    output: 'json',
    assumeYes: true
  };
}

function dependencies(provider, outcome = { rawResponse: validResult }) {
  const written = [];
  return {
    cwd: fixtureDir,
    io: {
      stdin: Readable.from([]),
      isTTY: false,
      stdout: { write(value) { written.push(value); } },
      stderr: { write() {} },
      written() { return written.join(''); }
    },
    providerRegistry: new Map([[provider, {
      id: provider,
      create() {
        return {
          async run() {
            if (outcome.error) throw outcome.error;
            return { provider, model: `${provider}-model`, usage: null, requestId: `${provider}-request`, ...outcome };
          }
        };
      }
    }]])
  };
}

function providerFailure(failureClass) {
  return Object.assign(new Error(failureClass), { failureClass });
}

for (const provider of providers) {
  test(`${provider} execution returns the same normalized contract and confirmation`, async () => {
    const deps = dependencies(provider);
    const result = await runReview(args(provider), deps);
    const value = JSON.parse(result.output);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.specialist, 'secure-code-reviewer');
    assert.equal(value.modelMetadata.provider, provider);
    assert.equal(value.safetyBoundary.humanReviewRequired, true);
    assert.match(deps.io.written(), new RegExp(`provider: ${provider}[\\s\\S]*data leaves this machine: yes`, 'i'));
  });

  for (const [name, failureClass] of providerFailures) {
    test(`${provider} ${name} remains a provider error`, async () => {
      await assert.rejects(
        runReview(args(provider), dependencies(provider, { error: providerFailure(failureClass) })),
        (error) => error instanceof ReviewError && error.failureClass === failureClass && error.exitCode === EXIT_CODES.PROVIDER
      );
    });
  }

  test(`${provider} adapter normalization failure remains a normalization error`, async () => {
    await assert.rejects(
      runReview(args(provider), dependencies(provider, { error: providerFailure('normalization-failed') })),
      (error) => error instanceof ReviewError && error.category === 'normalization' && error.exitCode === EXIT_CODES.CONTRACT
    );
  });

  test(`${provider} malformed output is a provider response error`, async () => {
    await assert.rejects(
      runReview(args(provider), dependencies(provider, { rawResponse: '{' })),
      (error) => error instanceof ReviewError && error.category === 'provider-response-invalid' && error.exitCode === EXIT_CODES.PROVIDER
    );
  });

  test(`${provider} oversized normalized output remains a contract error`, async () => {
      await assert.rejects(
        runReview(args(provider), dependencies(provider, { rawResponse: JSON.stringify({ schemaVersion: 1, scopeAndAssumptions: ['x'.repeat(16 * 1024 + 1)] }) })),
        (error) => error instanceof ReviewError && error.category === 'normalization' && error.exitCode === EXIT_CODES.CONTRACT
      );
  });
}

test('fake-only execution does not read or mutate installation manifests', async () => {
  const before = fs.readdirSync(fixtureDir);
  await Promise.all(providers.map((provider) => runReview(args(provider), dependencies(provider))));
  assert.deepEqual(fs.readdirSync(fixtureDir), before);
  assert.equal(before.some((name) => name.includes('manifest')), false);
});
