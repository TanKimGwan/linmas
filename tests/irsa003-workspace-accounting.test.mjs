import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { repositoryRoot, getLinuxTools, createFixture, cleanup, fileIdentity, writePolicy, linuxOnlyTest as test } from './helpers/irsa003-fixture.mjs';
import { pythonPhasePublication, waitForPhase } from './helpers/irsa003-phase.mjs';

for (const name of ['disappearance', 'finite-churn', 'persistent-churn', 'stable-bounds',
  'excess-before-disappearance', 'other-errors', 'scope-and-root-errors',
  'directory-replacement', 'nested-git-cleanup', 'scan-and-operation-deadlines', 'cancellation-descriptor-cleanup']) {
  test(`production workspace accounting: ${name}`, () => {
    const output = execFileSync(getLinuxTools().pythonPath, ['-B', '-I', '-E',
      path.join(repositoryRoot, 'tests/helpers/workspace-accounting-cases.py'),
      path.join(repositoryRoot, 'scripts/irsa003-trusted-launch.py'), name],
    { encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    assert.deepEqual(JSON.parse(output), { case: name, status: 'PASS' });
  });
}

test('cancellation inside workspace scan fails without output and cleans the full operation', { timeout: 20000 }, async t => {
  const f = createFixture('clean');
  t.after(() => cleanup(f));
  const ready = path.join(f.root, 'accounting-phase.json');
  const expected = { phase: 'workspace-accounting', requestId: f.policy.request.id, pidCount: 0 };
  const publication = pythonPhasePublication(ready, expected.phase, expected.requestId);
  const original = fs.readFileSync(f.launcherPath, 'utf8');
  const anchor = '                    item = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)';
  assert(original.includes(anchor));
  fs.chmodSync(f.launcherPath, 0o700);
  fs.writeFileSync(f.launcherPath, original.replace(anchor,
    publication.split('\n').map(line => '                    ' + line).join('\n')
    + '\n                    time.sleep(60)\n' + anchor));
  fs.chmodSync(f.launcherPath, 0o500);
  f.policy.launcher = fileIdentity(f.launcherPath);
  writePolicy(f, f.policy);
  const child = spawn(f.bootstrapPath, ['--mode', 'clean'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const completed = once(child, 'exit');
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await waitForPhase(ready, child, expected);
  child.kill('SIGTERM');
  assert.equal((await completed)[0], 143, stderr);
  assert.equal(stdout, '');
  assert.deepEqual(fs.readdirSync(f.outputRoot), []);
  assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
});
