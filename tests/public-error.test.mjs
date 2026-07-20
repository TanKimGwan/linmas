import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';
import { toPublicReviewError } from '../src/review/public-error.mjs';

test('public provider errors preserve allowlisted diagnosis without sensitive fields', () => {
  const error = new ReviewError('raw provider stderr Authorization: Bearer secret', 'provider-configuration', EXIT_CODES.PROVIDER, {
    stage: 'model-selection', reasonCode: 'MODEL_NOT_AVAILABLE', retryable: false,
    provider: 'codex', transmissionState: 'not-started'
  });
  error.cause = new Error('secret token=abc');
  const value = toPublicReviewError(error, { transmitting: true });
  assert.deepEqual(value, {
    code: 'PROVIDER_FAILURE',
    message: 'Requested model is not visible to the authenticated provider account.',
    schemaVersion: 1,
    failureClass: 'provider-configuration',
    stage: 'model-selection',
    reasonCode: 'MODEL_NOT_AVAILABLE',
    retryable: false,
    provider: 'codex',
    transmissionState: 'not-started'
  });
  assert.doesNotMatch(JSON.stringify(value), /secret|stderr|cause|requestId/i);
});

test('public timeout errors remain structured and fail closed', () => {
  const value = toPublicReviewError(Object.assign(new Error('late provider'), {
    toolCode: 'timeout'
  }), { transmitting: true });
  assert.equal(value.code, 'TIMEOUT');
  assert.equal(value.failureClass, 'timeout');
  assert.equal(value.stage, 'mcp-execution');
  assert.equal(value.reasonCode, 'EXECUTION_TIMEOUT');
  assert.equal(value.transmissionState, 'unknown');
  assert.equal(value.retryable, true);
});
