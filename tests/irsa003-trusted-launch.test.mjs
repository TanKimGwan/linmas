import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createFixture, cleanup, runBoundary, runGit, writePolicy, sha256, getLinuxTools, linuxOnlyTest as test } from './helpers/irsa003-fixture.mjs';

test('static bootstrap clears native loader inputs before Python and clean request is synchronously consumed', (t) => {
  const fixture = createFixture('clean');
  t.after(() => cleanup(fixture));
  const marker = path.join(fixture.root, 'loader-ran');
  const source = path.join(fixture.root, 'loader.c');
  const library = path.join(fixture.root, 'loader.so');
  fs.writeFileSync(source, `#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void run(void){int f=open(${JSON.stringify(marker)},O_WRONLY|O_CREAT|O_APPEND,0600);if(f>=0){write(f,"ran\\n",4);close(f);}}\n`);
  execFileSync('cc', ['-shared', '-fPIC', '-o', library, source]);

  const result = runBoundary(fixture, 'clean', { LD_PRELOAD: library, LD_LIBRARY_PATH: fixture.root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false, 'a dynamic-loader constructor must not execute before Python');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'PASS');
  assert.equal(summary.consumption.result, 'ACCEPTED');
  const payload = JSON.parse(fs.readFileSync(path.join(fixture.outputRoot, `${fixture.policy.request.id}.json`), 'utf8'));
  assert.equal(payload.attestation.attestationKind, 'irsa003-clean-acceptance-v2');
  assert.equal(payload.attestation.worker.uid, 65534);
  assert.equal(payload.attestation.worker.candidateWritable, false);
  assert.equal(payload.attestation.bindings.acceptance.sha256, sha256(fs.readFileSync(fixture.acceptancePath)));
  assert.equal(payload.attestation.bindings.artifacts.package.sha256, fixture.policy.request.acceptance ? JSON.parse(fs.readFileSync(fixture.acceptancePath)).artifactBinding.package.sha256 : null);
});

test('candidate-controlled producer and validator bytes are not executed; collection is diagnostic', (t) => {
  const fixture = createFixture('collect');
  t.after(() => cleanup(fixture));
  const result = runBoundary(fixture);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.recordCount, 23);
  const payload = JSON.parse(fs.readFileSync(path.join(fixture.outputRoot, `${fixture.policy.request.id}.json`), 'utf8'));
  assert.equal(payload.attestation.attestationKind, 'irsa003-collection-diagnostic-v2');
  assert.equal(payload.attestation.bindings, null);
  assert.equal(payload.attestation.result.disposition.records.every((record) => record.recordId.startsWith('TRUSTED-')), true);
  assert.equal(Object.values(payload.attestation.result.writeDenied).every(Boolean), true);
  assert.equal(fs.existsSync(path.join(fixture.outputRoot, `${fixture.policy.request.id}.consumed`)), false);
});

test('unapproved revision and all dirty Git states reject before clean verification', async (t) => {
  for (const kind of ['unapproved', 'unstaged', 'staged', 'untracked']) {
    await t.test(kind, (child) => {
      const fixture = createFixture('clean');
      child.after(() => cleanup(fixture));
      if (kind === 'unapproved') {
        runGit(fixture.candidateRoot, ['commit', '--allow-empty', '-q', '-m', 'not authorized']);
      } else if (kind === 'unstaged') {
        fs.appendFileSync(path.join(fixture.candidateRoot, 'README.md'), 'changed\n');
      } else if (kind === 'staged') {
        fs.appendFileSync(path.join(fixture.candidateRoot, 'README.md'), 'changed\n');
        runGit(fixture.candidateRoot, ['add', 'README.md']);
      } else {
        fs.writeFileSync(path.join(fixture.candidateRoot, 'untracked.txt'), 'untracked\n');
      }
      const result = runBoundary(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /authorized revision|clean candidate/);
      assert.equal(fs.existsSync(path.join(fixture.outputRoot, `${fixture.policy.request.id}.json`)), false);
    });
  }
});

