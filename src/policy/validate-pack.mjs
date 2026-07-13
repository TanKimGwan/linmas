const TOP_FIELDS = new Set([
  'schemaVersion',
  'id',
  'version',
  'description',
  'specialists',
  'modes',
  'acceptedInputs',
  'rules',
  'humanReview'
]);
const RULE_FIELDS = new Set(['id', 'type', 'checks', 'severities', 'statuses', 'status']);
const RULE_TYPES = new Set(['minimum-checks', 'finding-threshold', 'require-evidence', 'require-verification']);
const DECISIONS = new Set(['needs-review', 'blocked']);
const CERTIFICATION = /\b(certified|certification|compliant with|guarantees compliance)\b/i;
const HUMAN_REVIEW_FIELDS = new Set(['required', 'statement']);

function requiredString(value, field, source) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${source}: ${field} is required`);
  return value;
}

function stringList(value, field, source) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${source}: ${field} must not be empty`);
  }
  return value;
}

export function validatePolicyPack(value, { source = '<policy>' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: policy must be an object`);
  if (value.schemaVersion !== 1) throw new Error(`${source}: unsupported schemaVersion ${value.schemaVersion}`);
  for (const key of Object.keys(value)) if (!TOP_FIELDS.has(key)) throw new Error(`${source}: unknown field ${key}`);
  for (const key of ['id', 'version', 'description']) requiredString(value[key], key, source);
  if (CERTIFICATION.test(`${value.id} ${value.description}`)) throw new Error(`${source}: certification claim is not allowed`);
  for (const key of ['specialists', 'modes', 'acceptedInputs', 'rules']) {
    if (!Array.isArray(value[key]) || value[key].length === 0) throw new Error(`${source}: ${key} must not be empty`);
  }
  if (!value.humanReview || typeof value.humanReview !== 'object' || Array.isArray(value.humanReview)) throw new Error(`${source}: human review must be required`);
  for (const key of Object.keys(value.humanReview)) if (!HUMAN_REVIEW_FIELDS.has(key)) throw new Error(`${source}: unknown human review field ${key}`);
  if (value.humanReview.required !== true || typeof value.humanReview.statement !== 'string' || !value.humanReview.statement.trim()) throw new Error(`${source}: human review must be required`);
  for (const rule of value.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${source}: rule must be an object`);
    for (const key of Object.keys(rule)) if (!RULE_FIELDS.has(key)) throw new Error(`${source}: unknown rule field ${key}`);
    requiredString(rule.id, 'rule.id', source);
    if (!RULE_TYPES.has(rule.type)) throw new Error(`${source}: unsupported rule type ${rule.type}`);
    if (rule.status !== undefined && !DECISIONS.has(rule.status)) throw new Error(`${source}: rule cannot produce ${rule.status}`);
    if (rule.checks !== undefined) stringList(rule.checks, 'rule.checks', source);
    if (rule.severities !== undefined) stringList(rule.severities, 'rule.severities', source);
    if (rule.statuses !== undefined) stringList(rule.statuses, 'rule.statuses', source);
  }
  return structuredClone(value);
}
