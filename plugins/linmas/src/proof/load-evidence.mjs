import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateReviewCapsule } from '../review/validate-capsule.mjs';
import { MAX_CAPSULE_SOURCE_BYTES } from './constants.mjs';
import { ProofError } from './errors.mjs';
import { loadCodexSecurityEvidence } from './load-codex-scan.mjs';

export async function loadCapsuleEvidence(sourcePath, { fsApi = fs } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath.includes('\0')) throw inputError('capsule source path is invalid');
  const resolved = path.resolve(sourcePath);
  const stat = await lstatRegular(resolved, fsApi, 'capsule source');
  if (stat.size > MAX_CAPSULE_SOURCE_BYTES) throw inputError(`capsule source exceeds ${MAX_CAPSULE_SOURCE_BYTES} bytes`);
  const bytes = await fsApi.readFile(resolved);
  let capsule;
  try { capsule = JSON.parse(bytes.toString('utf8')); } catch (cause) { throw inputError('capsule source contains invalid JSON', cause); }
  try { capsule = validateReviewCapsule(capsule); } catch (cause) { throw contractError(`capsule source is invalid: ${cause.message}`, cause); }
  const sourceSha256 = sha256(bytes);
  return {
    kind: 'linmas-review-capsule',
    sourcePath: resolved,
    sourceSha256,
    findings: capsule.review.findings.map((finding) => ({
      id: finding.id,
      title: finding.evidence,
      severity: finding.severity,
      status: finding.status,
      evidence: finding.evidence,
      remediation: finding.remediation,
      verification: finding.verification
    })),
    capsule,
    evidenceFiles: [{ relativePath: 'evidence/review-capsule.json', bytes }]
  };
}

export async function loadProofEvidence(sourcePath, { fsApi = fs } = {}) {
  const resolved = path.resolve(sourcePath);
  const stat = await fsApi.lstat(resolved).catch((cause) => { throw inputError('proof source could not be inspected', cause); });
  if (stat.isDirectory()) return loadCodexSecurityEvidence(resolved, { fsApi });
  return loadCapsuleEvidence(resolved, { fsApi });
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function lstatRegular(target, fsApi, label) {
  let stat;
  try { stat = await fsApi.lstat(target); } catch (cause) { throw inputError(`${label} could not be read`, cause); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw inputError(`${label} must be a regular non-symlink file`);
  return stat;
}

function inputError(message, cause) {
  const error = new ProofError(message, 'input', 2);
  if (cause) error.cause = cause;
  return error;
}

function contractError(message, cause) {
  const error = new ProofError(message, 'contract', 4);
  if (cause) error.cause = cause;
  return error;
}
