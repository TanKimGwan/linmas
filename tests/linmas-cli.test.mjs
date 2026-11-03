import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../bin/linmas.mjs';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'bin', 'linmas.mjs');
const WINDOWS_SAFE_FILESYSTEM_ERROR = /secure destructive filesystem operations are unavailable on Windows/i;

function homeEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude')
  };
}

function homeDependencies(home) {
  return { homedir: home, env: {} };
}

function createMockIO() {
  let stdoutData = '';
  let stderrData = '';
  return {
    stdin: { async *[Symbol.asyncIterator]() {} },
    isTTY: false,
    isInteractive: false,
    async readLine() { return ''; },
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
    stdin: { async *[Symbol.asyncIterator]() {} },
    isTTY: true,
    isInteractive: true,
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

function fakeHostAdapter(tempHome) {
  const rootPath = path.join(tempHome, '.fake');
  const installRoot = path.join(rootPath, 'skills');
  const manifestPath = path.join(rootPath, 'linmas-manifest.json');
  return {
    detect() {
      return {
        host: 'fake',
        status: 'detected',
        reason: 'injected host registry',
        rootPath,
        installRoot,
        manifestPath,
        writable: true
      };
    },
    getInstallRoot() { return installRoot; },
    getManifestPath() { return manifestPath; },
    validateTarget() { return { status: 'detected', writable: true, reason: 'injected host registry' }; }
  };
}

function injectedHostRegistry(tempHome) {
  let reads = 0;
  const registry = new Map([['fake', fakeHostAdapter(tempHome)]]);
  return {
    dependencies: {
      get hostRegistry() {
        reads += 1;
        return registry;
      },
      providerRegistry: new Map([['codex', {
        detectConfiguration() { return { status: 'configured', missingRequirements: [] }; },
        async discoverCapabilities() { return { authMode: 'not-required', requiresOpenaiAuth: false }; }
      }]])
    },
    reads() { return reads; }
  };
}

test('detect, doctor, and onboard use an injected host registry', async (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-injected-host-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const { dependencies, reads } = injectedHostRegistry(tempHome);

  for (const [command, pattern] of [
    ['detect', /fake: detected/],
    ['doctor', /fake/],
    ['onboard', /fake/]
  ]) {
    const io = createMockIO();
    assert.equal(await run(['node', 'bin/linmas.mjs', command], io, dependencies), 0);
    assert.match(io.getStdout(), pattern);
  }
  assert.equal(reads(), 3);
});

test('doctor reports a malformed host manifest and continues with valid hosts', (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-doctor-invalid-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  for (const host of ['claude', 'codex']) fs.mkdirSync(path.join(tempHome, `.${host}`, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.claude', 'linmas-manifest.json'), '{invalid json}\n');
  fs.writeFileSync(path.join(tempHome, '.codex', 'linmas-manifest.json'), JSON.stringify({
    tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'codex',
    installedAt: '2026-09-03T00:00:00.000Z', skills: []
  }));

  const result = spawnSync(process.execPath, [cliPath, 'doctor'], {
    cwd: rootDir,
    env: homeEnv(tempHome),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Linmas doctor report:/);
  assert.match(result.stdout, /manifest claude: invalid/i);
  assert.match(result.stdout, /manifest codex: 0 tracked skill/i);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /file:\/\/|node:internal|linmas-bug-remediation/);
});

test('onboard separates installation readiness from blocked Codex execution capability', async (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-onboard-capability-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const adapter = fakeHostAdapter(tempHome);
  const skillPath = path.join(adapter.getInstallRoot(), 'linmas-security-operations-lead');
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# installed\n');
  fs.writeFileSync(adapter.getManifestPath(), JSON.stringify({
    tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'fake',
    installedAt: '2026-09-03T00:00:00.000Z',
    skills: [{ name: 'linmas-security-operations-lead', path: skillPath, backupPath: null }]
  }));

  let capabilityOptions;
  const providerRegistry = new Map([['codex', {
    detectConfiguration() {
      return { provider: 'codex', status: 'configured', missingRequirements: [] };
    },
    async discoverCapabilities(options) {
      capabilityOptions = options;
      throw new ReviewError('Authorization: Bearer ONBOARD_SECRET_SENTINEL', 'provider-authentication', EXIT_CODES.PROVIDER, {
        stage: 'authentication', reasonCode: 'AUTHENTICATION_REQUIRED', provider: 'codex', transmissionState: 'not-attempted'
      });
    }
  }]]);
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'onboard'], io, {
    hostRegistry: new Map([['fake', adapter]]),
    providerRegistry
  });

  assert.equal(code, 0);
  assert.match(io.getStdout(), /Host installation: PASS/);
  assert.match(io.getStdout(), /Skill installation: PASS/);
  assert.match(io.getStdout(), /Codex execution capability: BLOCKED/);
  assert.match(io.getStdout(), /Reason: Provider authentication failed\./);
  assert.doesNotMatch(io.getStdout(), /ONBOARD_SECRET_SENTINEL|Authorization|Bearer/);
  assert.equal(io.getStderr(), '');
  assert.equal(capabilityOptions.includeModels, false);
  assert.ok(capabilityOptions.timeoutMs > 0 && capabilityOptions.timeoutMs <= 5000);
  assert.ok(capabilityOptions.signal instanceof AbortSignal);
});

test('install uses injected host registry paths and writes its manifest there', async (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-injected-install-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const adapter = fakeHostAdapter(tempHome);
  const { dependencies, reads } = injectedHostRegistry(tempHome);
  const installRoot = adapter.getInstallRoot();
  const manifestPath = adapter.getManifestPath();
  fs.mkdirSync(installRoot, { recursive: true });

  const io = createPromptIO(['yes']);
  assert.equal(await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], io, dependencies), 0);
  assert.equal(reads(), 1);
  assert.equal(fs.existsSync(path.join(installRoot, 'linmas-security-operations-lead', 'SKILL.md')), true);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).host, 'fake');
});

