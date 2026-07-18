import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../bin/linmas.mjs';

function io() {
  let stdout = '';
  let stderr = '';
  return {
    stdin: { async *[Symbol.asyncIterator]() {} },
    isTTY: false,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    async readLine() { return ''; },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; }
  };
}

test('review prepare command succeeds without credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-review-'));
  fs.writeFileSync(path.join(root, 'input.txt'), 'safe review input');
  const capture = io();
  const code = await run(['node', 'linmas.mjs', 'review', '--skill', 'secure-code-reviewer', '--input', path.join(root, 'input.txt')], capture);
  assert.equal(code, 0);
  assert.match(capture.stdoutText, /No data was transmitted/);
  assert.equal(capture.stderrText, '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('review missing input returns input exit code', async () => {
  const capture = io();
  assert.equal(await run(['node', 'linmas.mjs', 'review'], capture), 2);
  assert.match(capture.stderrText, /exactly one of --input or --stdin/);
});

test('review confirmation EOF returns input exit code without creating provider runner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-review-'));
  try {
    fs.writeFileSync(path.join(root, 'input.txt'), 'safe review input');
    const capture = io();
    capture.isTTY = true;
    capture.readLine = async () => null;
    let created = false;
    const providerRegistry = new Map([['fake', { create() { created = true; return { run() {} }; } }]]);
    const code = await run([
      'node', 'linmas.mjs', 'review', '--skill', 'secure-code-reviewer', '--input', path.join(root, 'input.txt'), '--provider', 'fake'
    ], capture, { providerRegistry });
    assert.equal(code, 2);
    assert.match(capture.stderrText, /outbound transmission not confirmed/);
    assert.equal(created, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review compare runs entirely offline and keeps human review visible', async () => {
  const capsule = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../examples/build-week/expected-offline-capsule.json');
  const capture = io();
  let providerCreated = false;
  const code = await run([
    'node', 'linmas.mjs', 'review', 'compare', capsule, capsule
  ], capture, {
    providerRegistry: new Map([['codex', { create() { providerCreated = true; } }]])
  });
  assert.equal(code, 0);
  assert.equal(providerCreated, false);
  assert.match(capture.stdoutText, /LINMAS REVIEW DELTA/);
  assert.match(capture.stdoutText, /Human review remains required/);
  assert.equal(capture.stderrText, '');
});
