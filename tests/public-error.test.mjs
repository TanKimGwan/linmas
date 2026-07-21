import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';
import { toPublicReviewError } from '../src/review/public-error.mjs';

test('public provider errors preserve allowlisted diagnosis without sensitive fields', () => {
  const error = new ReviewError('raw provider stderr Authorization: Bearer secret', 'provider-configuration', EXIT_CODES.PROVIDER, {
    stage: 'model-selection', reasonCode: 'MODEL_NOT_AVAILABLE', retryable: false,
    provider: 'codex', transmissionState: 'not-attempted'
  });
  error.cause = new Error('secret token=abc');
  const value = toPublicReviewError(error, { transmitting: true });
  assert.deepEqual(value, {
    schemaVersion: 1,
    code: 'PROVIDER_CONFIGURATION_MISSING',
    message: 'Provider configuration is incomplete.',
    stage: 'model-selection',
    reasonCode: 'MODEL_NOT_AVAILABLE',
    retryable: false,
    provider: 'codex',
    transmissionState: 'not-attempted',
    transmissionAttempted: false,
    providerResponseReceived: false,
    capsuleWritten: false
  });
  assert.doesNotMatch(JSON.stringify(value), /secret|stderr|cause|requestId/i);
});

test('public timeout errors remain structured and fail closed', () => {
  const value = toPublicReviewError(Object.assign(new Error('late provider'), {
    toolCode: 'timeout'
  }), { transmitting: true });
  assert.equal(value.code, 'MCP_TIMEOUT');
  assert.equal(value.stage, 'mcp-execution');
  assert.equal(value.reasonCode, 'EXECUTION_TIMEOUT');
  assert.equal(value.transmissionState, 'attempted');
  assert.equal(value.retryable, true);
});

test('public upstream diagnostics expose only the granular safe contract', () => {
  const value = toPublicReviewError(new ReviewError('raw upstream body secret', 'provider-upstream', EXIT_CODES.PROVIDER, {
    stage: 'provider-execution', reasonCode: 'EXECUTION_UPSTREAM_FAILED', retryable: true,
    provider: 'claude', transmissionState: 'response-received', httpStatus: 503
  }), { transmitting: true });
  assert.equal(value.code, 'PROVIDER_UPSTREAM_FAILED');
  assert.equal(value.httpStatus, 503);
  assert.equal(value.providerResponseReceived, true);
  assert.doesNotMatch(JSON.stringify(value), /raw|secret|body|requestId|stderr/i);
});
