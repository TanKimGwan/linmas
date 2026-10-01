import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectReleaseState,
  validateReleaseRequest
} from '../scripts/validate-release-request.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'TanKimGwan/linmas';

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

function readWorkflow(relativePath) {
  return normalizeNewlines(fs.readFileSync(path.join(rootDir, '.github/workflows', relativePath), 'utf8'));
}

function curlResult(body, httpStatus = 200, effectiveUrl = 'https://registry.npmjs.org/linmas') {
  return {
    status: 0,
    stdout: `${JSON.stringify(body)}\n__LINMAS_HTTP_STATUS__:${httpStatus}\n__LINMAS_EFFECTIVE_URL__:${effectiveUrl}\n`,
    stderr: ''
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createFixture(version = '0.8.1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-release-auth-'));
  writeJson(path.join(dir, 'package.json'), { name: 'linmas', version });
  writeJson(path.join(dir, 'package-lock.json'), {
    name: 'linmas',
    version,
    lockfileVersion: 3,
    packages: { '': { name: 'linmas', version } }
  });
  writeJson(path.join(dir, 'plugins/linmas/package.json'), { name: 'linmas', version });
  writeJson(path.join(dir, 'plugins/linmas/.codex-plugin/plugin.json'), { name: 'linmas', version });
  fs.mkdirSync(path.join(dir, 'releases'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'releases', `${version}.md`), `# Linmas ${version}\n\nSynthetic release notes.\n`, 'utf8');

  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'release fixture'], { cwd: dir, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, sha, version };
}

function absentState() {
  return {
    tag: { localExists: false, remoteExists: false, commit: null },
    npmPublished: false,
    githubReleaseExists: false
  };
}

function validate(fixture, overrides = {}) {
  const requestedVersion = overrides.version || fixture.version;
  return validateReleaseRequest({
    phase: 'prepare',
    version: fixture.version,
    targetSha: fixture.sha,
    mainRef: 'main',
    repository,
    checkoutRole: 'target',
    rootDir: fixture.dir,
    releaseState: absentState(),
    artifactFilename: `linmas-${requestedVersion}.tgz`,
    artifactSha256: 'a'.repeat(64),
    artifactBytes: 100,
    artifactEntries: 1,
    artifactInventorySha256: 'b'.repeat(64),
    ...overrides
  });
}

test('normal main pushes cannot trigger either release workflow', () => {
  for (const workflow of ['tag-release.yml', 'release.yml']) {
    const text = readWorkflow(workflow);
    assert.doesNotMatch(text, /^\s{2}push:/m, `${workflow} must not have a push trigger`);
    assert.match(text, /^\s{2}workflow_dispatch:/m);
  }
});

test('explicit dispatch exposes required version and target authorization inputs', () => {
  const tagWorkflow = readWorkflow('tag-release.yml');
  const releaseWorkflow = readWorkflow('release.yml');
  assert.match(tagWorkflow, /version:\s*\n\s+description:[^\n]*\n\s+required:\s*true\n\s+type:\s*string/);
  assert.match(tagWorkflow, /target_sha:\s*\n\s+description:[^\n]*\n\s+required:\s*true\n\s+type:\s*string/);
  assert.match(releaseWorkflow, /tag:\s*\n\s+description:[^\n]*\n\s+required:\s*true\n\s+type:\s*string/);
  assert.match(releaseWorkflow, /target_sha:\s*\n\s+description:[^\n]*\n\s+required:\s*true\n\s+type:\s*string/);
  assert.ok(tagWorkflow.indexOf('--phase prepare') < tagWorkflow.indexOf('git tag -a'));
  assert.ok(releaseWorkflow.indexOf('--phase publish') < releaseWorkflow.indexOf('npm publish'));
  assert.match(tagWorkflow, /--phase prepare[\s\S]*--checkout-role target/);
  assert.match(releaseWorkflow, /--phase publish[\s\S]*--checkout-role target/);
  assert.match(releaseWorkflow, /Recheck static authorization and collisions[\s\S]*registry-result\.mjs/);
  assert.doesNotMatch(releaseWorkflow, /npm view|NPM_DIAGNOSTIC|is not in this registry|grep.*E404/);
  assert.match(releaseWorkflow, /ref:\s*\$\{\{ github\.workflow_sha \}\}[\s\S]*path:\s*\.trusted-workflow-controls/);
  assert.match(releaseWorkflow, /git -C "\$TRUSTED_CONTROLS" rev-parse HEAD[\s\S]*\$WORKFLOW_SHA/);
  assert.match(releaseWorkflow, /node "\$TRUSTED_CONTROLS\/scripts\/registry-result\.mjs" --version "\$VERSION"/);
  assert.doesNotMatch(releaseWorkflow, /RESPONSE_FILE|__LINMAS_HTTP_STATUS__|url_effective|const match = \/\\n__LINMAS_HTTP_STATUS__/);
  assert.match(releaseWorkflow, /gh release create "\$RELEASE_TAG" "\$RUNNER_TEMP\/release-package\/\$ARTIFACT_FILE"[\s\S]*--verify-tag/);
  assert.doesNotMatch(releaseWorkflow, /softprops\/action-gh-release|gh release (?:edit|upload)/);
  assert.match(releaseWorkflow, /npm publish "\$RUNNER_TEMP\/release-package\/\$ARTIFACT_FILE" --access public --ignore-scripts/);
  assert.ok(releaseWorkflow.indexOf('Verify the target checkout stayed clean') < releaseWorkflow.indexOf('npm publish'));
});

