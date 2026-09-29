import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pythonPhasePublication, readPhase, waitForPhase } from './helpers/irsa003-phase.mjs';
import { pythonPath } from './helpers/irsa003-fixture.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-phase-case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'phase.json'), expected: { phase: 'archive', requestId: 'current-request', pidCount: 0 } };
}
const alive = { exitCode: null, signalCode: null };
const document = expected => ({ schemaVersion: 1, phase: expected.phase, requestId: expected.requestId, pids: [] });

test('atomic phase publication keeps a deterministically paused partial write invisible to the reader', { timeout: 15000 }, async t => {
  const f = fixture(t);
  // Pause the actual publisher inside json.dump, before flush/fsync/close/rename.
  // Pipes coordinate each step; no timing race or long sleep proves this test.
  const publisher = pythonPhasePublication(f.file, f.expected.phase, f.expected.requestId);
  const script = `import json,os,sys
real_fsync,real_replace=os.fsync,os.replace
synced=False
def split_dump(value,output):
 encoded=json.dumps(value)
 output.write(encoded[:1]);output.flush()
 print('partial',flush=True)
 assert sys.stdin.readline().strip()=='continue'
 output.write(encoded[1:])
def fsync(fd):
 global synced
 real_fsync(fd);synced=True
def replace(source,destination):
 assert synced and _phase_out.closed
 real_replace(source,destination)
json.dump=split_dump;os.fsync=fsync;os.replace=replace
${publisher}
print('published',flush=True)
assert sys.stdin.readline().strip()=='exit'
`;
  const child = spawn(pythonPath, ['-B', '-I', '-E', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const completed = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'partial');
  const pendingFiles = fs.readdirSync(f.root);
  assert.equal(pendingFiles.length, 1);
  assert(pendingFiles[0].startsWith('.phase-'));
  assert.equal(fs.readFileSync(path.join(f.root, pendingFiles[0]), 'utf8'), '{');
  assert.equal(readPhase(f.file, f.expected), null);
  let release, observed;
  const hold = new Promise(resolve => { release = resolve; });
  const firstPoll = new Promise(resolve => { observed = resolve; });
  let resolved = false;
  const waiting = waitForPhase(f.file, child, f.expected, { pause: () => { observed(); return hold; } });
  waiting.then(() => { resolved = true; });
  await firstPoll;
  assert.equal(resolved, false);
  child.stdin.write('continue\n');
  assert.equal((await lines.next()).value, 'published');
  release();
  assert.deepEqual(await waiting, document(f.expected));
  child.stdin.end('exit\n');
  assert.equal((await completed)[0], 0, stderr);
  assert.deepEqual(fs.readdirSync(f.root), ['phase.json']);
});

test('phase reader rejects partial, malformed and invalid notification schemas', t => {
  const f = fixture(t);
  for (const value of ['', '{', 'null', '[]', JSON.stringify({ ...document(f.expected), extra: true }),
    JSON.stringify({ ...document(f.expected), schemaVersion: 2 }),
    JSON.stringify({ ...document(f.expected), pids: [0] })]) {
    fs.writeFileSync(f.file, value);
    assert.throws(() => readPhase(f.file, f.expected), /phase notification/);
  }
});

test('phase reader rejects stale requests and wrong phases', t => {
  const f = fixture(t);
  for (const changed of [{ requestId: 'previous-request' }, { phase: 'verifier' }]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...document(f.expected), ...changed }));
    assert.throws(() => readPhase(f.file, f.expected), /phase notification/);
  }
});

test('phase notification timeout is bounded by the reader deadline', async t => {
  const f = fixture(t);
  let tick = 0, polls = 0;
  await assert.rejects(waitForPhase(f.file, alive, f.expected, {
    timeoutMs: 10, now: () => tick, pause: async () => { polls++; tick += 5; }
  }), /phase notification timeout/);
  assert.equal(polls, 2);
});

test('phase reader reports child exit or signal before readiness', async t => {
  const f = fixture(t);
  // Even an otherwise valid old file cannot turn an exited operation into ready.
  fs.writeFileSync(f.file, JSON.stringify(document(f.expected)));
  for (const child of [{ exitCode: 7, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) {
    await assert.rejects(waitForPhase(f.file, child, f.expected), /process exited before phase/);
  }
});
