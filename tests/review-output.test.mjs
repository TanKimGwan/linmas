import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderResponse } from '../src/review/normalize-response.mjs';
import { formatReviewResult } from '../src/review/format-review.mjs';

const validReviewResult = {
  schemaVersion: 1,
  caseId: 'review/local',
  specialist: 'secure-code-reviewer',
  modelMetadata: { provider: 'claude', model: 'm', usage: {}, requestId: 'r' },
  scopeAndAssumptions: ['Review is limited to the supplied input.'],
  findings: [{
    id: 'input validation',
    status: 'Needs validation',
    severity: 'Medium',
    evidence: 'The supplied patch accepts untrusted input.',
    affectedSurface: 'request handler',
    preconditions: 'An attacker controls the request value.',
    remediation: 'Validate the value before use.',
    verification: 'Add a regression test for malformed input.'
  }],
  deterministicChecks: ['security regression test'],
  safetyBoundary: {
    satisfied: true,
    humanReviewRequired: true,
    statement: 'Human review remains required.'
  }
};

test('normalizes provider JSON through Phase 1 validation', () => {
  const raw = JSON.stringify({ ...validReviewResult, modelMetadata: undefined });
  const result = normalizeProviderResponse({ provider: 'claude', model: 'm', rawResponse: raw, usage: {}, requestId: 'r' }, { caseId: 'review/local', specialist: 'secure-code-reviewer' });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.modelMetadata.provider, 'claude');
});

test('JSON output is stable and omits raw response', () => {
  const text = formatReviewResult(validReviewResult, { output: 'json' });
  assert.deepEqual(JSON.parse(text), validReviewResult);
  assert.equal(text.includes('rawResponse'), false);
});

test('text output keeps human review visible', () => {
  assert.match(formatReviewResult(validReviewResult), /Human review required: yes/);
  assert.match(formatReviewResult(validReviewResult), /input validation/);
});
