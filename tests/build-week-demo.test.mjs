import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBuildWeekDemo } from '../scripts/demo-build-week.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNpm(args, options) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], options)
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; }
  };
}

test('offline judge demo uses fixture replay without constructing a live provider', async () => {
  const io = captureIo();
  let providerCreated = false;
  const code = await runBuildWeekDemo([], {
    rootDir,
    io,
    createProviderRegistryImpl() { providerCreated = true; throw new Error('network/provider forbidden'); },
    now: () => new Date('2026-07-18T15:00:00.000Z')
  });
  assert.equal(code, 0);
  assert.equal(providerCreated, false);
  assert.match(io.stdoutText, /OFFLINE FIXTURE REPLAY — NO MODEL CALL/);
  assert.match(io.stdoutText, /Contract validation\s+PASSED/);
  assert.match(io.stdoutText, /Policy decision\s+BLOCKED/);
  assert.match(io.stdoutText, /Human review\s+REQUIRED/);
  assert.doesNotMatch(io.stdoutText, /\/home\/|private|session/i);
  assert.equal(io.stderrText, '');
});

test('offline demo can atomically write the expected validated capsule', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'linmas-demo-'));
  try {
    const destination = path.join(root, 'capsule.json');
    const io = captureIo();
    const code = await runBuildWeekDemo(['--capsule', destination], {
      rootDir,
      io,
      now: () => new Date('2026-07-18T15:00:00.000Z')
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(destination), true);
    const actual = JSON.parse(await fsp.readFile(destination, 'utf8'));
    const expected = JSON.parse(await fsp.readFile(path.join(rootDir, 'examples/build-week/expected-offline-capsule.json'), 'utf8'));
    assert.deepEqual(actual, expected);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('live demo requires explicit confirmation and never falls back after provider failure', async () => {
  let called = false;
  const refusedIo = captureIo();
  const refused = await runBuildWeekDemo(['--live'], {
    rootDir,
    io: refusedIo,
    async runReviewImpl() { called = true; }
  });
  assert.equal(refused, 2);
  assert.equal(called, false);
  assert.match(refusedIo.stderrText, /requires --yes/);

  const failedIo = captureIo();
  const failed = await runBuildWeekDemo(['--live', '--yes'], {
    rootDir,
    io: failedIo,
    async runReviewImpl() { throw new Error('synthetic provider failure'); }
  });
  assert.equal(failed, 1);
  assert.match(failedIo.stderrText, /synthetic provider failure/);
  assert.doesNotMatch(failedIo.stdoutText, /OFFLINE FIXTURE REPLAY/);
});

test('live demo forwards an explicit account-visible model to Codex execution', async () => {
  const io = captureIo();
  let received;
  const code = await runBuildWeekDemo(['--live', '--yes', '--model', 'gpt-5.6-sol'], {
    rootDir,
    io,
    async runReviewImpl(options) {
      received = options;
      return { output: 'live result\n', exitCode: 0 };
    },
    createProviderRegistryImpl() { return new Map(); }
  });
  assert.equal(code, 0);
  assert.equal(received.model, 'gpt-5.6-sol');
  assert.equal(received.provider, 'codex');
  assert.equal(io.stdoutText, 'live result\n');
});

test('Build Week synthetic fixture and demo are included by npm pack', () => {
  const packed = JSON.parse(runNpm(['pack', '--dry-run', '--json', '--cache', path.join(os.tmpdir(), 'linmas-npm-cache')], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe'
  }));
  const files = new Set(packed[0].files.map((item) => item.path));
  assert.equal(files.has('scripts/demo-build-week.mjs'), true);
  assert.equal(files.has('examples/build-week/insecure-query.diff'), true);
  assert.equal(files.has('examples/build-week/offline-review-result.json'), true);
  assert.equal(files.has('examples/build-week/expected-offline-capsule.json'), true);
});

test('packed contents execute the offline judge demo from a neutral directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'linmas-packed-demo-'));
  try {
    const packJson = JSON.parse(runNpm(['pack', '--json', '--pack-destination', root, '--cache', path.join(os.tmpdir(), 'linmas-npm-cache')], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: 'pipe'
    }));
    const tarball = path.join(root, packJson[0].filename);
    runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    const output = execFileSync(process.execPath, [path.join(root, 'node_modules/linmas/scripts/demo-build-week.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, PATH: path.dirname(process.execPath) }
    });
    assert.match(output, /OFFLINE FIXTURE REPLAY — NO MODEL CALL/);
    assert.match(output, /Human review\s+REQUIRED/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
