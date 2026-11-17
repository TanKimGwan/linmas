import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertReceiptFindingsMatchSource, validateDecisionReceipt } from './validate-receipt.mjs';
import { renderProofReports } from './render-report.mjs';
import { sha256 } from './load-evidence.mjs';
import { ProofError } from './errors.mjs';
import { derivePublicKey, signManifest } from './ssh-signature.mjs';

export async function writeProofBundle(destination, source, receipt, { fsApi = fs, now = new Date(), randomId = randomUUID, signingKey = null, signal, platform = process.platform } = {}) {
  throwIfAborted(signal);
  const validatedReceipt = validateDecisionReceipt(receipt);
  throwIfAborted(signal);
  if (!source || !Array.isArray(source.evidenceFiles) || !source.kind || !source.sourceSha256) throw inputError('proof source is invalid');
  if (validatedReceipt.subject.kind !== source.kind || validatedReceipt.subject.sha256 !== source.sourceSha256) throw inputError('receipt does not bind to proof source');
  try { assertReceiptFindingsMatchSource(source.findings, validatedReceipt.findings); }
  catch (cause) { throw inputError(`receipt finding binding is invalid: ${cause.message}`, cause); }
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
  let claim = null;
  let committed = false;
  try {
    throwIfAborted(signal);
    try { lock = await fsApi.open(lockPath, 'wx', 0o600); }
    catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      // Name only the lock file, never the absolute path from the cause.
      throw new ProofError(`proof bundle could not be written: a lock file (${path.basename(lockPath)}) already exists next to the destination; if no other proof create is running, the lock is stale and can be removed`, 'write', 2);
    }
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
    // The early lstat above is only a fast failure. On POSIX, rename() replaces
    // an existing EMPTY directory, so anything created at the destination since
    // then would be silently overwritten. Claim the destination exclusively
    // (mkdir fails if any entry exists) right before the move, so the claimed
    // empty directory is visible only for this short window, then confirm the
    // claim is still ours and let rename() atomically replace it with the
    // complete bundle. Windows rename() never replaces a directory, so it needs
    // no claim there.
    if (platform !== 'win32') {
      claim = await claimDestination(resolved, fsApi);
      throwIfAborted(signal);
      if (!await stillClaimed(resolved, claim, fsApi)) { claim = null; throw inputError('proof bundle destination already exists'); }
    }
    try { await fsApi.rename(stage, resolved); }
    catch (cause) {
      if (cause?.code === 'ENOTEMPTY' || cause?.code === 'EEXIST') throw inputError('proof bundle destination already exists', cause);
      throw cause;
    }
    committed = true;
    throwIfAborted(signal);
    return { path: resolved, manifest };
  } catch (cause) {
    if (signal?.aborted) throw cancellationError();
    if (cause instanceof ProofError) throw cause;
    throw new ProofError(`proof bundle could not be written: ${cause.message}`, 'write', 2);
  } finally {
    if (lock) {
      try { await lock.close(); } catch {}
      try { await fsApi.rm(lockPath, { force: true }); } catch {}
    }
    if (committed && signal?.aborted) {
      try { await fsApi.rm(resolved, { recursive: true, force: true }); } catch {}
    }
    if (claim && !committed) await releaseClaim(resolved, claim, fsApi, path.join(parent, `.${path.basename(resolved)}.${randomId()}.release`));
    try { await fsApi.rm(stage, { recursive: true, force: true }); } catch {}
  }
}

async function claimDestination(target, fsApi) {
  try { await fsApi.mkdir(target, { mode: 0o700 }); }
  catch (cause) {
    if (cause?.code === 'EEXIST') throw inputError('proof bundle destination already exists', cause);
    throw cause;
  }
  try {
    return identity(await fsApi.lstat(target, { bigint: true }));
  } catch (cause) {
    // The claim vanished at once; nothing of ours is left to release.
    throw inputError('proof bundle destination already exists', cause);
  }
}

// dev+ino identify the directory; ctimeNs also catches a replacement that
// reused the inode number where the filesystem has fine-grained timestamps.
function identity(stat) { return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs }; }

async function stillClaimed(target, claim, fsApi) {
  try {
    const stat = await fsApi.lstat(target, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const current = identity(stat);
    return current.dev === claim.dev && current.ino === claim.ino && current.ctimeNs === claim.ctimeNs;
  } catch { return false; }
}

// Remove only the empty directory this process created. Removing it in place
// would be check-then-act: another process could swap its own directory in
// between the identity check and rmdir. So the claim is first moved to a
// private random name in the same parent; whatever was moved is then checked
// there and removed with a non-recursive rmdir only if it is ours and still
// empty. Anything else (a directory put in our place, or our claim after
// another process wrote into it) is moved back to the destination.
// The full identity (with ctimeNs) is checked before the move; after it only
// dev+ino are compared, because rename may update the directory's ctime.
async function releaseClaim(target, claim, fsApi, privatePath) {
  try {
    if (!await stillClaimed(target, claim, fsApi)) return;
    await fsApi.rename(target, privatePath);
  } catch (cause) {
    // If the claim cannot be moved aside, fall back to the in-place check and
    // rmdir (a short check-then-act window) rather than leave the claim behind.
    if (cause?.code !== 'ENOENT') { try { if (await stillClaimed(target, claim, fsApi)) await fsApi.rmdir(target); } catch {} }
    return;
  }
  try {
    const stat = await fsApi.lstat(privatePath, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === claim.dev && stat.ino === claim.ino) {
      await fsApi.rmdir(privatePath);
      return;
    }
  } catch {}
  // Not ours, or no longer empty: put it back without replacing anything.
  await putBack(privatePath, target, fsApi);
}

// A plain rename back could replace an empty directory that a third party
// created at the destination meanwhile. A directory is therefore put back the
// same way the bundle is moved in: claim the destination with an exclusive
// mkdir, then rename onto that empty claim. A non-directory is put back with
// link() (which fails if the name exists) and then unlinked from the private
// name. If the destination is occupied, the entry stays under the private
// name: moved, never deleted.
async function putBack(privatePath, target, fsApi) {
  let stat;
  try { stat = await fsApi.lstat(privatePath); } catch { return; }
  if (!stat.isDirectory()) {
    try { await fsApi.link(privatePath, target); } catch { return; }
    try { await fsApi.unlink(privatePath); } catch {}
    return;
  }
  try { await fsApi.mkdir(target, { mode: 0o700 }); } catch { return; }
  try { await fsApi.rename(privatePath, target); }
  catch { try { await fsApi.rmdir(target); } catch {} }
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
