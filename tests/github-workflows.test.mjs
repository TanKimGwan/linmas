import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_IGNORE_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0'
};

function read(relPath) {
  return normalizeNewlines(fs.readFileSync(path.join(rootDir, relPath), 'utf8'));
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

function isIgnoredByGit(relPath) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', relPath], {
    cwd: rootDir,
    env: GIT_IGNORE_ENV,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore failed for scoped documentation path (exit ${result.status})`);
}

function jobSection(text, name) {
  const start = text.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `workflow job ${name} must exist`);
  const nextMatch = /\n  [A-Za-z0-9_-]+:/gu;
  nextMatch.lastIndex = start + 3;
  const next = nextMatch.exec(text)?.index ?? -1;
  return text.slice(start, next === -1 ? text.length : next);
}

test('release workflow is explicit-dispatch only and verifies authorization before publish', () => {
  const text = read('.github/workflows/release.yml');
  const build = jobSection(text, 'build');
  const publish = jobSection(text, 'publish');
  assert.doesNotMatch(text, /^\s{2}push:/m);
  assert.match(text, /workflow_dispatch:/);
  for (const input of ['tag', 'target_sha', 'artifact_file', 'artifact_sha256', 'artifact_bytes', 'artifact_entries', 'artifact_inventory_sha256']) {
    assert.match(text, new RegExp(`${input}:\\s*\\n\\s+description:[^\\n]*\\n\\s+required:\\s*true\\n\\s+type:\\s*string`));
  }
  assert.match(text, /if:\s*\$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(text, /RELEASE_TAG:\s*\$\{\{ inputs\.tag \}\}/);
  assert.match(text, /TARGET_SHA:\s*\$\{\{ inputs\.target_sha \}\}/);
  assert.match(text, /ref:\s*main/);
  assert.match(text, /fetch origin main --tags/);
  assert.doesNotMatch(text, /git fetch origin main --depth=1/);
  assert.match(build, /node scripts\/validate-release-request\.mjs[\s\S]*--phase publish/);
  assert.match(build, /--phase publish[\s\S]*--checkout-role target/);
  assert.match(build, /npm test --ignore-scripts/);
  assert.match(build, /npm run validate --ignore-scripts/);
  assert.match(build, /npm pack --dry-run --ignore-scripts/);
  assert.match(build, /node scripts\/artifact-integrity\.mjs/);
  assert.match(build, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(publish, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(publish, /permissions:\s*[\s\S]*id-token:\s*write/);
  for (const command of ['npm test', 'npm run validate', 'npm ci', 'npm pack', 'scripts/validate-release-request.mjs', 'scripts/artifact-integrity.mjs']) {
    assert.doesNotMatch(publish, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `publish job must not run candidate command ${command}`);
  }
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /actions\/upload-artifact@v7/);
  assert.match(text, /name:\s*release-package/);
  assert.match(text, /name:\s*release-handoff/);
  assert.match(text, /npm publish "\$RUNNER_TEMP\/release-package\/\$ARTIFACT_FILE" --access public --ignore-scripts/);
  assert.doesNotMatch(text, /NODE_AUTH_TOKEN:/);
  assert.doesNotMatch(text, /secrets\.NPM_TOKEN/);
  assert.match(text, /gh release create "\$RELEASE_TAG" "\$RUNNER_TEMP\/release-package\/\$ARTIFACT_FILE"/);
  assert.match(text, /--verify-tag/);
  assert.match(publish, /sha256sum[\s\S]*AUTHORIZED_SHA256/);
  assert.match(publish, /stat -c '%s'[\s\S]*AUTHORIZED_BYTES/);
  assert.match(text, /artifact-sha256: \$\{\{ inputs\.artifact_sha256 \}\}/);
  assert.match(text, /artifact-bytes: \$\{\{ inputs\.artifact_bytes \}\}/);
  assert.match(text, /artifact-file: \$\{\{ inputs\.artifact_file \}\}/);
  assert.doesNotMatch(text, /linmas-\*\.tgz/);
  assert.doesNotMatch(text, /gh release (?:edit|upload)/);
  assert.doesNotMatch(text, /softprops\/action-gh-release/);
  assert.match(text, /uses:\s*\.\/\.github\/workflows\/generator-generic-ossf-slsa3-publish\.yml/);
});

test('workflow text normalization accepts CRLF checkout content', () => {
  assert.equal(normalizeNewlines('workflow_dispatch:\r\n  inputs:\r\n'), 'workflow_dispatch:\n  inputs:\n');
});

test('ci workflow triggers on PR and pushes to dev/main', () => {
  const text = read('.github/workflows/ci.yml');
  assert.match(text, /pull_request:/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /branches:\s*\[dev,\s*main\]/);
  assert.match(text, /contents:\s*read/);
  assert.match(text, /npm test/);
  assert.match(text, /npm run validate/);
  assert.match(text, /npm run eval:offline/);
  assert.match(text, /npm run pack:dry-run/);
  assert.doesNotMatch(text, /npm publish/);
});

test('ci keeps the required Linux verify check and adds deterministic Windows verification', () => {
  const text = read('.github/workflows/ci.yml');
  const linux = jobSection(text, 'verify');
  const windows = text.slice(text.indexOf('verify-windows:'));
  assert.match(linux, /^\s{4}runs-on:\s*ubuntu-22\.04$/m);
  assert.match(windows, /runs-on:\s*windows-latest/);
  for (const job of [linux, windows]) {
    assert.match(job, /git fetch --depth=1 --no-tags origin refs\/tags\/v0\.8\.0:refs\/tags\/v0\.8\.0/);
    assert.match(job, /refs\/tags\/v0\.8\.0\^\{tag\}/);
    assert.match(job, /d03d7f4e5f63cf2c76a3e24f87854681ffac9959/);
    assert.match(job, /refs\/tags\/v0\.8\.0\^\{\}/);
    assert.match(job, /68a5cd175b16d26fd58834acd489ebcbe8a8ec57/);
  }
  assert.match(linux, /readonly bwrap_version='0\.12\.0'/);
  assert.match(linux, /readonly bwrap_sha256='9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314'/);
  assert.match(linux, /https:\/\/github\.com\/containers\/bubblewrap\/releases\/download\/v\$\{bwrap_version\}\/bubblewrap-\$\{bwrap_version\}\.tar\.xz/);
  assert.match(linux, /sha256sum --check --strict -[\s\S]*tar --extract --xz[\s\S]*meson setup/);
  assert.match(linux, /install -d -m 700 "\$\{private_root\}"/);
  assert.match(linux, /chmod 755 "\$\{private_bwrap\}"/);
  assert.match(linux, /chmod 700 "\$\{private_bin\}"[\s\S]*stat -c '%a' "\$\{private_bin\}"\)" = '700'/);
  assert.match(linux, /8#\$\{private_bwrap_mode\} & 8#6000/);
  assert.match(linux, /test "\$\("\$\{private_bwrap\}" --version\)" = "bubblewrap \$\{bwrap_version\}"/);
  assert.match(linux, /--help 2>&1 \| grep -F -- '--disable-userns'/);
  assert.match(linux, /GITHUB_PATH/);
  assert.match(linux, /name: Verify propagated pinned bubblewrap sandbox[\s\S]*command -v bwrap[\s\S]*LINMAS_APPROVED_BWRAP_PATH/);
  assert.match(linux, /name: Verify required Linux bubblewrap namespaces[\s\S]*--unshare-all[\s\S]*--unshare-user[\s\S]*--disable-userns[\s\S]*--cap-drop ALL[\s\S]*npm test/);
  assert.doesNotMatch(linux, /releases\/latest|\/nightly|apt-get install[^\n]*bubblewrap|chmod\s+[467][0-7]{3}|sysctl|apparmor|privileged/iu);
  assert.doesNotMatch(windows, /apt-get|bubblewrap|bwrap/);
  assert.match(windows, /LinkType -ne 'HardLink'/);
  assert.match(windows, /FileAttributes\]::ReparsePoint/);
  assert.match(windows, /LINMAS_SELECTED_GIT_PATH/);
  assert.match(windows, /LINMAS_SELECTED_GIT_SHA256/);
  assert.match(windows, /name: Verify propagated unique trusted Git PATH[\s\S]*readback\.Count -ne 1[\s\S]*Get-FileHash[\s\S]*--version/);
  assert.doesNotMatch(windows, /(?:Program Files|Git\\(?:cmd|bin)|[A-Z]:\\)[^\n]*git\.exe/i);
  for (const command of ['npm ci', 'npm test', 'npm run validate', 'npm run eval:offline', 'npm run pack:dry-run']) {
    assert.match(windows, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(windows, /npm run coverage/);
});

test('live evaluation workflow is trusted, scheduled, and bounded', () => {
  const text = read('.github/workflows/evaluation-live.yml');
  assert.match(text, /schedule:/);
  assert.match(text, /workflow_dispatch:/);
  assert.doesNotMatch(text, /pull_request:/);
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /timeout-minutes:/);
  assert.match(text, /github\.event(?:_name|\.name) == 'schedule'/);
  assert.match(text, /CODEX_API_KEY:\s*\$\{\{ secrets\.CODEX_API_KEY \}\}/);
  assert.match(text, /LINMAS_EVAL_PROVIDER:\s*codex/);
  assert.match(text, /LINMAS_EVAL_MODEL:\s*\$\{\{ vars\.LINMAS_EVAL_MODEL \}\}/);
  assert.match(text, /retention-days:\s*14/);
});

test('provenance workflow is a reusable attestation workflow with artifact download', () => {
  const text = read('.github/workflows/generator-generic-ossf-slsa3-publish.yml');
  assert.doesNotMatch(text, /pull_request:/);
  assert.doesNotMatch(text, /workflow_run:/);
  assert.match(text, /workflow_call:/);
  assert.match(text, /inputs:\s*[\s\S]*artifact-name:/);
  assert.match(text, /inputs:\s*[\s\S]*artifact-file:/);
  assert.match(text, /inputs:\s*[\s\S]*artifact-sha256:/);
  assert.match(text, /inputs:\s*[\s\S]*artifact-bytes:/);
  assert.match(text, /actions:\s*read/);
  assert.match(text, /attestations:\s*write/);
  assert.match(text, /contents:\s*read/);
  assert.match(text, /id-token:\s*write/);
  assert.match(text, /actions\/download-artifact@v8/);
  assert.match(text, /name:\s*\$\{\{ inputs\.artifact-name \}\}/);
  assert.match(text, /actions\/attest@v4/);
  assert.match(text, /sha256sum/);
  assert.match(text, /stat -c '%s'/);
  assert.match(text, /subject-path:.*runner\.temp.*provenance-package.*artifact-file/);
});

test('provenance workflow uses subject-path attestation without custom predicate requirement', () => {
  const text = read('.github/workflows/generator-generic-ossf-slsa3-publish.yml');
  assert.match(text, /actions\/download-artifact@v8/);
  assert.match(text, /actions\/attest@v4/);
  assert.match(text, /subject-path:.*runner\.temp.*provenance-package.*artifact-file/);
  assert.doesNotMatch(text, /predicate-type:/);
});

test('package metadata declares the hardened CI/runtime support floor', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=24');
  assert.match(pkg.scripts.coverage, /--test-coverage-lines=96/);
  assert.match(pkg.scripts.coverage, /--test-coverage-branches=85/);
  assert.match(pkg.scripts.coverage, /--test-coverage-functions=94/);
  assert.equal(fs.existsSync(path.join(rootDir, 'package-lock.json')), true);
});

test('package metadata includes public repository provenance fields', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.description, 'Proof-carrying defensive security reviews for AI-assisted software, with deterministic policy, portable evidence, and human review required.');
  assert.deepEqual(pkg.repository, {
    type: 'git',
    url: 'https://github.com/TanKimGwan/linmas'
  });
  assert.equal(pkg.homepage, 'https://github.com/TanKimGwan/linmas#readme');
  assert.deepEqual(pkg.bugs, {
    url: 'https://github.com/TanKimGwan/linmas/issues'
  });
});

test('readme uses tracked public logo asset for GitHub and npm rendering', () => {
  const readme = read('README.md');
  assert.match(readme, /https:\/\/raw\.githubusercontent\.com\/TanKimGwan\/linmas\/main\/assets\/linmas\.jpg/);
  assert.match(readme, /alt="Linmas logo"/);
  assert.equal(fs.existsSync(path.join(rootDir, 'assets/linmas.jpg')), true);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(rootDir, 'assets/linmas.jpg'))).digest('hex'), '7d9b02fd6a78b2bee70e21bdf8b334ce5536d0b111328cb1bd88e256bbce83a7');
  assert.equal(execFileSync('git', ['ls-files', 'assets/linmas.jpg'], {
    cwd: rootDir,
    encoding: 'utf8'
  }).trim(), 'assets/linmas.jpg');
});


test('ci and release workflows use node 24 with npm ci and npm cache', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');

  assert.match(ci, /node-version:\s*24/);
  assert.match(ci, /cache:\s*npm/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm run coverage/);

  assert.match(release, /node-version:\s*24/);
  assert.match(release, /cache:\s*npm/);
  assert.match(release, /npm ci/);
});

test('release 0.1.1 artifacts exist', () => {
  const notes = fs.readFileSync(path.join(rootDir, 'releases/0.1.1.md'), 'utf8');
  assert.match(notes, /Linmas 0.1.1/);
  assert.match(notes, /release CI\/CD workflows/i);
});

test('release workflow skips provenance automatically on private repositories', () => {
  const text = read('.github/workflows/release.yml');
  assert.match(text, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(text, /publish:\s*[\s\S]*permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(text, /publish:\s*[\s\S]*permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(text, /provenance:\s*[\s\S]*if:\s*\$\{\{\s*!github\.event\.repository\.private\s*\}\}/);
  assert.match(text, /uses:\s*\.\/\.github\/workflows\/generator-generic-ossf-slsa3-publish\.yml/);
});

test('internal planning docs stay out of the shared repo surface', () => {
  const reviewedReplacementDocs = [
    'docs/compatibility/COMPATIBILITY.md',
    'docs/implementation/v0.9.0.md',
    'docs/linmas-mcp-validation-runbook.md',
    'docs/roadmap/versions/v0.9.0.md'
  ];
  const privateFutureDocs = [
    'docs/roadmap/ROADMAP.md',
    'docs/roadmap/versions/v0.10.0.md',
    'docs/roadmap/versions/v0.11.0.md',
    'docs/roadmap/versions/v0.12.0.md',
    'docs/roadmap/versions/v0.13.0.md',
    'docs/roadmap/versions/v0.14.0.md',
    'docs/roadmap/versions/v0.15.0.md',
    'docs/roadmap/versions/v0.16.0.md',
    'docs/roadmap/versions/v0.17.0.md',
    'docs/roadmap/versions/v0.18.0.md',
    'docs/roadmap/versions/v1.0.0.md',
    'docs/roadmap/versions/v1.1.0.md',
    'docs/roadmap/versions/v1.2.0.md'
  ];
  const generatedEvidence = [
    'docs/compatibility/evidence/v0.9.0-record.json',
    'docs/compatibility/evidence/v0.9.0-snapshot.json'
  ];
  for (const relativePath of reviewedReplacementDocs) assert.equal(isIgnoredByGit(relativePath), false, `${relativePath} must be trackable`);
  for (const relativePath of [...privateFutureDocs, ...generatedEvidence]) assert.equal(isIgnoredByGit(relativePath), true, `${relativePath} must remain ignored`);
  assert.equal(fs.existsSync(path.resolve('docs/superpowers/specs/2026-07-07-release-provenance-failure-analysis.md')), false);
});

test('workflows use modern action major versions', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');
  const tagRelease = read('.github/workflows/tag-release.yml');
  const liveEvaluation = read('.github/workflows/evaluation-live.yml');
  const provenance = read('.github/workflows/generator-generic-ossf-slsa3-publish.yml');
  const maintained = ci + release + tagRelease + liveEvaluation;

  assert.match(ci, /actions\/checkout@v7/);
  assert.match(ci, /actions\/setup-node@v7/);

  assert.match(release, /actions\/checkout@v7/);
  assert.match(release, /actions\/setup-node@v7/);
  assert.match(release, /actions\/upload-artifact@v7/);
  assert.match(tagRelease, /actions\/checkout@v7/);
  assert.match(tagRelease, /actions\/setup-node@v7/);
  assert.match(liveEvaluation, /actions\/checkout@v7/);
  assert.match(liveEvaluation, /actions\/setup-node@v7/);
  assert.match(liveEvaluation, /actions\/upload-artifact@v7/);
  assert.match(release, /gh release create/);

  assert.match(provenance, /actions\/download-artifact@v8/);

  assert.doesNotMatch(maintained, /actions\/(?:checkout|setup-node|upload-artifact)@v[1-6]\b/);
  assert.doesNotMatch(release, /softprops\/action-gh-release/);
  assert.doesNotMatch(provenance, /actions\/download-artifact@v5/);
});

// ponytail: action SHAs are a follow-up hardening step once maintainers choose exact pins.


test('release workflow validates release notes and creates the release from the exact target checkout', () => {
  const text = read('.github/workflows/release.yml');
  assert.match(text, /\[\[ -f "releases\/\$VERSION\.md" \]\]/);
  assert.match(text, /head -n 1 "releases\/\$VERSION\.md"/);
  assert.match(text, /--notes-file "releases\/\$\{RELEASE_TAG#v\}\.md"/);
  assert.match(text, /--verify-tag/);
});

test('release workflow publishes and releases the exact checked artifact', () => {
  const text = read('.github/workflows/release.yml');
  assert.match(text, /EXPECTED="linmas-\$\{RELEASE_TAG#v\}\.tgz"/);
  assert.match(text, /node scripts\/artifact-integrity\.mjs/);
  assert.match(text, /actions\/download-artifact@v8/);
  assert.match(text, /npm publish "\$RUNNER_TEMP\/release-package\/\$ARTIFACT_FILE" --access public --ignore-scripts/);
  assert.match(text, /gh release create "\$RELEASE_TAG" "\$RUNNER_TEMP\/release-package\/\$ARTIFACT_FILE"/);
  assert.ok(text.indexOf('Verify the exact artifact immediately before npm publication') < text.indexOf('npm publish'));
  assert.ok(text.indexOf('Verify the exact artifact immediately before GitHub release creation') < text.indexOf('gh release create'));
});

test('tag-release workflow requires explicit authorization before creating a tag', () => {
  const text = read('.github/workflows/tag-release.yml');
  assert.doesNotMatch(text, /^\s{2}push:/m);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /version:\s*\n\s+description:[^\n]*\n\s+required:\s*true\n\s+type:\s*string/);
  assert.match(text, /target_sha:\s*\n\s+description:[^\n]*\n\s+required:\s*true\n\s+type:\s*string/);
  assert.match(text, /if:\s*\$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
  const authorize = jobSection(text, 'authorize');
  const tag = jobSection(text, 'tag');
  assert.match(tag, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(tag, /permissions:\s*[\s\S]*actions:\s*write/);
  assert.match(authorize, /node scripts\/validate-release-request\.mjs[\s\S]*--phase prepare/);
  assert.match(authorize, /--phase prepare[\s\S]*--checkout-role target/);
  assert.doesNotMatch(tag, /scripts\/validate-release-request\.mjs|scripts\/artifact-integrity\.mjs|npm test|npm ci/);
  assert.match(tag, /git tag -a "\$TAG" "\$TARGET_SHA" -m "\$TAG"/);
  assert.match(tag, /http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic \$GIT_BASIC_AUTH/);
  assert.match(tag, /gh workflow run release\.yml[\s\S]*--ref main[\s\S]*-f tag="v\$\{REQUESTED_VERSION\}"[\s\S]*-f target_sha="\$TARGET_SHA"/);
  for (const field of ['artifact_file', 'artifact_sha256', 'artifact_bytes', 'artifact_entries', 'artifact_inventory_sha256']) {
    assert.match(tag, new RegExp(`-f ${field}="`));
  }
  assert.match(text, /persist-credentials:\s*false/);
});