test('uninstall uses injected host registry paths and removes its manifest entry', async (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-injected-uninstall-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const adapter = fakeHostAdapter(tempHome);
  const { dependencies, reads } = injectedHostRegistry(tempHome);
  const skillPath = path.join(adapter.getInstallRoot(), 'security-operations-lead');
  const manifestPath = adapter.getManifestPath();
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# injected\n');
  fs.writeFileSync(manifestPath, JSON.stringify({
    tool: 'linmas',
    version: '0.1.0',
    manifestVersion: 1,
    host: 'fake',
    installedAt: '2026-07-13T00:00:00.000Z',
    skills: [{ name: 'security-operations-lead', path: skillPath, backupPath: null }]
  }));

  const io = createPromptIO(['yes']);
  const code = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead'], io, dependencies);
  assert.equal(reads(), 1);
  if (process.platform === 'win32') {
    assert.equal(code, 1);
    assert.match(io.getStderr(), WINDOWS_SAFE_FILESYSTEM_ERROR);
    assert.equal(fs.existsSync(skillPath), true);
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).skills.length, 1);
  } else {
    assert.equal(code, 0);
    assert.equal(fs.existsSync(skillPath), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).skills, []);
  }
});

test('list and review do not read the injected host registry', async (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-injected-lazy-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const { dependencies, reads } = injectedHostRegistry(tempHome);

  assert.equal(await run(['node', 'bin/linmas.mjs', 'list'], createMockIO(), dependencies), 0);
  const inputPath = path.join(tempHome, 'review.txt');
  fs.writeFileSync(inputPath, 'review input');
  assert.equal(await run([
    'node',
    'bin/linmas.mjs',
    'review',
    '--skill',
    'secure-code-reviewer',
    '--input',
    inputPath
  ], createMockIO(), dependencies), 0);
  assert.equal(reads(), 0);
});

test('run unknown command prints error and returns 1', async () => {
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'invalid-command'], io);

  assert.equal(code, 1);
  assert.equal(io.getStdout(), '');
  assert.match(io.getStderr(), /Unknown command: invalid-command/);
});