test('both release test jobs use the qualified Linux runtime and sandbox before npm test', () => {
  const ciWorkflow = readWorkflow('ci.yml');
  const setupStart = ciWorkflow.indexOf('      - name: Prepare private trusted Node runtime for Linux tests\n');
  const setupEnd = ciWorkflow.indexOf('      - run: npm ci\n', setupStart);
  assert.ok(setupStart >= 0 && setupEnd > setupStart, 'qualified CI setup must be available');
  const qualifiedSetup = ciWorkflow.slice(setupStart, setupEnd);
  assert.match(qualifiedSetup, /readonly bwrap_version='0\.12\.0'/);
  assert.match(qualifiedSetup, /readonly bwrap_sha256='9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314'/);
  for (const name of [
    'Prepare private trusted Node runtime for Linux tests',
    'Build pinned upstream bubblewrap sandbox',
    'Verify propagated pinned bubblewrap sandbox',
    'Verify required Linux bubblewrap namespaces'
  ]) {
    assert.ok(qualifiedSetup.includes(`      - name: ${name}\n`), `qualified setup includes ${name}`);
  }
  for (const flag of ['--unshare-all', '--unshare-user', '--disable-userns', '--cap-drop ALL']) {
    assert.ok(qualifiedSetup.includes(flag), `qualified preflight retains ${flag}`);
  }
  for (const [workflow, job, nextJob] of [
    ['tag-release.yml', 'authorize', 'tag'],
    ['release.yml', 'build', 'publish']
  ]) {
    const text = readWorkflow(workflow);
    const jobStart = text.indexOf(`  ${job}:\n`);
    const jobEnd = text.indexOf(`\n  ${nextJob}:\n`, jobStart);
    assert.ok(jobStart >= 0 && jobEnd > jobStart, `${workflow} test job must be scoped`);
    const jobText = text.slice(jobStart, jobEnd);
    assert.match(jobText, /^    runs-on: ubuntu-22\.04$/m);
    assert.match(jobText, /node-version: 24/);
    const setupIndex = jobText.indexOf(qualifiedSetup);
    assert.ok(setupIndex >= 0, `${workflow} must retain every qualified setup command and guard`);
    const testIndex = jobText.indexOf('npm test --ignore-scripts');
    assert.ok(testIndex >= setupIndex + qualifiedSetup.length, `${workflow} setup must finish before npm test`);
  }
});

test('workflow text normalization accepts CRLF checkout content', () => {
  assert.equal(normalizeNewlines('workflow_dispatch:\r\n  inputs:\r\n'), 'workflow_dispatch:\n  inputs:\n');
});

test('dry-run validation accepts an exact current-main release without creating a tag', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const before = execFileSync('git', ['tag', '--list'], { cwd: fixture.dir, encoding: 'utf8' });

  const result = validate(fixture);

  assert.equal(result.ready, true);
  assert.equal(result.tag, `v${fixture.version}`);
  assert.equal(result.targetSha, fixture.sha);
  assert.equal(result.versionSurfaces.length, 5);
  assert.equal(execFileSync('git', ['tag', '--list'], { cwd: fixture.dir, encoding: 'utf8' }), before);
});

test('malformed release version fails before tag or publication mutation', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  assert.throws(() => validate(fixture, { version: '01.2.3' }), /requested version must be a strict release SemVer/);
  assert.equal(execFileSync('git', ['tag', '--list'], { cwd: fixture.dir, encoding: 'utf8' }).trim(), '');
});

