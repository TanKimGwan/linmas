import { EXPECTED_SKILLS } from '../core/list-skills.mjs';

const STATUSES = new Set(['Confirmed finding', 'Needs validation', 'Recommendation']);
const SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low', 'Info']);
const RESULT_FIELDS = new Set(['schemaVersion', 'caseId', 'specialist', 'modelMetadata', 'scopeAndAssumptions', 'findings', 'deterministicChecks', 'safetyBoundary']);
const MODEL_FIELDS = new Set(['provider', 'model', 'generatedAt', 'usage', 'requestId']);
const MAX_TEXT = 16 * 1024;

function boundedString(value, field, source) {
  const text = requiredString(value, field, source);
  if (text.length > MAX_TEXT) throw new Error(`${source}: ${field} exceeds ${MAX_TEXT} characters`);
  if (text.includes('\\u0000')) throw new Error(`${source}: ${field} contains NUL`);
  return text;
}
const FINDING_FIELDS = new Set(['id', 'status', 'severity', 'evidence', 'affectedSurface', 'preconditions', 'remediation', 'verification']);
const CHECK_FIELDS = new Set(['id', 'completed']);
const SAFETY_FIELDS = new Set(['satisfied', 'humanReviewRequired', 'statement']);

function requiredString(value, field, source) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${source}: ${field} is required`);
  return value;
}

export function validateReviewResult(value, { source = '<result>' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: result must be an object`);
  if (value.schemaVersion !== 1) throw new Error(`${source}: unsupported result schema`);
  for (const key of Object.keys(value)) if (!RESULT_FIELDS.has(key)) throw new Error(`${source}: unknown result field ${key}`);
  boundedString(value.caseId, 'caseId', source);
  if (!EXPECTED_SKILLS.includes(value.specialist) || value.specialist === 'security-domain-router') throw new Error(`${source}: unknown specialist ${value.specialist}`);
  if (!value.modelMetadata || typeof value.modelMetadata !== 'object' || Array.isArray(value.modelMetadata)) throw new Error(`${source}: modelMetadata is required`);
  for (const key of Object.keys(value.modelMetadata)) if (!MODEL_FIELDS.has(key)) throw new Error(`${source}: unknown modelMetadata field ${key}`);
  for (const field of ['provider', 'model']) boundedString(value.modelMetadata[field], `modelMetadata.${field}`, source);
  if (value.modelMetadata.generatedAt !== undefined) boundedString(value.modelMetadata.generatedAt, 'modelMetadata.generatedAt', source);
  if (!Array.isArray(value.scopeAndAssumptions) || !value.scopeAndAssumptions.every((item) => typeof item === 'string' && item.trim() && item.length <= MAX_TEXT)) throw new Error(`${source}: scopeAndAssumptions must be bounded strings`);
  if (!Array.isArray(value.findings)) throw new Error(`${source}: findings must be an array`);
  const findingIds = new Set();
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new Error(`${source}: finding must be an object`);
    for (const key of Object.keys(finding)) if (!FINDING_FIELDS.has(key)) throw new Error(`${source}: unknown finding field ${key}`);
    for (const key of FINDING_FIELDS) boundedString(finding[key], `finding.${key}`, source);
    if (findingIds.has(finding.id)) throw new Error(`${source}: duplicate finding id ${finding.id}`);
    findingIds.add(finding.id);
    if (!STATUSES.has(finding.status)) throw new Error(`${source}: invalid status ${finding.status}`);
    if (!SEVERITIES.has(finding.severity)) throw new Error(`${source}: invalid severity ${finding.severity}`);
  }
  if (!Array.isArray(value.deterministicChecks)) throw new Error(`${source}: deterministicChecks must be an array`);
  const checks = value.deterministicChecks.map((check) => {
    if (typeof check === 'string') return { id: boundedString(check, 'deterministicCheck', source), completed: true };
    if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error(`${source}: deterministic check must be a string or object`);
    for (const key of Object.keys(check)) if (!CHECK_FIELDS.has(key)) throw new Error(`${source}: unknown deterministic check field ${key}`);
    return { id: boundedString(check.id, 'deterministicCheck.id', source), completed: check.completed === true };
  });
  let safetyBoundary = value.safetyBoundary;
  if (typeof safetyBoundary === 'string') {
    const humanReviewRequired = /human review\s+(?:remains\s+)?required\b/i.test(safetyBoundary) && !/human review\s+(?:is\s+)?not required\b/i.test(safetyBoundary);
    if (!humanReviewRequired) throw new Error(`${source}: safety boundary must require human review`);
    safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: safetyBoundary };
  }
  if (!safetyBoundary || typeof safetyBoundary !== 'object' || Array.isArray(safetyBoundary)) throw new Error(`${source}: safetyBoundary is required`);
  for (const key of Object.keys(safetyBoundary)) if (!SAFETY_FIELDS.has(key)) throw new Error(`${source}: unknown safety boundary field ${key}`);
  if (typeof safetyBoundary.satisfied !== 'boolean' || typeof safetyBoundary.humanReviewRequired !== 'boolean') throw new Error(`${source}: safetyBoundary flags are required`);
  boundedString(safetyBoundary.statement, 'safetyBoundary.statement', source);
  const checkIds = new Set();
  for (const check of checks) if (!checkIds.add(check.id)) throw new Error(`${source}: duplicate deterministic check id ${check.id}`);
  return structuredClone({ ...value, deterministicChecks: checks, safetyBoundary });
}
