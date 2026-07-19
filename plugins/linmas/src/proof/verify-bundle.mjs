import fs from 'node:fs/promises';
import path from 'node:path';
import { validateDecisionReceipt } from './validate-receipt.mjs';
import { loadCapsuleEvidence, sha256 } from './load-evidence.mjs';
import { loadCodexSecurityEvidence } from './load-codex-scan.mjs';
import { ProofError } from './errors.mjs';
import { verifyManifestSignature } from './ssh-signature.mjs';

export async function verifyProofBundle(bundlePath, { fsApi = fs, allowedSignersPath = null } = {}) {
  const root = path.resolve(bundlePath);
  const rootStat = await safeLstat(root, fsApi);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw contractError('proof bundle must be a regular directory');
  const manifestBytes = await readRegular(root, 'manifest.json', fsApi);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (cause) { throw contractError('manifest contains invalid JSON', cause); }
  validateManifest(manifest);
  const artifactMap = new Map();
  for (const artifact of manifest.artifacts) {
    if (artifactMap.has(artifact.path)) throw contractError(`duplicate manifest artifact: ${artifact.path}`);
    const bytes = await readRegular(root, artifact.path, fsApi);
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw contractError(`artifact integrity mismatch: ${artifact.path}`);
    artifactMap.set(artifact.path, bytes);
  }
  for (const report of manifest.reports) {
    const artifact = manifest.artifacts.find((entry) => entry.path === report.path);
    if (!artifact || artifact.sha256 !== report.sha256 || sha256(artifactMap.get(report.path)) !== report.sha256) throw contractError(`report binding is invalid: ${report.path}`);
  }
  const receiptBytes = artifactMap.get(manifest.receipt.path);
  if (!receiptBytes || sha256(receiptBytes) !== manifest.receipt.sha256) throw contractError('receipt binding is invalid');
  let receipt;
  try { receipt = validateDecisionReceipt(JSON.parse(receiptBytes.toString('utf8'))); } catch (cause) { throw contractError(`receipt is invalid: ${cause.message}`, cause); }
  if (receipt.subject.kind !== manifest.source.kind || receipt.subject.sha256 !== manifest.source.sha256) throw contractError('receipt source binding is invalid');
  const evidencePath = manifest.source.kind === 'linmas-review-capsule' ? 'evidence/review-capsule.json' : null;
  if (evidencePath) {
    const evidence = artifactMap.get(evidencePath);
    if (!evidence || sha256(evidence) !== manifest.source.sha256) throw contractError('source evidence binding is invalid');
    const tempPath = path.join(root, evidencePath);
    await loadCapsuleEvidence(tempPath, { fsApi });
  } else if (manifest.source.kind === 'codex-security-scan') {
    const evidenceRoot = path.join(root, 'evidence', 'codex-security');
    const loaded = await loadCodexSecurityEvidence(evidenceRoot, { fsApi });
    if (loaded.sourceSha256 !== manifest.source.sha256) throw contractError('Codex source evidence binding is invalid');
  }
  let signature = 'unsigned';
  let identity = 'self-asserted';
  if (manifest.signature) {
    const signaturePath = path.join(root, manifest.signature.path);
    const publicKeyPath = path.join(root, manifest.signature.publicKeyPath);
    const signatureStat = await safeLstat(signaturePath, fsApi);
    if (signatureStat.isSymbolicLink() || !signatureStat.isFile()) throw contractError('manifest signature is not a regular file');
    const result = await verifyManifestSignature({ manifestPath: path.join(root, 'manifest.json'), signaturePath, publicKeyPath, allowedSignersPath, principal: manifest.signature.principal }, { fsApi });
    signature = result.signature;
    identity = result.identity;
  }
  return { integrity: 'valid', signature, identity, source: manifest.source, receipt, manifestSha256: sha256(manifestBytes) };
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('manifest must be an object');
  if (value.schemaVersion !== 1 || value.kind !== 'linmas-proof-manifest') throw contractError('manifest schema is unsupported');
  for (const field of ['createdAt', 'source', 'receipt', 'reports', 'artifacts', 'signature', 'safetyBoundary']) if (!Object.hasOwn(value, field)) throw contractError(`manifest.${field} is required`);
  if (!value.source || !/^linmas-review-capsule$|^codex-security-scan$/.test(value.source.kind) || !/^[a-f0-9]{64}$/.test(value.source.sha256)) throw contractError('manifest.source is invalid');
  if (!value.receipt || value.receipt.path !== 'decision-receipt.json' || !/^[a-f0-9]{64}$/.test(value.receipt.sha256)) throw contractError('manifest.receipt is invalid');
  if (!Array.isArray(value.reports) || value.reports.length !== 2) throw contractError('manifest.reports is invalid');
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 3) throw contractError('manifest.artifacts is invalid');
  if (value.signature !== null) {
    if (!value.signature || value.signature.format !== 'ssh-sig' || value.signature.namespace !== 'linmas-proof-v1' || value.signature.path !== 'signature/manifest.sig' || value.signature.publicKeyPath !== 'signature/signer.pub' || typeof value.signature.principal !== 'string' || !value.signature.principal.trim()) throw contractError('manifest signature descriptor is invalid');
  }
  if (value.reports[0]?.path !== 'report.md' || value.reports[1]?.path !== 'report.html') throw contractError('manifest report paths are invalid');
  const safety = value.safetyBoundary;
  if (JSON.stringify(safety) !== JSON.stringify({ satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' })) throw contractError('manifest safety boundary is invalid');
}

async function readRegular(root, relativePath, fsApi) {
  if (typeof relativePath !== 'string' || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.split('/').includes('..')) throw contractError('manifest path is unsafe');
  const target = path.join(root, ...relativePath.split('/'));
  await assertNoSymlinkComponents(root, relativePath, fsApi);
  const stat = await safeLstat(target, fsApi);
  if (stat.isSymbolicLink() || !stat.isFile()) throw contractError(`artifact is not a regular file: ${relativePath}`);
  try { return await fsApi.readFile(target); } catch (cause) { throw contractError(`artifact could not be read: ${relativePath}`, cause); }
}

async function assertNoSymlinkComponents(root, relativePath, fsApi) {
  let current = root;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await safeLstat(current, fsApi);
    if (stat.isSymbolicLink()) throw contractError(`manifest path contains a symlink: ${relativePath}`);
  }
}

async function safeLstat(target, fsApi) { try { return await fsApi.lstat(target); } catch (cause) { throw contractError('proof bundle artifact is missing', cause); } }
function contractError(message, cause) { const error = new ProofError(message, 'contract', 4); if (cause) error.cause = cause; return error; }
