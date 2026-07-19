import { validateReviewResult } from '../evaluation/validate-result.mjs';

const TOP_FIELDS = new Set(['schemaVersion', 'kind', 'input', 'execution', 'review', 'policy', 'safetyBoundary']);
const INPUT_FIELDS = new Set(['source', 'bytes', 'sha256']);
const EXECUTION_FIELDS = new Set(['mode', 'provider', 'authMode', 'model', 'modelVerified', 'generatedAt']);
const POLICY_FIELDS = new Set(['status', 'result']);
const POLICY_RESULT_FIELDS = new Set(['schemaVersion', 'policy', 'review', 'decision', 'rules', 'completedChecks', 'outstandingChecks', 'humanReviewRequired', 'disclaimer']);
const POLICY_IDENTITY_FIELDS = new Set(['id', 'version']);
const POLICY_REVIEW_FIELDS = new Set(['caseId', 'specialist']);
const POLICY_RULE_FIELDS = new Set(['id', 'outcome', 'decision', 'reason']);
const POLICY_DECISIONS = new Set(['pass', 'needs-review', 'blocked']);
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
    validatePolicyResult(value.policy.result);
  } else {
    fail('policy.status is invalid');
  }

  canonicalSafety(value.safetyBoundary, 'safetyBoundary');
  if (JSON.stringify(value.safetyBoundary) !== JSON.stringify(review.safetyBoundary)) fail('capsule safety boundary must match the review');
  rejectPrivateKeys(value);
  return structuredClone(value);
}

function validatePolicyResult(value) {
  object(value, 'policy.result');
  exactFields(value, POLICY_RESULT_FIELDS, 'policy.result');
  if (value.schemaVersion !== 1) fail('policy.result schemaVersion is invalid');

  object(value.policy, 'policy.result.policy');
  exactFields(value.policy, POLICY_IDENTITY_FIELDS, 'policy.result.policy');
  string(value.policy.id, 'policy.result.policy.id');
  string(value.policy.version, 'policy.result.policy.version');

  object(value.review, 'policy.result.review');
  exactFields(value.review, POLICY_REVIEW_FIELDS, 'policy.result.review');
  string(value.review.caseId, 'policy.result.review.caseId');
  string(value.review.specialist, 'policy.result.review.specialist');

  policyDecision(value.decision, 'policy.result.decision');
  if (!Array.isArray(value.rules)) fail('policy.result.rules must be an array');
  for (const [index, rule] of value.rules.entries()) {
    const field = `policy.result.rules[${index}]`;
    object(rule, field);
    exactFields(rule, POLICY_RULE_FIELDS, field);
    string(rule.id, `${field}.id`);
    if (rule.outcome !== 'met' && rule.outcome !== 'failed') fail(`${field}.outcome is invalid`);
    policyDecision(rule.decision, `${field}.decision`);
    string(rule.reason, `${field}.reason`);
  }

  stringArray(value.completedChecks, 'policy.result.completedChecks');
  stringArray(value.outstandingChecks, 'policy.result.outstandingChecks');
  if (value.humanReviewRequired !== true) fail('policy must require human review');
  string(value.disclaimer, 'policy.result.disclaimer');
}

function policyDecision(value, field) {
  if (!POLICY_DECISIONS.has(value)) fail(`${field} is invalid`);
}

function stringArray(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  const seen = new Set();
  for (const item of value) {
    string(item, field);
    if (seen.has(item)) fail(`${field} must not contain duplicates`);
    seen.add(item);
  }
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
