import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCodexLaunchEnvironment } from '../src/providers/codex-launch.mjs';
import { applyUninstallPlan, retryUninstallCleanup } from '../src/core/uninstall-skills.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_FILESYSTEM_OPERATION_UNAVAILABLE = 'SAFE_FILESYSTEM_OPERATION_UNAVAILABLE';

function temporaryFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function filesystemWithOpen(open) {
  return new Proxy(fsPromises, {
    get(target, property) {
      if (property === 'open') return open;
      return Reflect.get(target, property);
    }
  });
}

function assertSafeFilesystemUnavailable(error) {
  assert.equal(error?.code, SAFE_FILESYSTEM_OPERATION_UNAVAILABLE);
  assert.match(error.message, /safe filesystem operation.*unavailable|secure.*unavailable/i);
  return true;
}

test('WIN-F002-AUTH rejects replacement between lstat and open before reading content', async (t) => {
  const root = temporaryFixture(t, 'linmas-win-auth-pre-open-');
  const sourceHome = path.join(root, 'source-home');
  const workspaceDir = path.join(root, 'workspace');
  const authPath = path.join(sourceHome, 'auth.json');
  const displacedPath = path.join(sourceHome, 'auth-before-replacement.json');
  fs.mkdirSync(sourceHome);
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(authPath, '{"synthetic":"original"}\n', { mode: 0o600 });

  let injected = false;
  let reads = 0;
  const fsImpl = filesystemWithOpen(async (target, flags) => {
    assert.equal(target, authPath);
    fs.renameSync(authPath, displacedPath);
    fs.writeFileSync(authPath, '{"synthetic":"replacement"}\n', { mode: 0o600 });
    injected = true;
    const handle = await fsPromises.open(target, flags);
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      reads += 1;
      return read(...args);
    };
    return handle;
  });

  await assert.rejects(
    prepareCodexLaunchEnvironment({
      workspaceDir,
      env: { CODEX_HOME: sourceHome },
      platform: 'win32',
      fsImpl
    }),
    /invalid|identity|changed/i
  );
  assert.equal(injected, true);
  assert.equal(reads, 0, 'replacement content must not be read before identity validation');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'codex-home')), false);
});

test('WIN-F002-AUTH treats disappearance after pre-check as invalid instead of absent', async (t) => {
  const root = temporaryFixture(t, 'linmas-win-auth-disappeared-');
  const sourceHome = path.join(root, 'source-home');
  const workspaceDir = path.join(root, 'workspace');
  const authPath = path.join(sourceHome, 'auth.json');
  const displacedPath = path.join(sourceHome, 'auth-displaced.json');
  fs.mkdirSync(sourceHome);
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(authPath, '{"synthetic":"original"}\n', { mode: 0o600 });

  const fsImpl = filesystemWithOpen(async (target, flags) => {
    fs.renameSync(target, displacedPath);
    return fsPromises.open(target, flags);
  });

  await assert.rejects(
    prepareCodexLaunchEnvironment({
      workspaceDir,
      env: { CODEX_HOME: sourceHome },
      platform: 'win32',
      fsImpl
    }),
    /invalid/i
  );
  assert.equal(fs.existsSync(displacedPath), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'codex-home')), false);
});

test('WIN-F002-AUTH keeps reading the validated descriptor after source-path replacement', async (t) => {
  const root = temporaryFixture(t, 'linmas-win-auth-post-open-');
  const sourceHome = path.join(root, 'source-home');
  const workspaceDir = path.join(root, 'workspace');
  const authPath = path.join(sourceHome, 'auth.json');
  const openedPath = path.join(sourceHome, 'auth-opened.json');
  const original = '{"synthetic":"opened-object"}\n';
  const replacement = '{"synthetic":"path-replacement"}\n';
  fs.mkdirSync(sourceHome);
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(authPath, original, { mode: 0o600 });

  let injected = false;
  const fsImpl = filesystemWithOpen(async (target, flags) => {
    assert.equal(target, authPath);
    const handle = await fsPromises.open(target, flags);
    fs.renameSync(authPath, openedPath);
    fs.writeFileSync(authPath, replacement, { mode: 0o600 });
    injected = true;
    return handle;
  });

  const launchEnv = await prepareCodexLaunchEnvironment({
    workspaceDir,
    env: { CODEX_HOME: sourceHome },
    platform: 'win32',
    fsImpl
  });
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(launchEnv.CODEX_HOME, 'auth.json'), 'utf8'), original);
  assert.equal(fs.readFileSync(authPath, 'utf8'), replacement);
});

