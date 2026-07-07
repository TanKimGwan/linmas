import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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

function createPromptIO(inputs) {
  let stdoutData = '';
  let stderrData = '';
  const queue = [...inputs];
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
    },
    async readLine() {
      return queue.shift() || '';
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
    const claudeDir = path.join(tempHome, '.claude');
    const codexDir = path.join(tempHome, '.codex');
    const installRoot = path.join(claudeDir, 'skills');
    fs.mkdirSync(installRoot, { recursive: true });
    fs.mkdirSync(path.join(codexDir, 'skills'), { recursive: true });

    const dryRunIo = createMockIO();
    const dryRunCode = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead', '--dry-run'], dryRunIo);

    assert.equal(dryRunCode, 0);
    assert.match(dryRunIo.getStdout(), /Linmas install preview:/);
    assert.match(dryRunIo.getStdout(), /security-operations-lead/);
    assert.equal(fs.existsSync(path.join(installRoot, 'security-operations-lead')), false);

    const installIo = createPromptIO(['1', 'yes']);
    const installCode = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], installIo);

    assert.equal(installCode, 0);
    assert.match(installIo.getStdout(), /Choose target host: \[1\] Claude \[2\] Codex \[3\] Both/);
    assert.match(installIo.getStdout(), /Linmas install preview:/);
    assert.match(installIo.getStdout(), /Install completed\./);
    assert.match(installIo.getStdout(), /Installed: security-operations-lead/);
    assert.match(installIo.getStdout(), /Next steps:/);
    assert.equal(fs.existsSync(path.join(installRoot, 'security-operations-lead', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(codexDir, 'skills', 'security-operations-lead')), false);
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('run install command with cancellation', async () => {
  const originalHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-cancel-'));
  os.homedir = () => tempHome;

  try {
    const claudeDir = path.join(tempHome, '.claude');
    const installRoot = path.join(claudeDir, 'skills');
    fs.mkdirSync(installRoot, { recursive: true });

    const io = createPromptIO(['no']);
    const code = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], io);
    assert.equal(code, 1);
    assert.match(io.getStderr(), /Install cancelled by user/);
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

    const dryRunIo = createMockIO();
    const dryRunCode = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead', '--dry-run'], dryRunIo);

    assert.equal(dryRunCode, 0);
    assert.match(dryRunIo.getStdout(), /Linmas uninstall preview:/);
    assert.match(dryRunIo.getStdout(), /security-operations-lead/);
    assert.equal(fs.existsSync(skillPath), true);

    const uninstallIo = createPromptIO(['yes']);
    const uninstallCode = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead'], uninstallIo);

    assert.equal(uninstallCode, 0);
    assert.match(uninstallIo.getStdout(), /Linmas uninstall preview:/);
    assert.match(uninstallIo.getStdout(), /Uninstall completed\./);
    assert.equal(fs.existsSync(skillPath), false);
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('run install command with multi-host conflict isolation and correct flow order', async () => {
  const originalHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-multihost-'));
  os.homedir = () => tempHome;

  try {
    const claudeDir = path.join(tempHome, '.claude');
    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(codexDir, 'skills'), { recursive: true });

    const codexConflictPath = path.join(codexDir, 'skills', 'security-operations-lead');
    fs.mkdirSync(codexConflictPath, { recursive: true });
    fs.writeFileSync(path.join(codexConflictPath, 'SKILL.md'), 'unmanaged content');

    const installIo = createPromptIO(['1', 'yes']);
    const code = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], installIo);

    assert.equal(code, 0);
    assert.match(installIo.getStdout(), /Linmas install preview:/);
    assert.match(installIo.getStdout(), /Install completed\./);
    assert.equal(fs.existsSync(path.join(claudeDir, 'skills', 'security-operations-lead', 'SKILL.md')), true);
    assert.equal(fs.readFileSync(path.join(codexConflictPath, 'SKILL.md'), 'utf8'), 'unmanaged content');
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('run uninstall command with multi-host target selection and correct flow order', async () => {
  const originalHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-uninstall-multihost-'));
  os.homedir = () => tempHome;

  try {
    const claudeDir = path.join(tempHome, '.claude');
    const codexDir = path.join(tempHome, '.codex');
    const claudeSkillPath = path.join(claudeDir, 'skills', 'security-operations-lead');
    const codexSkillPath = path.join(codexDir, 'skills', 'security-operations-lead');

    fs.mkdirSync(claudeSkillPath, { recursive: true });
    fs.mkdirSync(codexSkillPath, { recursive: true });
    fs.writeFileSync(path.join(claudeSkillPath, 'SKILL.md'), '# skill\n');
    fs.writeFileSync(path.join(codexSkillPath, 'SKILL.md'), '# skill\n');

    const claudeManifestPath = path.join(claudeDir, 'linmas-manifest.json');
    const codexManifestPath = path.join(codexDir, 'linmas-manifest.json');
    const manifest = {
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'security-operations-lead', path: 'DUMMY', backupPath: null }]
    };

    fs.writeFileSync(claudeManifestPath, JSON.stringify({ ...manifest, host: 'claude', skills: [{ name: 'security-operations-lead', path: claudeSkillPath, backupPath: null }] }));
    fs.writeFileSync(codexManifestPath, JSON.stringify({ ...manifest, host: 'codex', skills: [{ name: 'security-operations-lead', path: codexSkillPath, backupPath: null }] }));

    const uninstallIo = createPromptIO(['claude', 'yes']);
    const code = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead'], uninstallIo);

    assert.equal(code, 0);
    assert.match(uninstallIo.getStdout(), /Linmas uninstall preview:/);
    assert.match(uninstallIo.getStdout(), /- claude: remove security-operations-lead/);
    assert.doesNotMatch(uninstallIo.getStdout(), /- codex: remove security-operations-lead/);
    assert.match(uninstallIo.getStdout(), /Uninstall completed\./);
    assert.equal(fs.existsSync(claudeSkillPath), false);
    assert.equal(fs.existsSync(codexSkillPath), true);
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('direct CLI install can prompt via process stdin/stdout', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-direct-install-'));

  try {
    fs.mkdirSync(path.join(tempHome, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(tempHome, '.codex', 'skills'), { recursive: true });

    const result = spawnSync(process.execPath, [cliPath, 'install', 'security-operations-lead'], {
      cwd: rootDir,
      env: { ...process.env, HOME: tempHome },
      input: '1\nyes\n',
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Choose target host: \[1\] Claude \[2\] Codex \[3\] Both/);
    assert.match(result.stdout, /Confirm installation\? \[yes\/no\]/);
    assert.match(result.stdout, /Install completed\./);
    assert.match(result.stdout, /Installed: security-operations-lead/);
    assert.equal(fs.existsSync(path.join(tempHome, '.claude', 'skills', 'security-operations-lead', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(tempHome, '.codex', 'skills', 'security-operations-lead')), false);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('install summary includes task 3 details without regressing task 2 flow', async () => {
  const originalHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-install-summary-'));
  os.homedir = () => tempHome;

  try {
    const claudeDir = path.join(tempHome, '.claude');
    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(codexDir, 'skills'), { recursive: true });

    const io = createPromptIO(['1', 'yes']);
    const code = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], io);

    assert.equal(code, 0);
    assert.match(io.getStdout(), /Installed skills:/);
    assert.match(io.getStdout(), /Installed: security-operations-lead/);
    assert.match(io.getStdout(), /Next steps:/);
    assert.equal(fs.existsSync(path.join(claudeDir, 'skills', 'security-operations-lead', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(codexDir, 'skills', 'security-operations-lead')), false);
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});


test('direct CLI install aborts immediately when replacement is declined', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-direct-conflict-'));

  try {
    const installRoot = path.join(tempHome, '.claude', 'skills');
    const skillPath = path.join(installRoot, 'security-operations-lead');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), 'unmanaged content');

    const result = spawnSync(process.execPath, [cliPath, 'install', 'security-operations-lead'], {
      cwd: rootDir,
      env: { ...process.env, HOME: tempHome },
      input: 'cancel\n',
      encoding: 'utf8'
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Install aborted due to unmanaged conflicts\./);
    assert.doesNotMatch(result.stdout, /Confirm installation\? \[yes\/no\]/);
    assert.equal(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'unmanaged content');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('direct CLI uninstall reprompts on invalid target input', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-direct-uninstall-invalid-'));

  try {
    const claudeSkillPath = path.join(tempHome, '.claude', 'skills', 'security-operations-lead');
    const codexSkillPath = path.join(tempHome, '.codex', 'skills', 'security-operations-lead');
    fs.mkdirSync(claudeSkillPath, { recursive: true });
    fs.mkdirSync(codexSkillPath, { recursive: true });
    fs.writeFileSync(path.join(claudeSkillPath, 'SKILL.md'), '# skill\n');
    fs.writeFileSync(path.join(codexSkillPath, 'SKILL.md'), '# skill\n');

    fs.writeFileSync(path.join(tempHome, '.claude', 'linmas-manifest.json'), JSON.stringify({
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'security-operations-lead', path: claudeSkillPath, backupPath: null }]
    }));
    fs.writeFileSync(path.join(tempHome, '.codex', 'linmas-manifest.json'), JSON.stringify({
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'codex',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'security-operations-lead', path: codexSkillPath, backupPath: null }]
    }));

    const result = spawnSync(process.execPath, [cliPath, 'uninstall', 'security-operations-lead'], {
      cwd: rootDir,
      env: { ...process.env, HOME: tempHome },
      input: 'wrong\nclaude\nyes\n',
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Choose uninstall target: claude, codex, or both/);
    assert.match(result.stdout, /Invalid uninstall target\./);
    assert.match(result.stdout, /- claude: remove security-operations-lead/);
    assert.doesNotMatch(result.stdout, /- codex: remove security-operations-lead/);
    assert.equal(fs.existsSync(claudeSkillPath), false);
    assert.equal(fs.existsSync(codexSkillPath), true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