test('invalid command options fail before host discovery, provider work, or mutation', async () => {
  const io = createMockIO();
  let registryReads = 0;
  const code = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead', '--dry-rnu'], io, {
    get hostRegistry() {
      registryReads += 1;
      return new Map();
    }
  });

  assert.equal(code, 2);
  assert.equal(registryReads, 0);
  assert.equal(io.getStdout(), '');
  assert.match(io.getStderr(), /unknown option.*dry-rnu/i);

  const reviewIo = createMockIO();
  let providerReads = 0;
  const reviewCode = await run(['node', 'bin/linmas.mjs', 'review', '--providre', 'codex'], reviewIo, {
    get providerRegistry() {
      providerReads += 1;
      return new Map();
    }
  });
  assert.equal(reviewCode, 2);
  assert.equal(providerReads, 0);
  assert.equal(reviewIo.getStdout(), '');
  assert.match(reviewIo.getStderr(), /unknown option.*providre/i);
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

    const dryRunIo = createPromptIO(['1']);
    const dryRunCode = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead', '--dry-run'], dryRunIo, homeDependencies(tempHome));

    assert.equal(dryRunCode, 0);
    assert.match(dryRunIo.getStdout(), /Linmas install preview:/);
    assert.match(dryRunIo.getStdout(), /security-operations-lead/);
    assert.equal(fs.existsSync(path.join(installRoot, 'linmas-security-operations-lead')), false);

    const installIo = createPromptIO(['1', 'yes']);
    const installCode = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], installIo, homeDependencies(tempHome));

    assert.equal(installCode, 0);
    assert.match(installIo.getStdout(), /Choose target host: \[1\] Claude \[2\] Codex \[3\] Both/);
    assert.match(installIo.getStdout(), /Linmas install preview:/);
    assert.match(installIo.getStdout(), /Install completed\./);
    assert.match(installIo.getStdout(), /Installed: linmas-security-operations-lead/);
    assert.match(installIo.getStdout(), /Next steps:/);
    assert.equal(fs.existsSync(path.join(installRoot, 'linmas-security-operations-lead', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(codexDir, 'skills', 'linmas-security-operations-lead')), false);
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
    const code = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], io, homeDependencies(tempHome));
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
    const dryRunCode = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead', '--dry-run'], dryRunIo, homeDependencies(tempHome));

    assert.equal(dryRunCode, 0);
    assert.match(dryRunIo.getStdout(), /Linmas uninstall preview:/);
    assert.match(dryRunIo.getStdout(), /security-operations-lead/);
    assert.equal(fs.existsSync(skillPath), true);

    const uninstallIo = createPromptIO(['yes']);
    const uninstallCode = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead'], uninstallIo, homeDependencies(tempHome));

    assert.match(uninstallIo.getStdout(), /Linmas uninstall preview:/);
    if (process.platform === 'win32') {
      assert.equal(uninstallCode, 1);
      assert.doesNotMatch(uninstallIo.getStdout(), /Uninstall completed\./);
      assert.match(uninstallIo.getStderr(), WINDOWS_SAFE_FILESYSTEM_ERROR);
      assert.equal(fs.existsSync(skillPath), true);
      assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).skills.length, 1);
    } else {
      assert.equal(uninstallCode, 0);
      assert.match(uninstallIo.getStdout(), /Uninstall completed\./);
      assert.equal(fs.existsSync(skillPath), false);
    }
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

    const codexConflictPath = path.join(codexDir, 'skills', 'linmas-security-operations-lead');
    fs.mkdirSync(codexConflictPath, { recursive: true });
    fs.writeFileSync(path.join(codexConflictPath, 'SKILL.md'), 'unmanaged content');

    const installIo = createPromptIO(['1', 'yes']);
    const code = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], installIo, homeDependencies(tempHome));

    assert.equal(code, 0);
    assert.match(installIo.getStdout(), /Linmas install preview:/);
    assert.match(installIo.getStdout(), /Install completed\./);
    assert.equal(fs.existsSync(path.join(claudeDir, 'skills', 'linmas-security-operations-lead', 'SKILL.md')), true);
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
    const code = await run(['node', 'bin/linmas.mjs', 'uninstall', 'security-operations-lead'], uninstallIo, homeDependencies(tempHome));

    assert.match(uninstallIo.getStdout(), /Linmas uninstall preview:/);
    assert.match(uninstallIo.getStdout(), /- claude: remove security-operations-lead/);
    assert.doesNotMatch(uninstallIo.getStdout(), /- codex: remove security-operations-lead/);
    if (process.platform === 'win32') {
      assert.equal(code, 1);
      assert.doesNotMatch(uninstallIo.getStdout(), /Uninstall completed\./);
      assert.match(uninstallIo.getStderr(), WINDOWS_SAFE_FILESYSTEM_ERROR);
      assert.equal(fs.existsSync(claudeSkillPath), true);
      assert.equal(JSON.parse(fs.readFileSync(claudeManifestPath, 'utf8')).skills.length, 1);
    } else {
      assert.equal(code, 0);
      assert.match(uninstallIo.getStdout(), /Uninstall completed\./);
      assert.equal(fs.existsSync(claudeSkillPath), false);
    }
    assert.equal(fs.existsSync(codexSkillPath), true);
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('scoped non-interactive install, doctor, and uninstall stay inside the selected project', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-scoped-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dependencies = { homedir: home, cwd: project, env: {} };
  const skill = 'linmas-security-operations-lead';

  const installIo = createMockIO();
  assert.equal(await run(['node', cliPath, 'install', '--skill', skill, '--agent', 'codex', '--project', project, '--method', 'copy', '--yes'], installIo, dependencies), 0);
  const installedPath = path.join(project, '.agents', 'skills', skill);
  assert.equal(fs.readFileSync(path.join(installedPath, 'SKILL.md'), 'utf8').includes('security-operations-lead'), true);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);

  const doctorIo = createMockIO();
  assert.equal(await run(['node', cliPath, 'doctor', '--scope', 'project', '--project', project], doctorIo, dependencies), 0);
  assert.match(doctorIo.getStdout(), /codex: managed \(direct\)/);

  const uninstallIo = createMockIO();
  assert.equal(await run(['node', cliPath, 'uninstall', skill, '--agent', 'codex', '--project', project, '--yes'], uninstallIo, dependencies), 0);
  assert.equal(fs.existsSync(installedPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.agents', 'linmas-manifest.json'), 'utf8')).skills, []);
});

