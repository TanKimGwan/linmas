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

function classification(error) {
  return {
    name: error?.name,
    message: error?.message,
    category: error?.category,
    failureClass: error?.failureClass,
    exitCode: error?.exitCode,
    stage: error?.stage,
    reasonCode: error?.reasonCode,
    retryable: error?.retryable,
    provider: error?.provider,
    transmissionState: error?.transmissionState
  };
}

function normalizationFailure(rawResponse) {
  try {
    normalizeProviderResponse({ provider: 'claude', model: 'm', rawResponse, usage: {}, requestId: 'r' }, { caseId: 'review/local', specialist: 'secure-code-reviewer' });
  } catch (error) {
    return error;
  }
  return null;
}

test('non-object provider JSON is classified exactly like invalid JSON without echoing the response', () => {
  const invalidJson = classification(normalizationFailure('{not json'));
  assert.equal(invalidJson.reasonCode, 'RESPONSE_JSON_INVALID');
  assert.equal(invalidJson.message, 'provider response failed contract validation: invalid JSON');
  const cases = ['null', '[]', '"secret-response-text"', '5', 'true', JSON.stringify([validReviewResult])];
  for (const rawResponse of cases) {
    const error = normalizationFailure(rawResponse);
    assert.ok(error, `expected rejection for ${rawResponse}`);
    assert.deepEqual({ ...classification(error), message: undefined }, { ...invalidJson, message: undefined }, `classification for ${rawResponse}`);
    assert.equal(error.message, 'provider response failed contract validation: JSON value is not an object');
    assert.doesNotMatch(error.message, /secret-response-text|schemaVersion|input validation/);
  }
});
