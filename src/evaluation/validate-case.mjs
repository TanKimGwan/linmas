import { EXPECTED_SKILLS } from '../core/list-skills.mjs';

const MODES = new Set(['advisor-review', 'design-review']);
const INPUT_TYPES = new Set(['text', 'code', 'diff', 'configuration', 'design-document']);
const STATUSES = new Set(['Confirmed finding', 'Needs validation', 'Recommendation']);
const SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low', 'Info']);
const TOP_FIELDS = new Set(['schemaVersion', 'id', 'title', 'specialist', 'mode', 'scope', 'input', 'expectations', 'metadata']);
const SCOPE_FIELDS = new Set(['authorized', 'description']);
const INPUT_FIELDS = new Set(['type', 'contentFile']);
const EXPECTATION_FIELDS = new Set(['requiredFindings', 'forbiddenClaims', 'requiredChecks', 'requiredSafetyBoundary']);
const FINDING_FIELDS = new Set(['id', 'statuses', 'severities', 'evidenceAnchors', 'requiredFields', 'critical']);
const METADATA_FIELDS = new Set(['origin', 'license', 'difficulty', 'tags']);

function object(value, field, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: ${field} must be an object`);
  return value;
}

function string(value, field, source) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${source}: ${field} must be a non-empty string`);
  return value;
}

function array(value, field, source) {
  if (!Array.isArray(value)) throw new Error(`${source}: ${field} must be an array`);
  return value;
}

function allow(value, fields, label, source) {
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(`${source}: unknown ${label} field ${key}`);
}

export function validateEvaluationCase(value, { casePath = '<case>' } = {}) {
  const source = casePath;
  object(value, 'case', source);
  if (value.schemaVersion !== 1) throw new Error(`${source}: unsupported schemaVersion ${value.schemaVersion}`);
  allow(value, TOP_FIELDS, 'case', source);
  for (const field of ['id', 'title', 'specialist', 'mode']) string(value[field], field, source);
  if (!EXPECTED_SKILLS.includes(value.specialist) || value.specialist === 'security-domain-router') throw new Error(`${source}: unknown specialist ${value.specialist}`);
  if (!MODES.has(value.mode)) throw new Error(`${source}: invalid mode ${value.mode}`);

  const scope = object(value.scope, 'scope', source);
  allow(scope, SCOPE_FIELDS, 'scope', source);
  if (scope.authorized !== true) throw new Error(`${source}: scope.authorized must be true`);
  string(scope.description, 'scope.description', source);

  const input = object(value.input, 'input', source);
  allow(input, INPUT_FIELDS, 'input', source);
  if (!INPUT_TYPES.has(input.type)) throw new Error(`${source}: unsupported input type ${input.type}`);
  string(input.contentFile, 'input.contentFile', source);

  const expectations = object(value.expectations, 'expectations', source);
  allow(expectations, EXPECTATION_FIELDS, 'expectations', source);
  const findings = array(expectations.requiredFindings, 'expectations.requiredFindings', source);
  const findingIds = new Set();
  for (const finding of findings) {
    object(finding, 'finding', source);
    allow(finding, FINDING_FIELDS, 'finding', source);
    string(finding.id, 'finding.id', source);
    if (findingIds.has(finding.id)) throw new Error(`${source}: duplicate finding id ${finding.id}`);
    findingIds.add(finding.id);
    if (!array(finding.statuses, 'finding.statuses', source).length || !finding.statuses.every((item) => STATUSES.has(item))) throw new Error(`${source}: invalid finding status`);
    if (!array(finding.severities, 'finding.severities', source).length || !finding.severities.every((item) => SEVERITIES.has(item))) throw new Error(`${source}: invalid finding severity`);
    if (!array(finding.evidenceAnchors, 'finding.evidenceAnchors', source).length || !finding.evidenceAnchors.every((item) => typeof item === 'string' && item.trim())) throw new Error(`${source}: evidenceAnchors must contain strings`);
    if (finding.requiredFields !== undefined && (!Array.isArray(finding.requiredFields) || !finding.requiredFields.every((item) => typeof item === 'string' && item.trim()))) throw new Error(`${source}: requiredFields must contain strings`);
    if (finding.critical !== undefined && typeof finding.critical !== 'boolean') throw new Error(`${source}: finding.critical must be boolean`);
  }
  for (const field of ['forbiddenClaims', 'requiredChecks']) {
    const values = array(expectations[field], `expectations.${field}`, source);
    if (!values.every((item) => typeof item === 'string' && item.trim())) throw new Error(`${source}: ${field} must contain strings`);
  }
  if (expectations.requiredSafetyBoundary !== true) throw new Error(`${source}: requiredSafetyBoundary must be true`);

  const metadata = object(value.metadata, 'metadata', source);
  allow(metadata, METADATA_FIELDS, 'metadata', source);
  if (!['synthetic', 'sanitized-open-source', 'defensive-design'].includes(metadata.origin)) throw new Error(`${source}: invalid metadata.origin`);
  string(metadata.license, 'metadata.license', source);
  string(metadata.difficulty, 'metadata.difficulty', source);
  const tags = array(metadata.tags, 'metadata.tags', source);
  if (!tags.length || !tags.every((item) => typeof item === 'string' && item.trim())) throw new Error(`${source}: metadata.tags must contain strings`);
  return structuredClone(value);
}