test('scoped dry-run validates a complete choice without creating files', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-scoped-dry-run-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const io = createMockIO();
  const code = await run(['node', cliPath, 'install', '--skill', 'linmas-security-operations-lead', '--agent', 'claude', '--project', project, '--method', 'symlink', '--dry-run'], io, { homedir: home, cwd: project, env: {} });
  assert.equal(code, 0);
  assert.match(io.getStdout(), /Dry run: no files or lock state will be written/);
  assert.equal(fs.existsSync(path.join(project, '.agents')), false);
  assert.equal(fs.existsSync(path.join(project, '.claude')), false);
});

test('interactive unavailable-symlink fallback shows and confirms a fresh copy preview', { skip: process.platform === 'win32' ? 'scoped destructive apply is unavailable on Windows' : false }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-symlink-fallback-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const io = createPromptIO(['yes', 'yes']);
  const originalSymlink = fs.symlinkSync;
  fs.symlinkSync = function unavailableSymlink(...args) {
    if (String(args[1]).includes('.linmas-stage.')) {
      const error = new Error('symlinks unavailable in this fixture');
      error.code = 'EOPNOTSUPP';
      throw error;
    }
    return originalSymlink.apply(this, args);
  };
  try {
    const code = await run([
      'node', cliPath, 'install', '--skill', 'linmas-security-operations-lead',
      '--agent', 'claude', '--project', project, '--method', 'symlink'
    ], io, { homedir: home, cwd: project, env: {} });
    assert.equal(code, 0);
    assert.match(io.getStderr(), /Symlink creation is unavailable/);
    assert.match(io.getStdout(), /Requested method: symlink[\s\S]*Requested method: copy/);
    assert.match(io.getStdout(), /Install the new copy preview\? \[yes\/no\]/);
    assert.equal(fs.lstatSync(path.join(project, '.claude', 'skills', 'linmas-security-operations-lead')).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(project, '.agents', 'skills', 'linmas-security-operations-lead')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.agents', 'linmas-manifest.json'), 'utf8')).skills[0].attachments[0].method, 'copy');
  } finally {
    fs.symlinkSync = originalSymlink;
  }
});

