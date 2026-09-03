import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCodexLaunchEnvironment } from '../src/providers/codex-launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const launchModuleUrl = new URL('../src/providers/codex-launch.mjs', import.meta.url).href;

function fixture(t, name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `linmas-codex-launch-${name}-`));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const sourceHome = path.join(tmp, 'source-home');
  const workspaceDir = path.join(tmp, 'workspace');
  fs.mkdirSync(sourceHome);
  fs.mkdirSync(workspaceDir);
  return { tmp, sourceHome, workspaceDir, env: { CODEX_HOME: sourceHome } };
}

function assertPrivateMode(targetPath, expected) {
  assert.equal(fs.statSync(targetPath).mode & 0o777, expected);
}

test('F-002 safe regular auth source is copied with restrictive modes', async (t) => {
  const { sourceHome, workspaceDir, env } = fixture(t, 'regular');
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"synthetic":true}\n', { mode: 0o600 });

  const launchEnv = await prepareCodexLaunchEnvironment({ workspaceDir, env });
  const codexHome = launchEnv.CODEX_HOME;
  assert.notEqual(codexHome, sourceHome);
  assertPrivateMode(codexHome, 0o700);
  assertPrivateMode(path.join(codexHome, 'config.toml'), 0o600);
  assertPrivateMode(path.join(codexHome, 'auth.json'), 0o600);
  assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), '{"synthetic":true}\n');
});

test('F-002 auth preparation rejects symlink, directory, oversized, and unsafe-mode sources', async (t) => {
  for (const kind of ['symlink', 'directory', 'oversized', 'unsafe-mode']) {
    await t.test(kind, async (t) => {
      const { tmp, sourceHome, workspaceDir, env } = fixture(t, kind);
      const authPath = path.join(sourceHome, 'auth.json');
      if (kind === 'symlink') {
        const target = path.join(tmp, 'synthetic-auth-target.json');
        fs.writeFileSync(target, '{}', { mode: 0o600 });
        fs.symlinkSync(target, authPath);
      } else if (kind === 'directory') {
        fs.mkdirSync(authPath);
      } else if (kind === 'oversized') {
        fs.writeFileSync(authPath, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
      } else {
        fs.writeFileSync(authPath, '{}', { mode: 0o644 });
      }

      await assert.rejects(
        prepareCodexLaunchEnvironment({ workspaceDir, env }),
        /invalid|safe|symbolic|regular|permission/i
      );
      assert.equal(fs.existsSync(path.join(workspaceDir, 'codex-home')), false);
    });
  }
});

test('F-002 auth FIFO with no writer fails bounded and leaves no private launch home', (t) => {
  const { sourceHome, workspaceDir } = fixture(t, 'fifo');
  const authPath = path.join(sourceHome, 'auth.json');
  const mkfifo = spawnSync('mkfifo', [authPath], { encoding: 'utf8' });
  if (mkfifo.error || mkfifo.status !== 0) {
    t.skip('mkfifo is unavailable on this platform');
    return;
  }

  const script = `
    import fs from 'node:fs';
    import { prepareCodexLaunchEnvironment } from ${JSON.stringify(launchModuleUrl)};
    const workspaceDir = ${JSON.stringify(workspaceDir)};
    const startedAt = Date.now();
    try {
      await prepareCodexLaunchEnvironment({
        workspaceDir,
        env: { CODEX_HOME: ${JSON.stringify(sourceHome)} }
      });
      process.stdout.write(JSON.stringify({ status: 'accepted', elapsedMs: Date.now() - startedAt }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        status: 'rejected',
        elapsedMs: Date.now() - startedAt,
        launchHomeExists: fs.existsSync(workspaceDir + '/codex-home'),
        message: error.message
      }));
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 1000
  });

  assert.equal(child.error, undefined, 'preparation must reject without an external harness kill');
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'rejected');
  assert.ok(result.elapsedMs < 500, `FIFO rejection took ${result.elapsedMs}ms`);
  assert.equal(result.launchHomeExists, false);
  assert.match(result.message, /invalid|regular/i);
});

test('F-002 unavailable no-follow or nonblocking flags fail closed before launch-home creation', async (t) => {
  for (const missingFlag of ['O_NOFOLLOW', 'O_NONBLOCK']) {
    await t.test(missingFlag, async (t) => {
      const { sourceHome, workspaceDir, env } = fixture(t, missingFlag.toLowerCase());
      fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{}', { mode: 0o600 });
      const constants = { ...fs.constants, [missingFlag]: undefined };
      await assert.rejects(
        prepareCodexLaunchEnvironment({ workspaceDir, env, fsConstantsImpl: constants }),
        /safe.*unavailable|unavailable.*safe|no-follow|nonblocking/i
      );
      assert.equal(fs.existsSync(path.join(workspaceDir, 'codex-home')), false);
    });
  }
});