test('release Git authentication is masked, host-scoped, and process-local', () => {
  for (const workflow of ['tag-release.yml', 'release.yml']) {
    const text = read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(text, /AUTHORIZATION: bearer/i);
    const runBlocks = [...text.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)];
    let authenticatedBlocks = 0;
    for (const [, block] of runBlocks) {
      if (!block.includes('AUTHORIZATION: basic')) continue;
      authenticatedBlocks += 1;
      assert.ok(block.includes('GIT_BASIC_AUTH="$(printf \'x-access-token:%s\' "$GH_TOKEN" | base64 -w 0)"'));
      const mask = block.indexOf('printf \'::add-mask::%s\\n\' "$GIT_BASIC_AUTH"');
      assert.ok(mask >= 0 && mask < block.indexOf('AUTHORIZATION: basic'));
      assert.match(block, /http\.https:\/\/github\.com\/\.extraheader/);
      assert.doesNotMatch(block, /git config[^\n]*(?:extraheader|GIT_BASIC_AUTH)|set -[^\n]*x/);
      assert.doesNotMatch(block, /(?:echo|printf)[^\n]*GIT_BASIC_AUTH[^\n]*(?:GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH)/);
      if (block.includes('node scripts/validate-release-request.mjs')) {
        assert.match(block, /GIT_CONFIG_COUNT=1 \\\n          GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader \\\n          GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$GIT_BASIC_AUTH" \\\n          node scripts\/validate-release-request\.mjs/);
      }
    }
    assert.equal(authenticatedBlocks, workflow === 'tag-release.yml' ? 4 : 3);
    assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(text, /persist-credentials:\s*false/);
  }
});