test('modified trusted verifier and unsafe worker identities fail closed', async (t) => {
  await t.test('modified verifier', (child) => {
    const fixture = createFixture('collect');
    child.after(() => cleanup(fixture));
    fs.appendFileSync(path.join(fixture.verifierRoot, 'collect.mjs'), '\n');
    const result = runBoundary(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /trusted verifier inventory/);
  });
  for (const workerUid of [0, process.getuid()]) {
    await t.test(`worker uid ${workerUid}`, (child) => {
      const fixture = createFixture('collect');
      child.after(() => cleanup(fixture));
      fixture.policy.workerUid = workerUid;
      writePolicy(fixture, fixture.policy);
      const result = runBoundary(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /worker identity/);
    });
  }
  await t.test('writable trust ancestor', (child) => {
    const fixture = createFixture('collect');
    child.after(() => {
      fs.chmodSync(fixture.root, 0o700);
      cleanup(fixture);
    });
    fs.chmodSync(fixture.root, 0o777);
    const result = runBoundary(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ancestor ownership\/writeability is unsafe/);
  });
});

test('protected output is create-only and clean consumer rejects replay and substitution', async (t) => {
  await t.test('pre-existing output', (child) => {
    const fixture = createFixture('collect');
    child.after(() => cleanup(fixture));
    fs.writeFileSync(path.join(fixture.outputRoot, `${fixture.policy.request.id}.json`), '{}\n');
    const result = runBoundary(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /File exists/);
  });

  const fixture = createFixture('clean');
  t.after(() => cleanup(fixture));
  const accepted = runBoundary(fixture);
  assert.equal(accepted.status, 0, accepted.stderr);
  const replay = runBoundary(fixture, 'consume');
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /File exists/);

  const outputPath = path.join(fixture.outputRoot, `${fixture.policy.request.id}.json`);
  const markerPath = path.join(fixture.outputRoot, `${fixture.policy.request.id}.consumed`);
  fs.rmSync(markerPath);
  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  payload.attestation.attestationKind = 'irsa003-collection-diagnostic-v2';
  fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`);
  fs.chmodSync(outputPath, 0o600);
  const substituted = runBoundary(fixture, 'consume');
  assert.notEqual(substituted.status, 0);
  assert.match(substituted.stderr, /wrong-kind/);
});

test('clean consumer rejects missing, stale, unrelated, and result-substituted attestations', async (t) => {
  const cases = [
    ['missing binding', (value) => { delete value.attestation.bindings; }, /schema is not exact/],
    ['stale timestamp', (value) => { value.attestation.createdAt = '2000-01-01T00:00:00+00:00'; }, /stale attestation/],
    ['unrelated request', (value) => { value.attestation.request.id = 'request-unrelated-00000000'; }, /unrelated request/],
    ['substituted toolchain', (value) => { value.attestation.node.sha256 = '0'.repeat(64); }, /substituted node identity/],
    ['substituted acceptance', (value) => { value.attestation.bindings.acceptance.sha256 = '0'.repeat(64); }, /substituted acceptance bytes/],
    ['unrelated artifact root', (value) => { value.attestation.artifactRoot = '/tmp/unrelated-artifacts'; }, /unrelated candidate or artifact root/],
    ['substituted result', (value) => { value.attestation.result.valid = false; }, /substituted verifier result/]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, (child) => {
      const fixture = createFixture('clean');
      child.after(() => cleanup(fixture));
      const accepted = runBoundary(fixture);
      assert.equal(accepted.status, 0, accepted.stderr);
      const outputPath = path.join(fixture.outputRoot, `${fixture.policy.request.id}.json`);
      fs.rmSync(path.join(fixture.outputRoot, `${fixture.policy.request.id}.consumed`));
      const value = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      mutate(value);
      fs.writeFileSync(outputPath, `${JSON.stringify(value)}\n`);
      fs.chmodSync(outputPath, 0o600);
      const result = runBoundary(fixture, 'consume');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    });
  }
});

test('direct Python invocation and unsupported request mode fail closed', (t) => {
  const fixture = createFixture('collect');
  t.after(() => cleanup(fixture));
  const direct = spawnSync(getLinuxTools().pythonPath, ['-I', '-E', fixture.launcherPath, '--bootstrap-parent-pid', String(process.pid), '--mode', 'collect'], {
    env: { ...process.env },
    encoding: 'utf8'
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /static bootstrap environment|parent/);

  const wrongMode = runBoundary(fixture, 'clean');
  assert.notEqual(wrongMode.status, 0);
  assert.match(wrongMode.stderr, /authorized request mode/);
});