test('WIN-F001-UNINSTALL rejects before a substituted root can mutate an external object', (t) => {
  const root = temporaryFixture(t, 'linmas-win-uninstall-root-');
  const hostRoot = path.join(root, 'host');
  const installRoot = path.join(hostRoot, 'skills');
  const displacedRoot = path.join(hostRoot, 'skills-before-substitution');
  const externalRoot = path.join(root, 'external');
  const skillName = 'secure-code-reviewer';
  const skillPath = path.join(installRoot, skillName);
  const originalSkill = path.join(displacedRoot, skillName);
  const externalVictim = path.join(externalRoot, skillName);
  const manifestPath = path.join(hostRoot, 'linmas-manifest.json');
  const originalBytes = '# original managed skill\n';
  const externalBytes = '# external sentinel\n';
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), originalBytes);
  fs.mkdirSync(externalVictim, { recursive: true });
  fs.writeFileSync(path.join(externalVictim, 'SKILL.md'), externalBytes);

  const manifest = {
    tool: 'linmas',
    version: '0.7.0',
    manifestVersion: 1,
    host: 'claude',
    installedAt: '2026-09-03T00:00:00.000Z',
    skills: [{ name: skillName, path: skillPath, backupPath: null }]
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, manifestBytes);
  const manifests = new Map([['claude', structuredClone(manifest)]]);

  fs.renameSync(installRoot, displacedRoot);
  fs.symlinkSync(externalRoot, installRoot, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => applyUninstallPlan(
      [{ host: 'claude', skillName, skillPath, installRoot }],
      manifests,
      new Map([['claude', manifestPath]]),
      { platform: 'win32' }
    ),
    assertSafeFilesystemUnavailable
  );
  assert.equal(fs.readFileSync(path.join(externalVictim, 'SKILL.md'), 'utf8'), externalBytes);
  assert.equal(fs.readFileSync(path.join(originalSkill, 'SKILL.md'), 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBytes);
  assert.deepEqual(manifests.get('claude'), manifest);
});

test('WIN-F007-CLEANUP rejects caller-shaped cleanup paths with the secure Windows error', (t) => {
  const root = temporaryFixture(t, 'linmas-win-cleanup-');
  const installRoot = path.join(root, 'skills');
  const externalBackup = path.join(root, '.victim.linmas-uninstall.1.12345678-1234-4123-8123-123456789abc.tmp');
  const sentinel = '# external cleanup sentinel\n';
  fs.mkdirSync(installRoot);
  fs.mkdirSync(externalBackup);
  fs.writeFileSync(path.join(externalBackup, 'sentinel.txt'), sentinel);

  assert.throws(
    () => retryUninstallCleanup(
      { installRoot, backupPath: externalBackup },
      { platform: 'win32' }
    ),
    assertSafeFilesystemUnavailable
  );
  assert.equal(fs.readFileSync(path.join(externalBackup, 'sentinel.txt'), 'utf8'), sentinel);
});

test('WIN-NEW001-CLI verifies the declared entrypoint without POSIX mode semantics', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const entrypoint = path.join(rootDir, packageJson.bin?.linmas ?? '');
  const stat = fs.lstatSync(entrypoint);
  assert.equal(packageJson.bin?.linmas, 'bin/linmas.mjs');
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);

  const result = spawnSync(process.execPath, [entrypoint, 'list'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available Linmas skills:/);
});
