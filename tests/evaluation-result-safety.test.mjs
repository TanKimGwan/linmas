import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewResult } from '../src/evaluation/validate-result.mjs';

test('rejects a string safety boundary that negates human review', () => {
  const result = { schemaVersion: 1, caseId: 'x', specialist: 'secure-code-reviewer', modelMetadata: { provider: 'fixture', model: 'test' }, scopeAndAssumptions: ['x'], findings: [], deterministicChecks: [], safetyBoundary: 'Human review is not required.' };
  assert.throws(() => validateReviewResult(result), /safety boundary/);
});
