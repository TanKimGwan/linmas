import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('execute errors without transmission state remain not-attempted', () => {
  const value = toPublicReviewError(Object.assign(new Error('invalid argument'), {
    toolCode: 'input_field_invalid'
  }), { transmitting: true });
  assert.equal(value.transmissionState, 'not-attempted');
  assert.equal(value.transmissionAttempted, false);
});

test('explicit post-transmission state is preserved', () => {
  const value = toPublicReviewError(Object.assign(new Error('late provider failure'), {
    toolCode: 'provider-transport',
    transmissionState: 'response-received',
    transmissionAttempted: true,
    providerResponseReceived: true
  }), { transmitting: true });
  assert.equal(value.transmissionState, 'response-received');
  assert.equal(value.transmissionAttempted, true);
  assert.equal(value.providerResponseReceived, true);
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

test('every MCP toolError literal has an explicit public mapping', () => {
  const source = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const codes = [...source.matchAll(/toolError\(([^,\n]+)/g)]
    .flatMap((match) => [...match[1].matchAll(/(?:^\s*|\?\s*|:\s*)'([^']+)'/g)].map((literal) => literal[1]));
  for (const code of new Set(codes)) {
    const value = toPublicReviewError({ toolCode: code });
    assert.notEqual(value.code, 'INTERNAL_ERROR', `toolError(${code}) must be explicitly mapped`);
    if (!['input_field_invalid', 'invalid_input'].includes(code)) assert.notEqual(value.code, 'INPUT_FIELD_INVALID', `toolError(${code}) must not use the old catch-all`);
  }
});

test('new MCP error mappings expose safe codes, messages, and stages', () => {
  const cases = [
    ['invalid_input', 'INPUT_FIELD_INVALID', 'A request field is invalid.', 'argument-validation'],
    ['decision_input_required', 'DECISION_INPUT_REQUIRED', 'A required review decision input is missing.', 'argument-validation'],
    ['risk_acknowledgement_required', 'RISK_ACKNOWLEDGEMENT_REQUIRED', 'Explicit risk acknowledgement is required to continue.', 'argument-validation'],
    ['input', 'INPUT_FIELD_INVALID', 'A request field is invalid.', 'argument-validation'],
    ['write', 'ARTIFACT_WRITE_FAILED', 'The local artifact could not be written.', 'mcp-execution'],
    ['signature', 'SIGNATURE_VERIFICATION_FAILED', 'The artifact signature could not be verified.', 'mcp-execution'],
    ['proof', 'CONTRACT_VIOLATION', 'The supplied artifact violates the Linmas contract.', 'argument-validation'],
    ['output_too_large', 'OUTPUT_TOO_LARGE', 'The tool output exceeds the bounded output limit.', 'mcp-execution'],
    ['contract_violation', 'CONTRACT_VIOLATION', 'The supplied artifact violates the Linmas contract.', 'argument-validation']
  ];
  for (const [toolCode, code, message, stage] of cases) {
    const value = toPublicReviewError(new ReviewError('private input path', toolCode, EXIT_CODES.INPUT));
    assert.deepEqual({ code: value.code, message: value.message, stage: value.stage }, { code, message, stage });
  }
});

test('unclassified errors use a generic internal error envelope', () => {
  const value = toPublicReviewError(new TypeError('secret path and provider response'));
  assert.deepEqual({ code: value.code, message: value.message, stage: value.stage, reasonCode: value.reasonCode }, {
    code: 'INTERNAL_ERROR',
    message: 'The Linmas tool failed unexpectedly.',
    stage: 'mcp-execution',
    reasonCode: 'INTERNAL_ERROR'
  });
  assert.doesNotMatch(JSON.stringify(value), /secret|path|provider response/i);
  for (const toolCode of ['unknown-category', '__proto__', 'constructor']) {
    assert.equal(toPublicReviewError({ toolCode, stage: 'provider-execution' }).code, 'INTERNAL_ERROR');
  }
});

test('post-transmission policy mismatch has an accurate public message', () => {
  const value = toPublicReviewError({
    toolCode: 'policy_result_incompatible',
    stage: 'normalization',
    reasonCode: 'POLICY_RESPONSE_SPECIALIST_UNSUPPORTED',
    transmissionState: 'normalized'
  });
  assert.equal(value.code, 'POLICY_RESULT_INCOMPATIBLE');
  assert.equal(value.message, 'The provider response is incompatible with the requested policy.');
  assert.equal(value.reasonCode, 'POLICY_RESPONSE_SPECIALIST_UNSUPPORTED');
});

test('pre-transmission policy mode errors retain the policy contract', () => {
  const value = toPublicReviewError({ toolCode: 'policy_unsupported', reasonCode: 'POLICY_MODE_UNSUPPORTED' });
  assert.equal(value.code, 'POLICY_UNSUPPORTED');
  assert.equal(value.message, 'The requested policy is not supported.');
  assert.equal(value.reasonCode, 'POLICY_MODE_UNSUPPORTED');
  assert.equal(value.stage, 'argument-validation');
});

test('transport error messages cover response body failures without leaking details', () => {
  const value = toPublicReviewError(new ReviewError('private response body', 'provider-transport', EXIT_CODES.PROVIDER, {
    stage: 'response-read', transmissionState: 'response-received'
  }));
  assert.equal(value.message, 'The provider transport failed.');
  assert.equal(value.providerResponseReceived, true);
});

test('published MCP mapping table matches the public error contract', () => {
  const docs = readFileSync(new URL('../mcp/ERRORS.md', import.meta.url), 'utf8');
  assert.doesNotMatch(docs, /`INVALID_INPUT`/);
  const rows = docs.split('\n').filter((line) => line.startsWith('| `') || line.startsWith('| unclassified'));
  assert.ok(rows.length > 20);
  for (const row of rows) {
    const [, names, code, message, stage] = row.split('|').map((cell) => cell.trim().replaceAll('`', ''));
    for (const toolCode of names.split(', ')) {
      const value = toPublicReviewError({ toolCode });
      assert.deepEqual({ code: value.code, message: value.message, stage: value.stage }, { code, message, stage });
    }
  }
});
