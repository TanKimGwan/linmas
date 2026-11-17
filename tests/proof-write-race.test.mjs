import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { loadCapsuleEvidence } from '../src/proof/load-evidence.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { verifyProofBundle } from '../src/proof/verify-bundle.mjs';

// T12 / T9-11: the destination must be claimed exclusively. Something that
// appears at the destination after the early existence check must never be
// replaced, and a failed or cancelled write leaves nothing behind.

const skip = process.platform === 'win32';
const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-race-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const capsule = buildReviewCapsule({
    input: { source: 'fixture.diff', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: {
      schemaVersion: 1, caseId: 'proof/race', specialist: 'secure-code-reviewer',
      modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic evidence.'],
      findings: [{ id: 'F-1', status: 'Confirmed finding', severity: 'High', evidence: 'e', affectedSurface: 's', preconditions: 'p', remediation: 'r', verification: 'v' }],
      deterministicChecks: [], safetyBoundary
    },
    policyResult: null,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  const capsulePath = path.join(root, 'capsule.json');
  await fs.writeFile(capsulePath, `${JSON.stringify(capsule, null, 2)}\n`);
  const source = await loadCapsuleEvidence(capsulePath);
  const receipt = buildDecisionReceipt({
    subject: { kind: source.kind, sha256: source.sourceSha256 },
    reviewer: { label: 'Reviewer', principal: null },
    findings: [{ id: 'F-1', disposition: 'remediation-required', rationale: 'Reproduced.' }],
    statement: 'Reviewed by a human.',
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  return { root, source, receipt };
}

// Runs `attack` once, right after the writer takes its lock (that is, after the
// early "destination already exists" check and before the bundle is moved in).
function racingFs(lockPath, attack) {
  let fired = false;
  return {
    ...fs,
    async open(target, ...rest) {
      const handle = await fs.open(target, ...rest);
      if (!fired && target === lockPath) { fired = true; await attack(); }
      return handle;
    }
  };
}

async function leftovers(root) {
  return (await fs.readdir(root)).filter((name) => name.startsWith('.'));
}

async function snapshot(target) {
  const stat = await fs.lstat(target);
  const entries = stat.isDirectory() && !stat.isSymbolicLink() ? (await fs.readdir(target)).sort() : null;
  return { ino: stat.ino, mode: stat.mode, symlink: stat.isSymbolicLink(), entries };
}

const intruders = {
  'empty directory': (target) => fs.mkdir(target),
  'non-empty directory': async (target) => { await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'other data'); },
  file: (target) => fs.writeFile(target, 'other data'),
  'symlink to a directory': async (target) => { await fs.mkdir(`${target}-real`); await fs.symlink(`${target}-real`, target); },
  'dangling symlink': (target) => fs.symlink(`${target}-missing`, target)
};

test('T12 A a destination that appears after the existence check is never replaced', { skip }, async (t) => {
  for (const [name, create] of Object.entries(intruders)) {
    const { root, source, receipt } = await fixture(t);
    const destination = path.join(root, 'bundle');
    const fsApi = racingFs(path.join(root, '.bundle.lock'), () => create(destination));
    await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /^Error: proof bundle destination already exists$|proof bundle destination already exists/, name);
    const after = await snapshot(destination);
    assert.equal(after.entries?.includes('manifest.json') ?? false, false, `${name}: no bundle was moved in`);
    if (name === 'empty directory') assert.deepEqual(after.entries, [], name);
    if (name === 'non-empty directory') {
      assert.deepEqual(after.entries, ['keep.txt'], name);
      assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'other data');
    }
    if (name === 'file') assert.equal(await fs.readFile(destination, 'utf8'), 'other data');
    assert.deepEqual(await leftovers(root), [], `${name}: no lock or staging left`);
  }
});

test('T12 A an existing destination is rejected with the same error and left untouched', { skip }, async (t) => {
  for (const [name, create] of Object.entries(intruders)) {
    const { root, source, receipt } = await fixture(t);
    const destination = path.join(root, 'bundle');
    await create(destination);
    const before = await snapshot(destination);
    await assert.rejects(writeProofBundle(destination, source, receipt), (error) => error.message === 'proof bundle destination already exists' && error.exitCode === 2, name);
    assert.deepEqual(await snapshot(destination), before, name);
    assert.deepEqual(await leftovers(root), [], name);
  }
});

test('T12 A a directory that replaces the claimed destination is neither overwritten nor removed', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  let swapped = false;
  let foreignIno = null;
  let claimLstats = 0;
  const fsApi = {
    ...fs,
    async lstat(target, options) {
      // The second bigint lstat of the destination is the re-check after the
      // claim was recorded; replace the claim just before it.
      if (target === destination && options?.bigint && ++claimLstats === 2) {
        // Another process moves the claimed directory aside and creates its
        // own, still empty, so rename() alone would replace it.
        swapped = true;
        await fs.rename(destination, path.join(root, 'moved-aside'));
        await fs.mkdir(destination);
        foreignIno = (await fs.lstat(destination)).ino;
      }
      return fs.lstat(target, options);
    }
  };
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /proof bundle destination already exists/);
  assert.equal(swapped, true, 'the writer re-checks its claim before the move');
  assert.deepEqual(await fs.readdir(destination), []);
  assert.equal((await fs.lstat(destination)).ino, foreignIno, 'the other process directory was not removed');
  assert.deepEqual(await leftovers(root), []);
});