test('release authorization rejects unstaged, staged, and untracked checkout changes', (t) => {
  const unstaged = createFixture();
  t.after(() => fs.rmSync(unstaged.dir, { recursive: true, force: true }));
  fs.appendFileSync(path.join(unstaged.dir, 'releases', `${unstaged.version}.md`), 'unstaged\n');
  assert.throws(() => validate(unstaged), /unstaged changes/);

  const staged = createFixture();
  t.after(() => fs.rmSync(staged.dir, { recursive: true, force: true }));
  fs.appendFileSync(path.join(staged.dir, 'releases', `${staged.version}.md`), 'staged\n');
  execFileSync('git', ['add', 'releases'], { cwd: staged.dir, stdio: 'ignore' });
  assert.throws(() => validate(staged), /staged changes/);

  const untracked = createFixture();
  t.after(() => fs.rmSync(untracked.dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(untracked.dir, 'unexpected-release-input.txt'), 'untracked\n', 'utf8');
  assert.throws(() => validate(untracked), /untracked changes/);
});

test('release authorization requires exact artifact authorization fields', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  assert.throws(() => validate(fixture, { artifactFilename: 'linmas-other.tgz' }), /artifact filename/);
  assert.throws(() => validate(fixture, { artifactBytes: 0 }), /artifact byte count/);
  assert.throws(() => validate(fixture, { artifactSha256: 'not-a-digest' }), /artifact SHA-256/);
});

test('requested version mismatch fails against the five canonical version surfaces', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  assert.throws(() => validate(fixture, { version: '0.8.2' }), /requested version does not match the canonical package version/);
});

test('prepare requires the target checkout role and rejects an unsafe ref or repository', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  assert.throws(() => validate(fixture, { checkoutRole: 'main' }), /prepare phase requires target checkout role/);
  assert.throws(() => validate(fixture, { mainRef: '$(touch pwned)' }), /main ref is invalid/);
  assert.throws(() => validate(fixture, { repository: 'owner/$(touch pwned)' }), /repository must use the owner\/name form/);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'pwned')), false);
});

test('existing tag, npm version, and GitHub release are a no-mutation collision', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  execFileSync('git', ['tag', `v${fixture.version}`], { cwd: fixture.dir });
  const before = execFileSync('git', ['show-ref', '--tags'], { cwd: fixture.dir, encoding: 'utf8' });

  assert.throws(() => validate(fixture, {
    releaseState: {
      tag: { localExists: true, remoteExists: true, commit: fixture.sha },
      npmPublished: true,
      githubReleaseExists: true
    }
  }), /release collision: release tag already exists, npm version already exists, GitHub release already exists/);
  assert.equal(execFileSync('git', ['show-ref', '--tags'], { cwd: fixture.dir, encoding: 'utf8' }), before);
});

test('commit outside main is rejected even when every release surface is available', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: fixture.dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(fixture.dir, 'feature.txt'), 'outside main\n', 'utf8');
  execFileSync('git', ['add', 'feature.txt'], { cwd: fixture.dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'feature'], { cwd: fixture.dir, stdio: 'ignore' });
  const featureSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.dir, encoding: 'utf8' }).trim();

  assert.throws(() => validate(fixture, { targetSha: featureSha }), /target SHA is not reachable from main/);
});

test('tag preparation rejects an older main commit but publication can finish an authorized ancestor', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.dir, 'post-authorization.txt'), 'main advanced\n', 'utf8');
  execFileSync('git', ['add', 'post-authorization.txt'], { cwd: fixture.dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'advance main'], { cwd: fixture.dir, stdio: 'ignore' });

  assert.throws(() => validate(fixture), /target SHA must be the exact current main commit/);
  const result = validate(fixture, {
    phase: 'publish',
    checkoutRole: 'main',
    releaseState: {
      tag: { localExists: true, remoteExists: true, commit: fixture.sha },
      npmPublished: false,
      githubReleaseExists: false
    }
  });
  assert.equal(result.targetSha, fixture.sha);
});

test('validation rejects a stale checkout even when target and main refs are valid', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.dir, 'advanced.txt'), 'advanced\n', 'utf8');
  execFileSync('git', ['add', 'advanced.txt'], { cwd: fixture.dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'advance'], { cwd: fixture.dir, stdio: 'ignore' });
  const currentMain = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['checkout', '--detach', fixture.sha], { cwd: fixture.dir, stdio: 'ignore' });

  assert.throws(() => validate(fixture, {
    phase: 'publish',
    targetSha: fixture.sha,
    checkoutRole: 'main',
    releaseState: {
      tag: { localExists: true, remoteExists: true, commit: fixture.sha },
      npmPublished: false,
      githubReleaseExists: false
    }
  }), /working tree HEAD does not match the authorized main commit/);
  assert.notEqual(currentMain, fixture.sha);
});

