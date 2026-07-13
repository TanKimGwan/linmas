import test from 'node:test';
import assert from 'node:assert/strict';
import { runReview } from '../src/review/run-review.mjs';

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
  rootDir: new URL('..', import.meta.url).pathname,
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
    io: { stdin: [Buffer.from('safe')], stdout: { write() {} }, isTTY: false }
  });
  const value = JSON.parse(result.output);
  assert.equal(value.review.schemaVersion, 1);
  assert.equal(value.policy.schemaVersion, 1);
  assert.equal(value.policy.humanReviewRequired, true);
});

test('policy flags require provider and exactly one source', async () => {
  await assert.rejects(
    () => runReview(executionArgs({ provider: null, policyId: 'baseline-appsec' }), { ...fakeDependencies, io: { stdin: [Buffer.from('safe')], stdout: { write() {} } } }),
    /policy evaluation requires --provider/
  );
  await assert.rejects(
    () => runReview(executionArgs({ policyId: 'baseline-appsec', policyFile: './team.json' }), { ...fakeDependencies, io: { stdin: [Buffer.from('safe')], stdout: { write() {} } } }),
    /exactly one policy/
  );
});
