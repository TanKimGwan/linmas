import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { validateReviewCapsule } from './validate-capsule.mjs';

export async function preflightCapsuleDestination(destination, { cwd = process.cwd(), fsApi = fs } = {}) {
  if (typeof destination !== 'string' || !destination.trim() || destination.includes('\0')) throw capsuleInput('capsule destination is invalid');
  const resolvedPath = path.resolve(cwd, destination);
  const parent = path.dirname(resolvedPath);
  await assertNoSymlinkPath(parent, fsApi);
  const parentStat = await safeLstat(parent, fsApi, 'capsule destination parent does not exist');
  if (!parentStat.isDirectory()) throw capsuleInput('capsule destination parent must be a directory');
  try {
    await fsApi.lstat(resolvedPath);
    throw capsuleInput('capsule destination already exists');
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    if (error?.code !== 'ENOENT') throw capsuleInput('capsule destination could not be inspected', error);
  }
  return Object.freeze({ path: resolvedPath, parent });
}

export async function writeReviewCapsule(target, capsule, { fsApi = fs, randomId = randomUUID } = {}) {
  if (!target || typeof target.path !== 'string' || typeof target.parent !== 'string') throw capsuleInput('capsule destination preflight is required');
  const checked = await preflightCapsuleDestination(target.path, { fsApi });
  if (checked.parent !== target.parent) throw capsuleInput('capsule destination changed after preflight');
  const validated = validateReviewCapsule(capsule);
  const temporary = path.join(target.parent, `.${path.basename(target.path)}.${randomId()}.tmp`);
  let handle;
  let primary;
  try {
    handle = await fsApi.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsApi.link(temporary, target.path);
    await fsApi.rm(temporary, { force: true });
    return target.path;
  } catch (cause) {
    primary = capsuleInput('capsule could not be written', cause);
    throw primary;
  } finally {
    try { await handle?.close(); } catch (cause) { if (primary) primary.cleanupCause = cause; }
    try { await fsApi.rm(temporary, { force: true }); } catch (cause) { if (primary && !primary.cleanupCause) primary.cleanupCause = cause; }
  }
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