test('publication validation requires the authorized remote tag and rejects collisions', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  assert.throws(() => validate(fixture, { phase: 'publish' }), /release tag must exist both locally and remotely/);
  const result = validate(fixture, {
    phase: 'publish',
    releaseState: {
      tag: { localExists: true, remoteExists: true, commit: fixture.sha },
      npmPublished: false,
      githubReleaseExists: false
    }
  });
  assert.equal(result.availability.tag, 'authorized-existing');
});

test('availability inspection accepts a structured exact-package absence response', () => {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'ls-remote') return { status: 2, stdout: '', stderr: '' };
    if (command === 'curl') return curlResult({ name: 'linmas', versions: {} }, 200);
    if (command === 'gh') return { status: 1, stdout: '', stderr: 'release not found' };
    throw new Error('unexpected command');
  };
  const state = inspectReleaseState({ rootDir, repository, tag: 'v9.9.9', version: '9.9.9', runCommand });
  assert.equal(state.npmPublished, false);
  assert.equal(calls.some(([command]) => command === 'npm'), false);
  assert.equal(calls.some(([command]) => command === 'curl'), true);
});

test('availability inspection accepts a structured exact-version publication response', () => {
  const runCommand = (command, args) => {
    if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'ls-remote') return { status: 2, stdout: '', stderr: '' };
    if (command === 'curl') return curlResult({ name: 'linmas', versions: { '9.9.9': { name: 'linmas', version: '9.9.9' } } }, 200);
    if (command === 'gh') return { status: 1, stdout: '', stderr: 'release not found' };
    throw new Error('unexpected command');
  };
  const state = inspectReleaseState({ rootDir, repository, tag: 'v9.9.9', version: '9.9.9', runCommand });
  assert.equal(state.npmPublished, true);
});

test('availability inspection fails closed on an indeterminate npm response', () => {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'ls-remote') return { status: 2, stdout: '', stderr: '' };
    if (command === 'curl') return { status: 28, stdout: '', stderr: 'synthetic network failure' };
    throw new Error('unexpected command');
  };

  assert.throws(() => inspectReleaseState({ rootDir, repository, tag: 'v9.9.9', version: '9.9.9', runCommand }), /npm release-version availability check failed/);
  assert.equal(calls.some(([command]) => command === 'gh'), false);
});

test('generic GitHub 404 is not mistaken for an available release name', () => {
  const runCommand = (command, args) => {
    if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'ls-remote') return { status: 2, stdout: '', stderr: '' };
    if (command === 'curl') return curlResult({ error: 'Not Found' }, 404);
    if (command === 'gh') return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    throw new Error('unexpected command');
  };

  assert.throws(() => inspectReleaseState({ rootDir, repository, tag: 'v9.9.9', version: '9.9.9', runCommand }), /GitHub release availability check failed/);
});

test('generic npm proxy 404 is not mistaken for an available version', () => {
  const runCommand = (command, args) => {
    if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'ls-remote') return { status: 2, stdout: '', stderr: '' };
    if (command === 'curl') return curlResult({ error: 'proxy gateway response' }, 404);
    throw new Error('unexpected command');
  };

  assert.throws(() => inspectReleaseState({ rootDir, repository, tag: 'v9.9.9', version: '9.9.9', runCommand }), /npm release-version availability check failed/);
});

test('privileged tag and publish checks use one authenticated workflow-source registry parser', () => {
  const tagWorkflow = readWorkflow('tag-release.yml');
  const releaseWorkflow = readWorkflow('release.yml');

  assert.match(tagWorkflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(tagWorkflow, /WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(tagWorkflow, /git rev-parse HEAD\)" == "\$WORKFLOW_SHA"/);
  assert.match(tagWorkflow, /node "\$GITHUB_WORKSPACE\/scripts\/registry-result\.mjs" --version "\$REQUESTED_VERSION"/);
  assert.doesNotMatch(tagWorkflow, /RESPONSE_FILE|__LINMAS_HTTP_STATUS__|url_effective|const match = \/\\n__LINMAS_HTTP_STATUS__/);

  assert.match(releaseWorkflow, /path: \.trusted-workflow-controls/);
  assert.match(releaseWorkflow, /WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(releaseWorkflow, /node "\$TRUSTED_CONTROLS\/scripts\/registry-result\.mjs" --version "\$VERSION"/);
  assert.doesNotMatch(releaseWorkflow, /RESPONSE_FILE|__LINMAS_HTTP_STATUS__|url_effective|const match = \/\\n__LINMAS_HTTP_STATUS__/);
});
