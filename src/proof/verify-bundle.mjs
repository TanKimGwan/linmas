import fs from 'node:fs/promises';
import path from 'node:path';
import { assertReceiptFindingsMatchSource, validateDecisionReceipt } from './validate-receipt.mjs';
import { loadCapsuleEvidence, sha256 } from './load-evidence.mjs';
import { loadCodexSecurityEvidence } from './load-codex-scan.mjs';
import { ProofError } from './errors.mjs';
import { verifyManifestSignature } from './ssh-signature.mjs';

const MANIFEST_SIGNATURE_PATH = 'signature/manifest.sig';
const SIGNER_PUBLIC_KEY_PATH = 'signature/signer.pub';
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_BUNDLE_ENTRIES = 4096;
const MAX_BUNDLE_DEPTH = 16;

export async function verifyProofBundle(bundlePath, { fsApi = fs, allowedSignersPath = null } = {}) {
  const root = path.resolve(bundlePath);
  const rootStat = await safeLstat(root, fsApi);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw contractError('proof bundle must be a regular directory');
  const manifestBytes = await readRegular(root, 'manifest.json', fsApi);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (cause) { throw contractError('manifest contains invalid JSON', cause); }
  validateManifest(manifest);
  // A signature must cover the public key it is verified with, so the key is a
  // listed (hash-bound) artifact. Bundles written by proof create list it.
  if (manifest.signature && !manifest.artifacts.some((artifact) => artifact?.path === SIGNER_PUBLIC_KEY_PATH && artifact.role === 'ssh-public-key')) {
    throw contractError('manifest signature public key must be a listed ssh-public-key artifact');
  }
  if (allowedSignersPath && !manifest.signature) throw signatureError('proof bundle is not signed; allowed signers require a valid signature');
  const artifactMap = new Map();
  for (const artifact of manifest.artifacts) {
    if (artifactMap.has(artifact.path)) throw contractError(`duplicate manifest artifact: ${artifact.path}`);
    const bytes = await readRegular(root, artifact.path, fsApi, { expectedBytes: artifact.bytes });
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw contractError(`artifact integrity mismatch: ${artifact.path}`);
    artifactMap.set(artifact.path, bytes);
  }
  await assertOnlyListedEntries(root, manifest, fsApi);
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
  let source;
  if (evidencePath) {
    const evidence = artifactMap.get(evidencePath);
    if (!evidence || sha256(evidence) !== manifest.source.sha256) throw contractError('source evidence binding is invalid');
    const tempPath = path.join(root, evidencePath);
    source = await loadCapsuleEvidence(tempPath, { fsApi });
  } else if (manifest.source.kind === 'codex-security-scan') {
    const evidenceRoot = path.join(root, 'evidence', 'codex-security');
    source = await loadCodexSecurityEvidence(evidenceRoot, { fsApi });
    if (source.sourceSha256 !== manifest.source.sha256) throw contractError('Codex source evidence binding is invalid');
  }
  try { assertReceiptFindingsMatchSource(source.findings, receipt.findings); }
  catch (cause) { throw contractError(`receipt finding binding is invalid: ${cause.message}`, cause); }
  let signature = 'unsigned';
  let identity = 'self-asserted';
  let principal = null;
  if (manifest.signature) {
    if (manifest.signature.principal !== receipt.reviewer.principal) throw signatureError('signature principal does not match the receipt reviewer principal');
    const signatureBytes = await readRegular(root, MANIFEST_SIGNATURE_PATH, fsApi, { maxBytes: MAX_SIGNATURE_BYTES, label: 'manifest signature' });
    const publicKey = artifactMap.get(SIGNER_PUBLIC_KEY_PATH);
    if (publicKey.byteLength > MAX_PUBLIC_KEY_BYTES) throw contractError('signature public key exceeds the size limit');
    // Verify the exact bytes already read and hash-checked, never a path that
    // could change between the check and ssh-keygen opening it.
    const result = await verifyManifestSignature({ manifestBytes, signatureBytes, publicKey, allowedSignersPath, principal: manifest.signature.principal }, { fsApi });
    signature = result.signature;
    identity = result.identity;
    principal = manifest.signature.principal;
  }
  return { integrity: 'valid', signature, identity, principal, source: manifest.source, receipt, manifestSha256: sha256(manifestBytes) };
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

async function readRegular(root, relativePath, fsApi, { expectedBytes = null, maxBytes = null, label = 'artifact' } = {}) {
  if (typeof relativePath !== 'string' || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.split('/').includes('..')) throw contractError('manifest path is unsafe');
  const target = path.join(root, ...relativePath.split('/'));
  await assertNoSymlinkComponents(root, relativePath, fsApi);
  const stat = await safeLstat(target, fsApi);
  // lstat first: a FIFO, device, or symlink is rejected before any read can block.
  if (stat.isSymbolicLink() || !stat.isFile()) throw contractError(`${label} is not a regular file: ${relativePath}`);
  if (expectedBytes !== null && stat.size !== expectedBytes) throw contractError(`artifact integrity mismatch: ${relativePath}`);
  if (maxBytes !== null && stat.size > maxBytes) throw contractError(`${label} exceeds the size limit: ${relativePath}`);
  try { return await fsApi.readFile(target); } catch (cause) { throw contractError(`${label} could not be read: ${relativePath}`, cause); }
}

// Every entry in the bundle must be listed in the manifest. Only manifest.json
// and, for a signed bundle, signature/manifest.sig are outside the artifact
// list by design (they cannot hash-bind themselves).
async function assertOnlyListedEntries(root, manifest, fsApi) {
  const files = new Set(['manifest.json']);
  if (manifest.signature) files.add(MANIFEST_SIGNATURE_PATH);
  for (const artifact of manifest.artifacts) if (typeof artifact?.path === 'string') files.add(artifact.path);
  const directories = new Set();
  for (const file of files) {
    const segments = file.split('/');
    for (let index = 1; index < segments.length; index += 1) directories.add(segments.slice(0, index).join('/'));
  }
  let entries = 0;
  const walk = async (relative, depth) => {
    if (depth > MAX_BUNDLE_DEPTH) throw contractError('proof bundle is nested too deeply');
    let names;
    try { names = await fsApi.readdir(relative ? path.join(root, ...relative.split('/')) : root); }
    catch (cause) { throw contractError('proof bundle could not be listed', cause); }
    for (const name of names) {
      entries += 1;
      if (entries > MAX_BUNDLE_ENTRIES) throw contractError('proof bundle contains too many entries');
      const child = relative ? `${relative}/${name}` : name;
      if (files.has(child)) continue;
      if (!directories.has(child)) throw contractError('proof bundle contains an entry not listed in the manifest');
      const stat = await safeLstat(path.join(root, ...child.split('/')), fsApi);
      if (stat.isSymbolicLink()) throw contractError('manifest path contains a symlink');
      if (!stat.isDirectory()) throw contractError('proof bundle contains an entry not listed in the manifest');
      await walk(child, depth + 1);
    }
  };
  await walk('', 0);
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
function signatureError(message, cause) { const error = new ProofError(message, 'signature', 4); if (cause) error.cause = cause; return error; }
function contractError(message, cause) { const error = new ProofError(message, 'contract', 4); if (cause) error.cause = cause; return error; }
