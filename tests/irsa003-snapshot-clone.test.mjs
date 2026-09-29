import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { repositoryRoot, createFixture, cleanup, runBoundary, fileIdentity, writePolicy, pythonPath } from './helpers/irsa003-fixture.mjs';
import { pythonPhasePublication, waitForPhase } from './helpers/irsa003-phase.mjs';

for (const [name, value] of [
  ['real pack resource failure is corrected by policy reaching both helpers', 'bounded-comparison'],
  ['snapshot uses the exact quoted trusted Git path and excludes caller config', 'quoted-git-path']
]) test(name, { timeout: 30000 }, () => {
  const result = spawnSync(pythonPath, ['-B', '-I', '-E', path.join(repositoryRoot, 'tests/helpers/snapshot-clone-cases.py'), value], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp' },
    encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  if (value === 'bounded-comparison') {
    const negative = payload.negativeEvidence;
    assert.equal(negative.classification, 'intended-actual-git-resource-failure');
    assert.match(negative.outerError.message, /^trusted snapshot clone failed:/);
    assert.equal(negative.directChildren.length, 1);
    const [child] = negative.directChildren;
    assert.equal(child.returnCode, 128);
    assert.deepEqual(child.pipesClosedAfterReturn, { stdout: true, stderr: true });
    assert.deepEqual(child.pipeFdsClosedAfterReturn, { stdout: true, stderr: true });
    assert.equal(child.pidExistsAfterReturn, false);
    assert.deepEqual(child.processGroupPidsRemainingAfterReturn, []);
    assert.deepEqual(child.effectiveRlimits.AS, [64 * 1024 * 1024, 64 * 1024 * 1024]);
    const operationRoot = child.environment.TMPDIR;
    assert.equal(child.environment.HOME, operationRoot);
    assert.equal(child.environment.TMP, operationRoot);
    assert.equal(child.environment.TEMP, operationRoot);
    assert.equal(child.environment.XDG_CONFIG_HOME, operationRoot);
    assert.equal(child.environment.XDG_CACHE_HOME, operationRoot);
    assert.equal(child.environment.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(child.environment.GIT_CONFIG_GLOBAL, '/dev/null');
    assert(path.basename(path.dirname(child.argv.at(-2))).startsWith('lsi003-source-'));
    assert(!child.argv.at(-2).startsWith(`${operationRoot}/`));
    assert(child.argv.at(-1).startsWith(`${operationRoot}/`));
    assert(child.argv.at(-1).endsWith('/negative-clone/.'));
    assert.match(child.stderrText, /unable to create thread/);
    assert.match(child.stderrText, /Resource temporarily unavailable/);
    assert.equal(child.stderrSha256.length, 64);
    assert(negative.workspaceScans.length > 0);
    assert(negative.workspaceScans.every(scan => scan.result === 'complete'));
    assert.equal(negative.sourceReadOnlyOutsideDiskRoot, true);
    assert.equal(negative.sourceUnchanged, true);
    assert.equal(negative.destinationRetainedEmpty, true);
    assert.equal(payload.correctedSnapshot.exactSourceBytes, true);
    assert.equal(payload.correctedSnapshot.clean, true);
    assert(payload.correctedSnapshot.archive.bytes > 8 * 1024 * 1024);
    assert.deepEqual(payload.correctedSnapshot.sharedHardlinks, []);
    assert.equal(payload.correctedSnapshot.noAlternates, true);
    assert(payload.correctedSnapshot.gitChildren.length > 0);
    assert(payload.correctedSnapshot.gitChildren.every(child => child.returnCode === 0));
    assert(payload.correctedSnapshot.gitChildren.every(child => child.pipesClosedAfterReturn.stdout && child.pipesClosedAfterReturn.stderr));
    assert(payload.correctedSnapshot.gitChildren.every(child => child.pipeFdsClosedAfterReturn.stdout && child.pipeFdsClosedAfterReturn.stderr));
    assert(payload.correctedSnapshot.gitChildren.every(child => child.pidExistsAfterReturn === false));
    assert(payload.correctedSnapshot.gitChildren.every(child => child.processGroupPidsRemainingAfterReturn.length === 0));
    for (const role of ['clone', 'upload-pack', 'pack-objects', 'index-pack']) {
      assert(payload.correctedSnapshot.helperPolicy[role].some(parameter => parameter.scope === 'command' && String(parameter.value) === '1'), role);
    }
  }
});

test('workspace guard rejection cannot satisfy the real-Git negative control', { timeout: 15000 }, () => {
  const result = spawnSync(pythonPath, ['-B', '-I', '-E', path.join(repositoryRoot, 'tests/helpers/snapshot-clone-cases.py'), 'guard-rejection-control'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp' },
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.classification, 'workspace-guard-rejection');
  assert.equal(payload.acceptedAsIntendedGitFailure, false);
  assert(payload.outerError.message.startsWith('workspace accounting'));
  assert.equal(payload.directChildren.length, 1);
  assert.notEqual(payload.directChildren[0].returnCode, 128);
  assert.equal(payload.directChildren[0].stderrText, '');
  assert.equal(payload.workspaceScans.length, 1);
  assert.equal(payload.workspaceScans[0].result, 'error');
});

function patchLauncher(f, transform) {
  fs.chmodSync(f.launcherPath, 0o700);
  fs.writeFileSync(f.launcherPath, transform(fs.readFileSync(f.launcherPath, 'utf8')));
  fs.chmodSync(f.launcherPath, 0o500);
  f.policy.launcher = fileIdentity(f.launcherPath);
  writePolicy(f, f.policy);
}

test('genuine clone address-space exhaustion fails closed and cleans operation', { timeout: 15000 }, t => {
  const f = createFixture('clean'); t.after(() => cleanup(f));
  // Lower only this owned fixture's snapshot children. Real Git/loader
  // allocation fails; no synthetic exit code or stderr is substituted.
  patchLauncher(f, source => source.replace('(512 * 1024 * 1024, 512 * 1024 * 1024)', '(8 * 1024 * 1024, 8 * 1024 * 1024)'));
  const result = runBoundary(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /trusted snapshot clone failed/);
  assert.match(result.stderr, /[Mm]emory|[Mm]ap|[Aa]llocat|create thread/);
  assert.deepEqual(fs.readdirSync(f.outputRoot), []);
  assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
});

test('cancellation during actual Git clone reaps upload helper and leaves no acceptance', { timeout: 15000 }, async t => {
  const f = createFixture('clean'); t.after(() => cleanup(f));
  const ready = path.join(f.root, 'clone-ready.json');
  const helper = path.join(f.root, 'owned-upload-helper');
  const publication = pythonPhasePublication(ready, 'snapshot-clone', f.policy.request.id, '[os.getpid(),os.getppid()]');
  fs.writeFileSync(helper, '#!' + pythonPath + '\nimport os,signal\n' + publication + '\nsignal.pause()\n', { mode: 0o500 });
  patchLauncher(f, source => source.replace('upload_pack = f"{shlex.quote(git_path)} -c pack.threads=1 upload-pack"', 'upload_pack = shlex.quote(' + JSON.stringify(helper) + ')'));
  const child = spawn(f.bootstrapPath, ['--mode', 'clean'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const completed = once(child, 'exit'); let stderr = '';
  child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const { pids } = await waitForPhase(ready, child, { phase: 'snapshot-clone', requestId: f.policy.request.id, pidCount: 2 });
  child.kill('SIGTERM');
  assert.equal((await completed)[0], 143, stderr);
  for (const pid of pids) assert(!fs.existsSync(`/proc/${pid}`), `clone descendant remains: ${pid}`);
  assert.deepEqual(fs.readdirSync(f.outputRoot), []);
  assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
});
