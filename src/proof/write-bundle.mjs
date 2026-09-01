import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateDecisionReceipt } from './validate-receipt.mjs';
import { renderProofReports } from './render-report.mjs';
import { sha256 } from './load-evidence.mjs';
import { ProofError } from './errors.mjs';
import { derivePublicKey, signManifest } from './ssh-signature.mjs';

export async function writeProofBundle(destination, source, receipt, { fsApi = fs, now = new Date(), randomId = randomUUID, signingKey = null, signal } = {}) {
  throwIfAborted(signal);
  const validatedReceipt = validateDecisionReceipt(receipt);
  throwIfAborted(signal);
  if (!source || !Array.isArray(source.evidenceFiles) || !source.kind || !source.sourceSha256) throw inputError('proof source is invalid');
  if (validatedReceipt.subject.kind !== source.kind || validatedReceipt.subject.sha256 !== source.sourceSha256) throw inputError('receipt does not bind to proof source');
  const requested = path.resolve(destination);
  const requestedParent = path.dirname(requested);
  const parentStat = await safeLstat(requestedParent, fsApi);
  if (parentStat.isSymbolicLink()) throw inputError('proof bundle parent cannot contain a symlink');
  if (!parentStat.isDirectory()) throw inputError('proof bundle parent must be a directory');
  // Canonicalize inherited prefixes (e.g. macOS /var -> /private/var) so benign
  // system symlinks are accepted, then re-check and write through the canonical
  // path so the bundle lands exactly where it was inspected.
  const parent = await canonicalParent(requestedParent, fsApi);
  await assertNoSymlinkPath(parent, fsApi);
  const resolved = path.join(parent, path.basename(requested));
  try { await fsApi.lstat(resolved); throw inputError('proof bundle destination already exists'); } catch (error) { if (error instanceof ProofError) throw error; if (error?.code !== 'ENOENT') throw inputError('proof bundle destination could not be inspected', error); }

  const lockPath = path.join(parent, `.${path.basename(resolved)}.lock`);
  const stage = path.join(parent, `.${path.basename(resolved)}.${randomId()}.staging`);
  let lock;
  let committed = false;
  try {
    throwIfAborted(signal);
    lock = await fsApi.open(lockPath, 'wx', 0o600);
    throwIfAborted(signal);
    await fsApi.mkdir(stage, { mode: 0o700 });
    throwIfAborted(signal);
    const artifactEntries = [];
    for (const file of source.evidenceFiles) {
      throwIfAborted(signal);
      const entry = await writeArtifact(stage, file.relativePath, file.bytes, fsApi, signal);
      artifactEntries.push({ ...entry, role: 'source-evidence' });
    }
    throwIfAborted(signal);
    const receiptEntry = await writeArtifact(stage, 'decision-receipt.json', Buffer.from(`${JSON.stringify(validatedReceipt, null, 2)}\n`), fsApi, signal);
    artifactEntries.push({ ...receiptEntry, role: 'human-decision-receipt' });
    const reports = renderProofReports({ source, receipt: validatedReceipt });
    const markdownEntry = await writeArtifact(stage, 'report.md', Buffer.from(reports.markdown), fsApi, signal);
    const htmlEntry = await writeArtifact(stage, 'report.html', Buffer.from(reports.html), fsApi, signal);
    artifactEntries.push({ ...markdownEntry, role: 'report-markdown' }, { ...htmlEntry, role: 'report-html' });
    if (signingKey && !validatedReceipt.reviewer.principal) throw inputError('SSH signing requires a signer principal');
    if (signingKey) {
      const publicKey = await derivePublicKey(path.resolve(signingKey), { fsApi });
      throwIfAborted(signal);
      const publicEntry = await writeArtifact(stage, 'signature/signer.pub', publicKey, fsApi, signal);
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
    await writeJson(stage, 'manifest.json', manifest, fsApi, signal);
    if (signingKey) {
      throwIfAborted(signal);
      const signedManifest = await signManifest(path.join(stage, 'manifest.json'), path.resolve(signingKey), { fsApi });
      throwIfAborted(signal);
      await fsApi.writeFile(path.join(stage, 'signature/manifest.sig'), signedManifest.signature, { flag: 'wx', mode: 0o600 });
      throwIfAborted(signal);
      await fsApi.rm(signedManifest.signaturePath, { force: true });
      throwIfAborted(signal);
    }
    throwIfAborted(signal);
    await fsApi.rename(stage, resolved);
    committed = true;
    throwIfAborted(signal);
    return { path: resolved, manifest };
  } catch (cause) {
    if (signal?.aborted) throw cancellationError();
    if (cause instanceof ProofError) throw cause;
    throw new ProofError(`proof bundle could not be written: ${cause.message}`, 'write', 2);
  } finally {
    try { await lock?.close(); } catch {}
    try { await fsApi.rm(lockPath, { force: true }); } catch {}
    if (committed && signal?.aborted) {
      try { await fsApi.rm(resolved, { recursive: true, force: true }); } catch {}
    }
    try { await fsApi.rm(stage, { recursive: true, force: true }); } catch {}
  }
}

async function writeArtifact(root, relativePath, bytes, fsApi, signal) {
  throwIfAborted(signal);
  if (!safeRelativePath(relativePath)) throw inputError('proof artifact path is unsafe');
  const target = path.join(root, ...relativePath.split('/'));
  await fsApi.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  throwIfAborted(signal);
  await fsApi.writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  throwIfAborted(signal);
  return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes), mediaType: mediaType(relativePath) };
}

async function writeJson(root, relativePath, value, fsApi, signal) {
  throwIfAborted(signal);
  await fsApi.writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  throwIfAborted(signal);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw cancellationError();
}

function cancellationError() {
  return Object.assign(new Error('proof bundle write cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
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

async function canonicalParent(target, fsApi) {
  try { return await fsApi.realpath(target); }
  catch (cause) {
    if (cause?.code === 'ENOENT') throw cause;
    throw inputError('proof bundle path could not be inspected', cause);
  }
}

async function safeLstat(target, fsApi) { try { return await fsApi.lstat(target); } catch (cause) { if (cause?.code === 'ENOENT') throw cause; throw inputError('proof bundle path could not be inspected', cause); } }
function inputError(message, cause) { const error = new ProofError(message, 'input', 2); if (cause) error.cause = cause; return error; }