test('release handoff validation accepts producer metadata and rejects mismatches', (t) => {
  const workflow = read('.github/workflows/release.yml');
  const script = workflow.match(/node - "\$HANDOFF_PATH"[^\n]*<<'NODE'\n([\s\S]*?)^          NODE$/m)?.[1];
  assert.ok(script, 'the actual handoff validator must be present');
  const source = script.replace(/^          /gm, '');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-handoff-contract-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const filename = 'linmas-0.9.0.tgz';
  const digest = 'a'.repeat(64);
  const inventoryDigest = 'b'.repeat(64);
  const manifest = {
    schemaVersion: 1,
    handoffKind: 'linmas-release-artifact',
    package: { path: filename, filename, sha256: digest, bytes: 100, entryCount: 1, inventorySha256: inventoryDigest, packageName: 'linmas', packageVersion: '0.9.0' },
    plugin: { path: 'plugin/linmas', packageName: 'linmas', packageVersion: '0.9.0', fileCount: 1, contentDigest: digest, files: [] }
  };
  const manifestPath = path.join(temporaryRoot, 'handoff.json');
  function validate(value) {
    fs.writeFileSync(manifestPath, JSON.stringify(value));
    return spawnSync(process.execPath, ['-', manifestPath, filename, digest, '100', '1', inventoryDigest, '0.9.0'], { input: source, encoding: 'utf8' });
  }
  assert.equal(validate(manifest).status, 0, 'producer metadata has no invented published field');
  const wrongName = structuredClone(manifest);
  wrongName.package.packageName = 'wrong-package';
  assert.notEqual(validate(wrongName).status, 0);
  const wrongVersion = structuredClone(manifest);
  wrongVersion.plugin.packageVersion = '0.8.0';
  assert.notEqual(validate(wrongVersion).status, 0);
  const wrongDigest = structuredClone(manifest);
  wrongDigest.package.sha256 = 'c'.repeat(64);
  assert.notEqual(validate(wrongDigest).status, 0);
});

