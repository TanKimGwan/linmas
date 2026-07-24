import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { validateReviewCapsule } from './validate-capsule.mjs';

export async function preflightCapsuleDestination(destination, { cwd = process.cwd(), fsApi = fs } = {}) {
  if (typeof destination !== 'string' || !destination.trim() || destination.includes('\0')) throw capsuleInput('capsule destination is invalid');
  const requested = path.resolve(cwd, destination);
  const requestedParent = path.dirname(requested);
  const parentStat = await safeLstat(requestedParent, fsApi, 'capsule destination parent does not exist');
  if (parentStat.isSymbolicLink()) throw capsuleInput('capsule destination parent cannot contain a symlink');
  if (!parentStat.isDirectory()) throw capsuleInput('capsule destination parent must be a directory');
  // Canonicalize inherited prefixes (e.g. macOS /var -> /private/var) so benign
  // system symlinks are accepted, then re-check and write through the canonical
  // path so the capsule lands exactly where it was inspected.
  const parent = await canonicalParent(requestedParent, fsApi);
  await assertNoSymlinkPath(parent, fsApi);
  const resolvedPath = path.join(parent, path.basename(requested));
  try {
    await fsApi.lstat(resolvedPath);
    throw capsuleInput('capsule destination already exists');
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    if (error?.code !== 'ENOENT') throw capsuleInput('capsule destination could not be inspected', error);
  }
  return Object.freeze({ path: resolvedPath, parent });
}

export async function writeReviewCapsule(target, capsule, { fsApi = fs, randomId = randomUUID, signal } = {}) {
  if (!target || typeof target.path !== 'string' || typeof target.parent !== 'string') throw capsuleInput('capsule destination preflight is required');
  throwIfAborted(signal);
  const checked = await preflightCapsuleDestination(target.path, { fsApi });
  throwIfAborted(signal);
  if (checked.parent !== target.parent) throw capsuleInput('capsule destination changed after preflight');
  throwIfAborted(signal);
  const validated = validateReviewCapsule(capsule);
  throwIfAborted(signal);
  const temporary = path.join(target.parent, `.${path.basename(target.path)}.${randomId()}.tmp`);
  let handle;
  let primary;
  let linked = false;
  try {
    handle = await fsApi.open(temporary, 'wx', 0o600);
    throwIfAborted(signal);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    throwIfAborted(signal);
    await handle.sync();
    throwIfAborted(signal);
    await handle.close();
    handle = null;
    throwIfAborted(signal);
    await fsApi.link(temporary, target.path);
    linked = true;
    throwIfAborted(signal);
    await fsApi.rm(temporary, { force: true });
    throwIfAborted(signal);
    return target.path;
  } catch (cause) {
    primary = signal?.aborted ? cancellationError() : capsuleInput('capsule could not be written', cause);
    throw primary;
  } finally {
    try { await handle?.close(); } catch (cause) { if (primary) primary.cleanupCause = cause; }
    if (linked && signal?.aborted) {
      try { await fsApi.rm(target.path, { force: true }); } catch (cause) { if (primary && !primary.cleanupCause) primary.cleanupCause = cause; }
    }
    try { await fsApi.rm(temporary, { force: true }); } catch (cause) { if (primary && !primary.cleanupCause) primary.cleanupCause = cause; }
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw cancellationError();
}

function cancellationError() {
  return Object.assign(new Error('capsule write cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

async function assertNoSymlinkPath(target, fsApi) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await safeLstat(current, fsApi, 'capsule destination parent does not exist');
    if (stat.isSymbolicLink()) throw capsuleInput('capsule destination parent cannot contain a symlink');
  }
}

async function canonicalParent(target, fsApi) {
  try { return await fsApi.realpath(target); }
  catch (cause) {
    if (cause?.code === 'ENOENT') throw capsuleInput('capsule destination parent does not exist', cause);
    throw capsuleInput('capsule destination could not be inspected', cause);
  }
}

async function safeLstat(target, fsApi, missingMessage) {
  try { return await fsApi.lstat(target); }
  catch (cause) {
    if (cause?.code === 'ENOENT') throw capsuleInput(missingMessage, cause);
    throw capsuleInput('capsule destination could not be inspected', cause);
  }
}

function capsuleInput(message, cause) {
  const error = new ReviewError(message, 'input', EXIT_CODES.INPUT);
  if (cause !== undefined) error.cause = cause;
  return error;
}