test('permission errors during symlink creation fail closed without copy fallback', { skip: process.platform === 'win32' ? 'scoped destructive apply is unavailable on Windows' : false }, async (t) => {
  const originalSymlink = fs.symlinkSync;
  for (const codeName of ['EPERM', 'EACCES']) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `linmas-cli-symlink-${codeName.toLowerCase()}-`));
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const io = createPromptIO(['yes']);
    fs.symlinkSync = function deniedSymlink(...args) {
      if (String(args[1]).includes('.linmas-stage.')) {
        const error = new Error(`injected ${codeName}`);
        error.code = codeName;
        throw error;
      }
      return originalSymlink.apply(this, args);
    };
    try {
      const code = await run([
        'node', cliPath, 'install', '--skill', 'linmas-security-operations-lead',
        '--agent', 'claude', '--project', project, '--method', 'symlink'
      ], io, { homedir: home, cwd: project, env: {} });
      assert.equal(code, 1);
      assert.match(io.getStderr(), new RegExp(codeName));
      assert.doesNotMatch(io.getStderr(), /Symlink creation is unavailable/);
      assert.doesNotMatch(io.getStdout(), /Requested method: copy|Install the new copy preview/);
      assert.equal(fs.existsSync(path.join(project, '.claude', 'skills', 'linmas-security-operations-lead')), false);
      assert.equal(fs.existsSync(path.join(project, '.agents', 'skills', 'linmas-security-operations-lead')), false);
    } finally {
      fs.symlinkSync = originalSymlink;
    }
  }
});

test('unsupported symlink fallback preserves incomplete rollback recovery details', { skip: process.platform === 'win32' ? 'scoped destructive apply is unavailable on Windows' : false }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-fallback-recovery-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const skill = 'linmas-secure-code-reviewer';
  const destination = path.join(project, '.claude', 'skills', skill);
  fs.mkdirSync(home);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'local.txt'), 'original user data');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const io = createPromptIO(['yes', 'yes']);
  const originalSymlink = fs.symlinkSync;
  fs.symlinkSync = function injectRollbackCollision(...args) {
    if (String(args[1]).includes('.linmas-stage.')) {
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, 'foreign.txt'), 'concurrent data');
      const error = new Error('injected unsupported symlink');
      error.code = 'EOPNOTSUPP';
      throw error;
    }
    return originalSymlink.apply(this, args);
  };
  let code;
  try {
    code = await run([
      'node', cliPath, 'install', '--skill', skill, '--agent', 'claude',
      '--project', project, '--method', 'symlink'
    ], io, { homedir: home, cwd: project, env: {} });
  } finally {
    fs.symlinkSync = originalSymlink;
  }

  const stderr = io.getStderr();
  assert.equal(code, 1);
  assert.match(stderr, /Recovery data retained at: .*\.linmas-backups/);
  assert.doesNotMatch(stderr, /copy fallback has conflicts|Symlink creation is unavailable/);
  assert.doesNotMatch(io.getStdout(), /Requested method: copy|Install the new copy preview/);
  assert.equal(fs.readFileSync(path.join(destination, 'foreign.txt'), 'utf8'), 'concurrent data');
  const recoveryPath = stderr.match(/Recovery data retained at: ([^\n]+)/)?.[1];
  assert.ok(recoveryPath);
  assert.equal(fs.readFileSync(path.join(recoveryPath, 'local.txt'), 'utf8'), 'original user data');
});