test('T12 A a failed move releases the claim and leaves no staging, lock, or partial bundle', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  const fsApi = { ...fs, async rename() { throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); } };
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /proof bundle could not be written: synthetic rename failure/);
  await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(root), []);
});

test('T12 A cancellation between the claim and the move leaves nothing behind', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  const controller = new AbortController();
  const fsApi = {
    ...fs,
    async mkdir(target, options) {
      const result = await fs.mkdir(target, options);
      if (target === destination) controller.abort();
      return result;
    }
  };
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(root), []);
});

test('T12 A a written bundle keeps its modes and verifies', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const result = await writeProofBundle(path.join(root, 'bundle'), source, receipt);
  assert.equal(result.path, path.join(root, 'bundle'));
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o700);
  for (const name of ['manifest.json', 'decision-receipt.json', 'report.md', 'report.html']) {
    assert.equal((await fs.stat(path.join(result.path, name))).mode & 0o777, 0o600, name);
  }
  assert.equal((await verifyProofBundle(result.path)).integrity, 'valid');
  assert.deepEqual(await leftovers(root), []);
});

test('T12 A releasing the claim never removes data another process wrote into it', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  const fsApi = {
    ...fs,
    async rename() {
      await fs.writeFile(path.join(destination, 'theirs.txt'), 'other data');
      throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
    }
  };
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /could not be written/);
  assert.deepEqual(await fs.readdir(destination), ['theirs.txt']);
  assert.equal(await fs.readFile(path.join(destination, 'theirs.txt'), 'utf8'), 'other data');
  assert.deepEqual(await leftovers(root), []);
});

function failingMoveFs(destination, extra = {}) {
  return {
    ...fs,
    async rename(from, to) {
      if (to === destination && from.endsWith('.staging')) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
      return (extra.rename ?? fs.rename)(from, to);
    },
    ...(extra.rmdir ? { rmdir: extra.rmdir } : {})
  };
}

test('T12 round 2 A-1 releasing the claim never removes a directory swapped in at the destination', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  let foreignIno = null;
  const fsApi = failingMoveFs(destination, {
    async rmdir(target) {
      if (target === destination && foreignIno === null) {
        // Another process swaps its own empty directory in just before the removal.
        await fs.rename(destination, path.join(root, 'moved-aside'));
        await fs.mkdir(destination);
        foreignIno = (await fs.lstat(destination)).ino;
      }
      return fs.rmdir(target);
    }
  });
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /could not be written/);
  if (foreignIno !== null) assert.equal((await fs.lstat(destination)).ino, foreignIno, 'the swapped-in directory was removed');
  else await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(root), []);
});

test('T12 round 2 A-1 a claim swapped out before it is moved aside is put back, not removed', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  let foreignIno = null;
  const fsApi = failingMoveFs(destination, {
    async rename(from, to) {
      if (from === destination && foreignIno === null) {
        await fs.rename(destination, path.join(root, 'moved-aside'));
        await fs.mkdir(destination);
        foreignIno = (await fs.lstat(destination)).ino;
      }
      return fs.rename(from, to);
    }
  });
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /could not be written/);
  assert.notEqual(foreignIno, null, 'the claim is moved aside before it is removed');
  assert.equal((await fs.lstat(destination)).ino, foreignIno);
  assert.deepEqual(await fs.readdir(destination), []);
  assert.deepEqual(await leftovers(root), []);
});

test('T12 round 2 A-1 a claim that gains content after it is moved aside is put back with that content', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  let wrote = false;
  const fsApi = failingMoveFs(destination, {
    async rmdir(target) {
      if (!wrote && path.dirname(target) === root && path.basename(target).startsWith('.bundle.')) {
        wrote = true;
        await fs.writeFile(path.join(target, 'theirs.txt'), 'other data');
      }
      return fs.rmdir(target);
    }
  });
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /could not be written/);
  assert.equal(wrote, true, 'the claim is removed under a private name');
  assert.deepEqual(await fs.readdir(destination), ['theirs.txt']);
  assert.deepEqual(await leftovers(root), []);
});

test('T12 round 2 A-1 when the claim cannot be moved aside, data written into it is still kept', { skip }, async (t) => {
  const { root, source, receipt } = await fixture(t);
  const destination = path.join(root, 'bundle');
  const fsApi = {
    ...fs,
    async rename(from) {
      if (from.endsWith('.staging')) await fs.writeFile(path.join(destination, 'theirs.txt'), 'other data');
      throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
    }
  };
  await assert.rejects(writeProofBundle(destination, source, receipt, { fsApi }), /could not be written/);
  assert.deepEqual(await fs.readdir(destination), ['theirs.txt']);
  assert.deepEqual(await leftovers(root), []);
});
