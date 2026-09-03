import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');

test('cli smoke: list and onboard exit successfully', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-smoke-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const list = spawnSync(process.execPath, ['bin/linmas.mjs', 'list'], { encoding: 'utf8' });
  const onboard = spawnSync(process.execPath, ['bin/linmas.mjs', 'onboard'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '', HOME: home, USERPROFILE: home }
  });

  assert.equal(list.status, 0);
  assert.match(list.stdout, /Available Linmas skills:/);
  assert.equal(onboard.status, 0);
  assert.match(onboard.stdout, /Linmas onboarding:/);
  assert.match(onboard.stdout, /Codex execution capability: BLOCKED/);
});

test('NEW-001 declared CLI entrypoint is tracked, executable, and runnable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const declaredTarget = packageJson.bin?.linmas;
  assert.equal(declaredTarget, 'bin/linmas.mjs');

  const entrypoint = path.join(rootDir, declaredTarget);
  const stat = fs.lstatSync(entrypoint);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  if (process.platform !== 'win32') assert.notEqual(stat.mode & 0o111, 0);

  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', declaredTarget], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout.trim(), declaredTarget);

  const result = spawnSync(process.execPath, [entrypoint, 'list'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available Linmas skills:/);
});
