import fs from 'node:fs/promises';
import path from 'node:path';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { validateReviewCapsule } from './validate-capsule.mjs';

const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;

export function compareReviewCapsules(beforeValue, afterValue) {
  const before = validateReviewCapsule(beforeValue);
  const after = validateReviewCapsule(afterValue);
  if (before.review.specialist !== after.review.specialist) {
    throw comparisonError(`capsule specialist mismatch: ${before.review.specialist} != ${after.review.specialist}`);
  }

  const beforeFindings = new Map(before.review.findings.map((item) => [item.id, item]));
  const afterFindings = new Map(after.review.findings.map((item) => [item.id, item]));
  const beforeIds = [...beforeFindings.keys()];
  const afterIds = [...afterFindings.keys()];
  const added = afterIds.filter((id) => !beforeFindings.has(id)).sort();
  const resolved = beforeIds.filter((id) => !afterFindings.has(id)).sort();
  const persistent = beforeIds.filter((id) => afterFindings.has(id)).sort();
  const changed = persistent.flatMap((id) => {
    const left = beforeFindings.get(id);
    const right = afterFindings.get(id);
    if (left.severity === right.severity && left.status === right.status) return [];
    return [{
      id,
      before: { severity: left.severity, status: left.status },
      after: { severity: right.severity, status: right.status }
    }];
  });
  const warnings = [];
  if (before.execution.provider !== after.execution.provider) warnings.push('Provider differs; model behavior may reduce comparability.');
  if (before.execution.model !== after.execution.model) warnings.push('Model differs; model behavior may reduce comparability.');
  if (before.execution.mode !== after.execution.mode) warnings.push('Execution mode differs; fixture and live results are not equivalent.');
  if (before.input.source !== after.input.source || before.input.sha256 !== after.input.sha256) warnings.push('Input identity differs; confirm the reviewed scopes are intentionally comparable.');

  return {
    schemaVersion: 1,
    kind: 'linmas-review-delta',
    specialist: before.review.specialist,
    findings: { added, resolved, persistent, changed },
    policyTransition: {
      before: policyDecision(before.policy),
      after: policyDecision(after.policy)
    },
    warnings,
    humanReviewRequired: true,
    disclaimer: 'The absence of a finding from the second capsule does not prove remediation. Policy results are not approvals. Human review remains required.'
  };
}

export async function loadAndCompareCapsules(beforePath, afterPath, { cwd = process.cwd(), fsApi = fs } = {}) {
  if (typeof beforePath !== 'string' || !beforePath || typeof afterPath !== 'string' || !afterPath) {
    throw comparisonError('review compare requires before and after capsule paths');
  }
  const before = await loadCapsule(beforePath, { cwd, fsApi });
  const after = await loadCapsule(afterPath, { cwd, fsApi });
  return compareReviewCapsules(before, after);
}

export function formatSecurityDelta(delta, { output = 'text' } = {}) {
  if (output === 'json') return `${JSON.stringify(delta, null, 2)}\n`;
  const lines = [
    'LINMAS REVIEW DELTA',
    `Specialist          ${delta.specialist}`,
    `Added               ${list(delta.findings.added)}`,
    `Resolved (absent)   ${list(delta.findings.resolved)}`,
    `Persistent          ${list(delta.findings.persistent)}`,
    `Changed             ${list(delta.findings.changed.map((item) => item.id))}`,
    `Policy transition   ${delta.policyTransition.before} -> ${delta.policyTransition.after}`
  ];
  for (const warning of delta.warnings) lines.push(`Warning             ${warning}`);
  lines.push('Human review remains required.', delta.disclaimer, '');
  return lines.join('\n');
}

async function loadCapsule(filePath, { cwd, fsApi }) {
  const resolved = path.resolve(cwd, filePath);
  let stat;
  try { stat = await fsApi.lstat(resolved); }
  catch (cause) { throw comparisonError(`capsule could not be read: ${filePath}`, cause); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw comparisonError(`capsule must be a regular non-symlink file: ${filePath}`);
  if (stat.size > MAX_CAPSULE_BYTES) throw comparisonError(`capsule exceeds ${MAX_CAPSULE_BYTES} bytes: ${filePath}`);
  let text;
  try { text = await fsApi.readFile(resolved, 'utf8'); }
  catch (cause) { throw comparisonError(`capsule could not be read: ${filePath}`, cause); }
  try { return JSON.parse(text); }
  catch (cause) { throw comparisonError(`capsule contains invalid JSON: ${filePath}`, cause); }
}

function policyDecision(policy) {
  return policy.status === 'evaluated' ? policy.result.decision : 'not-evaluated';
}

function list(values) {
  return values.length ? values.join(', ') : 'none';
}

function comparisonError(message, cause) {
  const error = new ReviewError(message, 'input', EXIT_CODES.INPUT);
  if (cause !== undefined) error.cause = cause;
  return error;
}