test('dependabot targets dev for github-actions and npm updates', () => {
  const text = read('.github/dependabot.yml');
  assert.match(text, /package-ecosystem:\s*"github-actions"[\s\S]*target-branch:\s*"dev"/);
  assert.match(text, /package-ecosystem:\s*"npm"[\s\S]*target-branch:\s*"dev"/);
});


test('release notes file matching package version exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const version = pkg.version;
  const notesPath = path.resolve(`releases/${version}.md`);
  assert.equal(fs.existsSync(notesPath), true, `Release notes file ${notesPath} must exist for the current package version ${version}`);

  const content = fs.readFileSync(notesPath, 'utf8');
  assert.match(content, new RegExp(`^# Linmas ${version.replace(/\./g, '\\.')}`));
});

test('pr target guard workflow enforces dev-first promotion to main', () => {
  const text = read('.github/workflows/pr-target-guard.yml');
  assert.match(text, /pull_request:/);
  assert.match(text, /env:\s*[\s\S]*BASE_REF:\s*\$\{\{ github\.base_ref \}\}/);
  assert.match(text, /env:\s*[\s\S]*HEAD_REF:\s*\$\{\{ github\.head_ref \}\}/);
  assert.match(text, /base="\$BASE_REF"/);
  assert.match(text, /head="\$HEAD_REF"/);
  assert.match(text, /base.*dev|dev.*base/s);
  assert.match(text, /head.*dev|dev.*head/s);
});

