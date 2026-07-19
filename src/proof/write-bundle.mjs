import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateDecisionReceipt } from './validate-receipt.mjs';
import { renderProofReports } from './render-report.mjs';
import { sha256 } from './load-evidence.mjs';
import { ProofError } from './errors.mjs';
import { derivePublicKey, signManifest } from './ssh-signature.mjs';

export async function writeProofBundle(destination, source, receipt, { fsApi = fs, now = new Date(), randomId = randomUUID, signingKey = null } = {}) {
  const validatedReceipt = validateDecisionReceipt(receipt);
  if (!source || !Array.isArray(source.evidenceFiles) || !source.kind || !source.sourceSha256) throw inputError('proof source is invalid');
  if (validatedReceipt.subject.kind !== source.kind || validatedReceipt.subject.sha256 !== source.sourceSha256) throw inputError('receipt does not bind to proof source');
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  await assertNoSymlinkPath(parent, fsApi);
  const parentStat = await safeLstat(parent, fsApi);
  if (!parentStat.isDirectory()) throw inputError('proof bundle parent must be a directory');
  try { await fsApi.lstat(resolved); throw inputError('proof bundle destination already exists'); } catch (error) { if (error instanceof ProofError) throw error; if (error?.code !== 'ENOENT') throw inputError('proof bundle destination could not be inspected', error); }

  const lockPath = path.join(parent, `.${path.basename(resolved)}.lock`);
  const stage = path.join(parent, `.${path.basename(resolved)}.${randomId()}.staging`);
  let lock;
  try {
    lock = await fsApi.open(lockPath, 'wx', 0o600);
    await fsApi.mkdir(stage, { mode: 0o700 });
    const artifactEntries = [];
    for (const file of source.evidenceFiles) {
      const entry = await writeArtifact(stage, file.relativePath, file.bytes, fsApi);
      artifactEntries.push({ ...entry, role: 'source-evidence' });
    }
    const receiptEntry = await writeArtifact(stage, 'decision-receipt.json', Buffer.from(`${JSON.stringify(validatedReceipt, null, 2)}\n`), fsApi);
    artifactEntries.push({ ...receiptEntry, role: 'human-decision-receipt' });
    const reports = renderProofReports({ source, receipt: validatedReceipt });
    const markdownEntry = await writeArtifact(stage, 'report.md', Buffer.from(reports.markdown), fsApi);
    const htmlEntry = await writeArtifact(stage, 'report.html', Buffer.from(reports.html), fsApi);
    artifactEntries.push({ ...markdownEntry, role: 'report-markdown' }, { ...htmlEntry, role: 'report-html' });
    if (signingKey && !validatedReceipt.reviewer.principal) throw inputError('SSH signing requires a signer principal');
    if (signingKey) {
      const publicKey = await derivePublicKey(path.resolve(signingKey), { fsApi });
      const publicEntry = await writeArtifact(stage, 'signature/signer.pub', publicKey, fsApi);
      artifactEntries.push({ ...publicEntry, role: 'ssh-public-key' });
    }
    const manifest = {
      schemaVersion: 1,
      kind: 'linmas-proof-manifest',
      createdAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
      source: { kind: source.kind, sha256: source.sourceSha256 },
      receipt: { path: 'decision-receipt.json', sha256: receiptEntry.sha256 },
      reports: [{ path: 'report.md', sha256: markdownEntry.sha256 }, { path: 'report.html', sha256: htmlEntry.sha256 }],
      artifacts: artifactEntries,
      signature: signingKey ? { format: 'ssh-sig', namespace: 'linmas-proof-v1', path: 'signature/manifest.sig', publicKeyPath: 'signature/signer.pub', principal: validatedReceipt.reviewer.principal } : null,
      safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' }
    };
    await writeJson(stage, 'manifest.json', manifest, fsApi);
    if (signingKey) {
      const signedManifest = await signManifest(path.join(stage, 'manifest.json'), path.resolve(signingKey), { fsApi });
      await fsApi.writeFile(path.join(stage, 'signature/manifest.sig'), signedManifest.signature, { flag: 'wx', mode: 0o600 });
      await fsApi.rm(signedManifest.signaturePath, { force: true });
    }
    await fsApi.rename(stage, resolved);
    return { path: resolved, manifest };
  } catch (cause) {
    if (cause instanceof ProofError) throw cause;
    throw new ProofError(`proof bundle could not be written: ${cause.message}`, 'write', 2);
  } finally {
    try { await lock?.close(); } catch {}
    try { await fsApi.rm(lockPath, { force: true }); } catch {}
    try { await fsApi.rm(stage, { recursive: true, force: true }); } catch {}
  }
}

async function writeArtifact(root, relativePath, bytes, fsApi) {
  if (!safeRelativePath(relativePath)) throw inputError('proof artifact path is unsafe');
  const target = path.join(root, ...relativePath.split('/'));
  await fsApi.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsApi.writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes), mediaType: mediaType(relativePath) };
}

async function writeJson(root, relativePath, value, fsApi) {
  await fsApi.writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function safeRelativePath(value) { return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'); }
function mediaType(value) { if (value.endsWith('.json')) return 'application/json'; if (value.endsWith('.html')) return 'text/html'; return 'text/markdown'; }

async function assertNoSymlinkPath(target, fsApi) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await safeLstat(current, fsApi);
    if (stat.isSymbolicLink()) throw inputError('proof bundle parent cannot contain a symlink');
  }
}

async function safeLstat(target, fsApi) { try { return await fsApi.lstat(target); } catch (cause) { if (cause?.code === 'ENOENT') throw cause; throw inputError('proof bundle path could not be inspected', cause); } }
function inputError(message, cause) { const error = new ProofError(message, 'input', 2); if (cause) error.cause = cause; return error; }