test('bare install wizard selects skill and host before scope, rejects multi-select scope, and chooses method', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-scoped-wizard-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const io = createPromptIO(['1', '2', '1,2', '1', '1', 'yes']);
  const code = await run(['node', cliPath, 'install'], io, { homedir: home, cwd: project, env: {} });
  assert.equal(code, 0);
  assert.ok(io.getStdout().indexOf('Choose skills to install') < io.getStdout().indexOf('Choose host integrations'));
  assert.ok(io.getStdout().indexOf('Choose host integrations') < io.getStdout().indexOf('Choose installation scope'));
  assert.ok(io.getStdout().indexOf('Choose installation scope') < io.getStdout().indexOf('Choose installation method'));
  assert.match(io.getStdout(), /Choose installation scope/);
  assert.match(io.getStdout(), /Choose skills to install/);
  assert.match(io.getStdout(), /Choose host integrations/);
  assert.match(io.getStdout(), /Choose installation method/);
  assert.match(io.getStdout(), /Choose one option only/);
  assert.match(io.getStdout(), /Next: linmas doctor --scope project --project/);
  assert.match(io.getStdout(), /Next: linmas uninstall --skill linmas-security-operations-lead --agent codex --scope project --project/);
  assert.doesNotMatch(io.getStdout(), /Next: linmas uninstall .*--yes/);
  assert.equal(fs.existsSync(path.join(project, '.agents', 'skills', 'linmas-security-operations-lead', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
});

test('scoped install next step keeps subset and quotes shell-special project paths', { skip: process.platform === 'win32' ? 'POSIX shell quoting check' : false }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-scoped-next-step-'));
  const home = path.join(base, 'home');
  const project = path.join(base, "project space 'with $dollar and `tick`");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dependencies = { homedir: home, cwd: base, env: {} };
  const first = 'linmas-security-operations-lead';
  const selected = 'linmas-secure-code-reviewer';

  assert.equal(await run(['node', cliPath, 'install', '--skill', first, '--agent', 'codex', '--project', project, '--method', 'copy', '--yes'], createMockIO(), dependencies), 0);
  const io = createMockIO();
  assert.equal(await run(['node', cliPath, 'install', '--skill', selected, '--agent', 'codex', '--project', project, '--method', 'copy', '--yes'], io, dependencies), 0);
  const uninstallLine = io.getStdout().split('\n').find((line) => line.startsWith('Next: linmas uninstall'));
  assert.match(uninstallLine, /--skill linmas-secure-code-reviewer/);
  assert.doesNotMatch(uninstallLine, /--all|--yes/);
  const quotedProject = uninstallLine.slice(uninstallLine.indexOf('--project ') + '--project '.length);
  assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${quotedProject}`], { encoding: 'utf8' }), project);
  assert.equal(fs.existsSync(path.join(project, '.agents', 'skills', first, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(project, '.agents', 'skills', selected, 'SKILL.md')), true);
});

test('scoped wizard EOF during confirmation returns 130 with zero writes', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-scoped-eof-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const io = createMockIO();
  io.isInteractive = true;
  const inputs = ['1', '1', '1', '1', null];
  io.readLine = async () => inputs.shift() ?? null;

  assert.equal(await run(['node', cliPath, 'install'], io, { homedir: home, cwd: project, env: {} }), 130);
  assert.match(io.getStdout(), /install preview/i);
  assert.equal(fs.existsSync(path.join(project, '.agents')), false);
  assert.equal(fs.existsSync(path.join(project, '.claude')), false);
  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
});

test('direct CLI install can prompt via process stdin/stdout', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-direct-install-'));

  try {
    fs.mkdirSync(path.join(tempHome, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(tempHome, '.codex', 'skills'), { recursive: true });

    const result = spawnSync(process.execPath, [cliPath, 'install', 'security-operations-lead'], {
      cwd: rootDir,
      env: homeEnv(tempHome),
      input: '1\nyes\n',
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Choose target host: \[1\] Claude \[2\] Codex \[3\] Both/);
    assert.match(result.stdout, /Confirm installation\? \[yes\/no\]/);
    assert.match(result.stdout, /Install completed\./);
    assert.match(result.stdout, /Installed: linmas-security-operations-lead/);
    assert.equal(fs.existsSync(path.join(tempHome, '.claude', 'skills', 'linmas-security-operations-lead', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(tempHome, '.codex', 'skills', 'linmas-security-operations-lead')), false);
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
    const code = await run(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead'], io, homeDependencies(tempHome));

    assert.equal(code, 0);
    assert.match(io.getStdout(), /Installed skills:/);
    assert.match(io.getStdout(), /Installed: linmas-security-operations-lead/);
    assert.match(io.getStdout(), /Next steps:/);
    assert.equal(fs.existsSync(path.join(claudeDir, 'skills', 'linmas-security-operations-lead', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(codexDir, 'skills', 'linmas-security-operations-lead')), false);
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});


test('direct CLI install aborts immediately when replacement is declined', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-direct-conflict-'));

  try {
    const installRoot = path.join(tempHome, '.claude', 'skills');
    const skillPath = path.join(installRoot, 'linmas-security-operations-lead');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), 'unmanaged content');

    const result = spawnSync(process.execPath, [cliPath, 'install', 'security-operations-lead'], {
      cwd: rootDir,
      env: homeEnv(tempHome),
      input: '1\ncancel\n',
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
      env: homeEnv(tempHome),
      input: 'wrong\nclaude\nyes\n',
      encoding: 'utf8'
    });

    assert.match(result.stdout, /Choose uninstall target: claude, codex, or both/);
    assert.match(result.stdout, /Invalid uninstall target\./);
    assert.match(result.stdout, /- claude: remove security-operations-lead/);
    assert.doesNotMatch(result.stdout, /- codex: remove security-operations-lead/);
    if (process.platform === 'win32') {
      assert.equal(result.status, 1);
      assert.match(result.stderr, WINDOWS_SAFE_FILESYSTEM_ERROR);
      assert.equal(fs.existsSync(claudeSkillPath), true);
    } else {
      assert.equal(result.status, 0);
      assert.equal(fs.existsSync(claudeSkillPath), false);
    }
    assert.equal(fs.existsSync(codexSkillPath), true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('CLI install aborts on manifest host mismatch before copying skill', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-host-mismatch-'));

  try {
    const claudeRoot = path.join(tempHome, '.claude');
    const codexRoot = path.join(tempHome, '.codex');
    const claudeManifestPath = path.join(claudeRoot, 'linmas-manifest.json');

    fs.mkdirSync(path.join(claudeRoot, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(codexRoot, 'skills'), { recursive: true });

    fs.writeFileSync(claudeManifestPath, JSON.stringify({
      tool: 'linmas',
      version: '0.3.0',
      manifestVersion: 1,
      host: 'codex',
      installedAt: '2026-07-14T00:00:00.000Z',
      skills: []
    }));

    const result = spawnSync(process.execPath, [cliPath, 'install', 'security-operations-lead'], {
      cwd: rootDir,
      env: homeEnv(tempHome),
      input: '',
      encoding: 'utf8'
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Manifest host mismatch/);
    assert.equal(fs.existsSync(path.join(claudeRoot, 'skills', 'linmas-security-operations-lead')), false, 'skill must not be copied to claude');
    assert.equal(fs.existsSync(path.join(codexRoot, 'skills', 'linmas-security-operations-lead')), false, 'skill must not be copied to codex');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('CLI uninstall with closed stdin exits as cancellation', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-uninstall-eof-'));

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
      env: homeEnv(tempHome),
      input: '',
      encoding: 'utf8'
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Uninstall cancelled/);
    assert.equal(fs.existsSync(claudeSkillPath), true, 'claude skill must not be removed on EOF');
    assert.equal(fs.existsSync(codexSkillPath), true, 'codex skill must not be removed on EOF');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