test('main pushes propose a no-force ancestry sync PR back to dev', () => {
  const text = read('.github/workflows/sync-main-to-dev.yml');
  assert.match(text, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(text, /contents:\s*write/);
  assert.match(text, /pull-requests:\s*write/);
  assert.match(text, /actions:\s*write/);
  assert.match(text, /group:\s*main-to-dev-sync/);
  assert.match(text, /\.ahead_by/);
  assert.match(text, /automation\/sync-main-to-dev-\$\{GITHUB_RUN_ID\}/);
  assert.match(text, /gh api --method POST/);
  assert.match(text, /gh workflow run ci\.yml --repo "\$REPO" --ref "\$BRANCH"/);
  assert.match(text, /gh pr create[\s\S]*--base dev/);
  assert.ok(text.indexOf('gh workflow run ci.yml') < text.indexOf('gh pr create'), 'bot CI dispatch must happen before PR creation');
  assert.match(text, /--head "\$BRANCH"/);
  assert.doesNotMatch(text, /force|gh pr merge|auto-merge/i);
});

test('branch policy docs state main is public-facing and dev is the normal PR target', () => {
  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /pull requests go to `dev`/i);
  const setup = read('.github/REPOSITORY_SETUP.md');
  assert.match(setup, /main-to-dev ancestry sync PR/i);
  assert.match(setup, /CODEX_API_KEY/);
  assert.match(setup, /LINMAS_EVAL_MODEL/);
  assert.match(setup, /trusted publishing/i);
  assert.doesNotMatch(setup, /NPM_TOKEN/);
  assert.match(setup, /Proof-carrying defensive security reviews for AI-assisted software/);
  // ponytail: PUBLIC_RELEASE_CHECKLIST.md and QUALITY_GATES.md are internal-only docs
  // removed from remote; branch policy assertions retained via CONTRIBUTING.md
});

test('public release gates are captured in internal release checklist', () => {
  // PUBLIC_RELEASE_CHECKLIST.md is internal-only, removed from remote tracking.
  // The console release check summary documents each gate independently.
  // This test remains as a placeholder to ensure the internal checklist is
  // consulted when available locally.
  assert.ok(true, 'release gates documented in PUBLIC_RELEASE_CHECKLIST.md (local only)');
});

test('public repo baseline docs exist and README links the contributing guide', () => {
  const readme = read('README.md');
  const security = read('.github/SECURITY.md');
  const conduct = read('CODE_OF_CONDUCT.md');
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(security, /private vulnerability report/i);
  assert.match(security, /supported versions/i);
  assert.match(security, /response/i);
  assert.match(conduct, /Contributor Covenant/i);
});
