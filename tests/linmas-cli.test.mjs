import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../bin/linmas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'bin', 'linmas.mjs');

function createMockIO() {
  let stdoutData = '';
  let stderrData = '';
  return {
    stdout: {
      write(chunk) {
        stdoutData += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk) {
        stderrData += chunk;
        return true;
      }
    },
    getStdout() {
      return stdoutData;
    },
    getStderr() {
      return stderrData;
    }
  };
}

test('run list command prints available skills', async () => {
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'list'], io);

  assert.equal(code, 0);
  assert.match(io.getStdout(), /Available Linmas skills:/);
  assert.match(io.getStdout(), /security-operations-lead/);
  assert.equal(io.getStderr(), '');
});

test('run unknown command prints error and returns 1', async () => {
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'invalid-command'], io);

  assert.equal(code, 1);
  assert.equal(io.getStdout(), '');
  assert.match(io.getStderr(), /Unknown command: invalid-command/);
});

test('symlinked top-level entrypoint prints list output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-'));
  const symlinkPath = path.join(tempDir, 'linmas');
  fs.symlinkSync(cliPath, symlinkPath);

  const output = execFileSync(process.execPath, [symlinkPath, 'list'], {
    cwd: rootDir,
    encoding: 'utf8'
  });

  assert.match(output, /Available Linmas skills:/);
  assert.match(output, /security-operations-lead/);
});

test('symlinked top-level entrypoint reports unknown commands', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-'));
  const symlinkPath = path.join(tempDir, 'linmas');
  fs.symlinkSync(cliPath, symlinkPath);

  assert.throws(
    () => execFileSync(process.execPath, [symlinkPath, 'bad-command'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    /Unknown command: bad-command/
  );
});

test('run install command perform dry-run preview or actual install', async () => {
  const originalHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-install-'));
  os.homedir = () => tempHome;

  try {
    // Setup target directories to be detected
    const claudeDir = path.join(tempHome, '.claude');
    const installRoot = path.join(claudeDir, 'skills');
    fs.mkdirSync(installRoot, { recursive: true });

    // 1. Dry run preview test
    const dryRunIo = createMockIO();
    const dryRunCode = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead', '--dry-run'], dryRunIo);

    assert.equal(dryRunCode, 0);
    assert.match(dryRunIo.getStdout(), /Linmas install preview:/);
    assert.match(dryRunIo.getStdout(), /security-operations-lead/);
    assert.equal(fs.existsSync(path.join(installRoot, 'security-operations-lead')), false); // dry run: should not write!

    // 2. Actual install test
    const installIo = createMockIO();
    const installCode = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], installIo);

    assert.equal(installCode, 0);
    assert.match(installIo.getStdout(), /Linmas install preview:/);
    assert.match(installIo.getStdout(), /Install completed\./);
    assert.equal(fs.existsSync(path.join(installRoot, 'security-operations-lead', 'SKILL.md')), true); // should exist now!
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('run uninstall command performs dry-run preview or actual uninstall', async () => {
  const originalHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-uninstall-'));
  os.homedir = () => tempHome;

  try {
    const claudeDir = path.join(tempHome, '.claude');
    const installRoot = path.join(claudeDir, 'skills');
    const skillPath = path.join(installRoot, 'security-operations-lead');
    const manifestPath = path.join(claudeDir, 'linmas-manifest.json');

    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# skill\n');

    const manifest = {
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'security-operations-lead', path: skillPath, backupPath: null }]
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    // 1. Dry run preview test
    const dryRunIo = createMockIO();
    const dryRunCode = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead', '--dry-run'], dryRunIo);

    assert.equal(dryRunCode, 0);
    assert.match(dryRunIo.getStdout(), /Linmas uninstall preview:/);
    assert.match(dryRunIo.getStdout(), /security-operations-lead/);
    assert.equal(fs.existsSync(skillPath), true); // dry run: should not delete!

    // 2. Actual uninstall test
    const uninstallIo = createMockIO();
    const uninstallCode = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead'], uninstallIo);

    assert.equal(uninstallCode, 0);
    assert.match(uninstallIo.getStdout(), /Linmas uninstall preview:/);
    assert.match(uninstallIo.getStdout(), /Uninstall completed\./);
    assert.equal(fs.existsSync(skillPath), false); // should be deleted!
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});


