import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveEvaluation } from '../src/evaluation/run-live-evaluation.mjs';

test('live evaluation caps cases and excludes raw response from report', async () => {
  const caseData = { schemaVersion: 1, id: 'secure-code/sql-injection-001', specialist: 'secure-code-reviewer', expectations: { requiredFindings: [], forbiddenClaims: [], requiredChecks: [], requiredSafetyBoundary: true } };
  const goodResult = { schemaVersion: 1, caseId: caseData.id, specialist: caseData.specialist, modelMetadata: { provider: 'fake', model: 'fake-1' }, scopeAndAssumptions: ['Only supplied synthetic material was reviewed.'], findings: [], deterministicChecks: [], safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' } };
  let calls = 0;
  const runner = { id: 'fake', model: 'fake-1', async run() { calls += 1; return { provider: 'fake', model: 'fake-1', rawResponse: JSON.stringify(goodResult), usage: { inputTokens: 1, outputTokens: 1 }, requestId: 'r' }; } };
  const report = await runLiveEvaluation({ cases: [{ caseData, inputText: 'safe' }, { caseData: { ...caseData, id: 'second' }, inputText: 'safe' }], runner, maxCases: 1, now: new Date('2026-07-12T00:00:00Z') });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(report).includes('rawResponse'), false);
  assert.equal(JSON.stringify(report).includes('requestId'), false);
  assert.equal(report.results.length, 1);
});

test('live evaluation injects canonical identity and provider metadata before validation', async () => {
  const caseData = { schemaVersion: 1, id: 'secure-code/minimal-001', specialist: 'secure-code-reviewer', expectations: { requiredFindings: [], forbiddenClaims: [], requiredChecks: [], requiredSafetyBoundary: true } };
  const runner = {
    id: 'codex',
    model: 'codex-model',
    async run() {
      return {
        provider: 'codex',
        model: 'codex-model',
        rawResponse: JSON.stringify({
          schemaVersion: 1,
          scopeAndAssumptions: ['Only supplied synthetic material was reviewed.'],
          findings: [],
          deterministicChecks: [],
          safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' }
        }),
        usage: null,
        requestId: 'request-1'
      };
    }
  };

  const report = await runLiveEvaluation({ cases: [{ caseData, inputText: 'safe' }], runner });
  assert.equal(report.results[0].caseId, caseData.id);
  assert.equal(report.results[0].passed, true);
});
