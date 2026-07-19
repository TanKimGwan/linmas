import { CANONICAL_SAFETY_BOUNDARY, DISPOSITIONS, MAX_PROOF_TEXT, OVERALL_DISPOSITIONS } from './constants.mjs';
import { deriveOverallDisposition } from './derive-disposition.mjs';

const TOP_FIELDS = new Set(['schemaVersion', 'kind', 'subject', 'reviewer', 'decidedAt', 'findings', 'summary', 'safetyBoundary']);
const SUBJECT_FIELDS = new Set(['kind', 'sha256']);
const REVIEWER_FIELDS = new Set(['label', 'principal']);
const FINDING_FIELDS = new Set(['id', 'disposition', 'rationale']);
const SUMMARY_FIELDS = new Set(['overallDisposition', 'statement']);
const APPROVAL_LANGUAGE = /\b(?:approve[ds]?|approval|certif(?:y|ied|ication)|auto[- ]?approv(?:e|ed)|without human review)\b/i;

export function buildDecisionReceipt({ subject, reviewer, findings, statement, now = new Date() }) {
  const normalized = {
    schemaVersion: 1,
    kind: 'linmas-human-decision-receipt',
    subject: structuredClone(subject),
    reviewer: structuredClone(reviewer),
    decidedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    findings: structuredClone(findings),
    summary: { overallDisposition: deriveOverallDisposition(findings), statement },
    safetyBoundary: structuredClone(CANONICAL_SAFETY_BOUNDARY)
  };
  return validateDecisionReceipt(normalized);
}

export function validateDecisionReceipt(value) {
  object(value, 'receipt');
  exact(value, TOP_FIELDS, 'receipt');
  if (value.schemaVersion !== 1) fail('unsupported schemaVersion');
  if (value.kind !== 'linmas-human-decision-receipt') fail('kind is invalid');

  object(value.subject, 'receipt.subject');
  exact(value.subject, SUBJECT_FIELDS, 'receipt.subject');
  string(value.subject.kind, 'receipt.subject.kind');
  if (!/^linmas-review-capsule$|^codex-security-scan$/.test(value.subject.kind)) fail('receipt.subject.kind is invalid');
  digest(value.subject.sha256, 'receipt.subject.sha256');

  object(value.reviewer, 'receipt.reviewer');
  exact(value.reviewer, REVIEWER_FIELDS, 'receipt.reviewer');
  bounded(value.reviewer.label, 'receipt.reviewer.label');
  if (value.reviewer.principal !== null) bounded(value.reviewer.principal, 'receipt.reviewer.principal');

  if (typeof value.decidedAt !== 'string' || Number.isNaN(Date.parse(value.decidedAt))) fail('receipt.decidedAt is invalid');
  if (!Array.isArray(value.findings)) fail('receipt.findings must be an array');
  const ids = new Set();
  for (const [index, finding] of value.findings.entries()) {
    const field = `receipt.findings[${index}]`;
    object(finding, field);
    exact(finding, FINDING_FIELDS, field);
    bounded(finding.id, `${field}.id`);
    if (!ids.add(finding.id)) fail(`${field}.id is duplicated`);
    if (!DISPOSITIONS.includes(finding.disposition)) fail(`${field}.disposition is invalid`);
    bounded(finding.rationale, `${field}.rationale`);
  }

  object(value.summary, 'receipt.summary');
  exact(value.summary, SUMMARY_FIELDS, 'receipt.summary');
  if (!OVERALL_DISPOSITIONS.includes(value.summary.overallDisposition)) fail('receipt.summary.overallDisposition is invalid');
  if (deriveOverallDisposition(value.findings) !== value.summary.overallDisposition) fail('receipt.summary.overallDisposition is not derived from findings');
  bounded(value.summary.statement, 'receipt.summary.statement');
  if (APPROVAL_LANGUAGE.test(value.summary.statement)) fail('receipt.summary.statement contains approval language');

  exactSafety(value.safetyBoundary, 'receipt.safetyBoundary');
  return structuredClone(value);
}

function exactSafety(value, field) {
  object(value, field);
  if (JSON.stringify(value) !== JSON.stringify(CANONICAL_SAFETY_BOUNDARY)) fail(`${field} must preserve canonical human review safety boundary`);
}

function exact(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${field}.${key} is required`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
}

function bounded(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`);
  if (value.length > MAX_PROOF_TEXT) fail(`${field} exceeds ${MAX_PROOF_TEXT} characters`);
  if (value.includes('\0')) fail(`${field} contains NUL`);
}

function string(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`);
}

function digest(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${field} must be a SHA-256 digest`);
}

function fail(message) {
  throw new Error(`proof receipt: ${message}`);
}
