import { validateReviewResult } from '../evaluation/validate-result.mjs';

const TOP_FIELDS = new Set(['schemaVersion', 'kind', 'input', 'execution', 'review', 'policy', 'safetyBoundary']);
const INPUT_FIELDS = new Set(['source', 'bytes', 'sha256']);
const EXECUTION_FIELDS = new Set(['mode', 'provider', 'authMode', 'model', 'modelVerified', 'generatedAt']);
const POLICY_FIELDS = new Set(['status', 'result']);
const AUTH_MODES = new Set(['chatgpt', 'apiKey', 'unverified', 'unavailable']);
const CANONICAL_STATEMENT = 'Human review remains required.';
const PRIVATE_KEYS = /^(?:email|accountId|planType|stderr|rawStderr|sessionId|token|apiKey|password|secret)$/i;

export function validateReviewCapsule(value) {
  object(value, 'capsule');
  exactFields(value, TOP_FIELDS, 'capsule');
  if (value.schemaVersion !== 1) fail('unsupported schemaVersion');
  if (value.kind !== 'linmas-review-capsule') fail('kind must be linmas-review-capsule');

  object(value.input, 'input');
  exactFields(value.input, INPUT_FIELDS, 'input');
  string(value.input.source, 'input.source');
  if (!Number.isSafeInteger(value.input.bytes) || value.input.bytes < 0) fail('input.bytes must be a non-negative integer');
  if (typeof value.input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.input.sha256)) fail('input.sha256 must be a SHA-256 hex digest');

  object(value.execution, 'execution');
  exactFields(value.execution, EXECUTION_FIELDS, 'execution');
  if (value.execution.mode !== 'live' && value.execution.mode !== 'offline-fixture') fail('execution.mode is invalid');
  string(value.execution.provider, 'execution.provider');
  string(value.execution.model, 'execution.model');
  if (!AUTH_MODES.has(value.execution.authMode)) fail('execution.authMode is invalid');
  if (typeof value.execution.modelVerified !== 'boolean') fail('execution.modelVerified must be boolean');
  if (typeof value.execution.generatedAt !== 'string' || Number.isNaN(Date.parse(value.execution.generatedAt))) fail('execution.generatedAt must be RFC-3339');
  if (value.execution.mode === 'offline-fixture' && (value.execution.authMode !== 'unavailable' || value.execution.modelVerified !== false)) {
    fail('offline-fixture execution cannot claim live authentication or model verification');
  }
  if (value.execution.mode === 'live' && value.execution.authMode === 'unavailable') fail('live execution must have an auth classification');

  object(value.review, 'review');
  canonicalSafety(value.review.safetyBoundary, 'review.safetyBoundary');
  const review = validateReviewResult(value.review, { source: 'capsule.review' });
  if (review.modelMetadata.requestId !== null) fail('private request identifiers are not allowed');

  object(value.policy, 'policy');
  exactFields(value.policy, POLICY_FIELDS, 'policy');
  if (value.policy.status === 'not-evaluated') {
    if (value.policy.result !== null) fail('non-evaluated policy result must be null');
  } else if (value.policy.status === 'evaluated') {
    object(value.policy.result, 'policy.result');
    if (!['pass', 'needs-review', 'blocked'].includes(value.policy.result.decision)) fail('policy decision is invalid');
    if (value.policy.result.humanReviewRequired !== true) fail('policy must require human review');
  } else {
    fail('policy.status is invalid');
  }

  canonicalSafety(value.safetyBoundary, 'safetyBoundary');
  if (JSON.stringify(value.safetyBoundary) !== JSON.stringify(review.safetyBoundary)) fail('capsule safety boundary must match the review');
  rejectPrivateKeys(value);
  return structuredClone(value);
}

function canonicalSafety(value, field) {
  object(value, field);
  if (Object.keys(value).length !== 3
    || value.satisfied !== true
    || value.humanReviewRequired !== true
    || value.statement !== CANONICAL_STATEMENT) {
    fail(`${field} must preserve the canonical human review safety boundary`);
  }
}

function rejectPrivateKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_KEYS.test(key) && nested !== null) fail(`private field is not allowed: ${key}`);
    rejectPrivateKeys(nested);
  }
}

function exactFields(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${field}.${key} is required`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
}

function string(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`);
}

function fail(message) {
  throw new Error(`review capsule: ${message}`);
}
