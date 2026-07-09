import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
}

test('release workflow supports tag push and explicit dispatch and verifies main/tag/version before publish', () => {
  const text = read('.github/workflows/release.yml');
  assert.match(text, /tags:\s*\n\s*- 'v\*\.\*\.\*'/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /inputs:\s*[\s\S]*tag:/);
  assert.match(text, /required:\s*true/);
  assert.match(text, /RELEASE_TAG:/);
  assert.match(text, /github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name/);
  assert.match(text, /ref:\s*\$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(text, /git fetch origin main/);
  assert.doesNotMatch(text, /git fetch origin main --depth=1/);
  assert.match(text, /node scripts\/verify-release-tag\.mjs --tag "\$\{RELEASE_TAG\}"/);
  assert.match(text, /VERSION=\$\{RELEASE_TAG#v\}/);
  assert.match(text, /npm test/);
  assert.match(text, /npm run validate/);
  assert.match(text, /npm run pack:dry-run/);
  assert.match(text, /npm pack/);
  assert.match(text, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(text, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(text, /actions\/upload-artifact@v7/);
  assert.match(text, /name:\s*release-artifact/);
  assert.match(text, /name:\s*Ensure npm supports trusted publishing/);
  assert.match(text, /npm install -g npm@11/);
  assert.match(text, /npm publish --access public/);
  assert.doesNotMatch(text, /NODE_AUTH_TOKEN:/);
  assert.doesNotMatch(text, /secrets\.NPM_TOKEN/);
  assert.match(text, /softprops\/action-gh-release@v3/);
  assert.match(text, /tag_name:\s*\$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(text, /uses:\s*\.\/\.github\/workflows\/generator-generic-ossf-slsa3-publish\.yml/);
});

test('ci workflow triggers on PR and pushes to dev/main', () => {
  const text = read('.github/workflows/ci.yml');
  assert.match(text, /pull_request:/);
  assert.match(text, /branches:\s*\[dev,\s*main\]/);
  assert.match(text, /contents:\s*read/);
  assert.match(text, /npm test/);
  assert.match(text, /npm run validate/);
  assert.match(text, /npm run pack:dry-run/);
  assert.doesNotMatch(text, /npm publish/);
});

test('provenance workflow is a reusable attestation workflow with artifact download', () => {
  const text = read('.github/workflows/generator-generic-ossf-slsa3-publish.yml');
  assert.doesNotMatch(text, /pull_request:/);
  assert.doesNotMatch(text, /workflow_run:/);
  assert.match(text, /workflow_call:/);
  assert.match(text, /inputs:\s*[\s\S]*subject-path:/);
  assert.match(text, /inputs:\s*[\s\S]*artifact-name:/);
  assert.match(text, /actions:\s*read/);
  assert.match(text, /attestations:\s*write/);
  assert.match(text, /contents:\s*read/);
  assert.match(text, /id-token:\s*write/);
  assert.match(text, /actions\/download-artifact@v8/);
  assert.match(text, /name:\s*\$\{\{ inputs\.artifact-name \}\}/);
  assert.match(text, /actions\/attest@v4/);
  assert.match(text, /subject-path:\s*\$\{\{ inputs\.subject-path \}\}/);
});

test('provenance workflow uses subject-path attestation without custom predicate requirement', () => {
  const text = read('.github/workflows/generator-generic-ossf-slsa3-publish.yml');
  assert.match(text, /actions\/download-artifact@v8/);
  assert.match(text, /actions\/attest@v4/);
  assert.match(text, /subject-path:\s*\$\{\{ inputs\.subject-path \}\}/);
  assert.doesNotMatch(text, /predicate-type:/);
});

test('package metadata declares the hardened CI/runtime support floor', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(fs.existsSync(path.join(rootDir, 'package-lock.json')), true);
});

test('package metadata includes public repository provenance fields', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
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
  assert.equal(execFileSync('git', ['ls-files', 'assets/linmas.jpg'], {
    cwd: rootDir,
    encoding: 'utf8'
  }).trim(), 'assets/linmas.jpg');
});


test('ci and release workflows use node 24 with npm ci and npm cache', () => {
  const ci = fs.readFileSync(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(rootDir, '.github/workflows/release.yml'), 'utf8');

  assert.match(ci, /node-version:\s*24/);
  assert.match(ci, /cache:\s*npm/);
  assert.match(ci, /npm ci/);

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
  const text = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(text, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(text, /publish:\s*[\s\S]*permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(text, /publish:\s*[\s\S]*permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(text, /provenance:\s*[\s\S]*if:\s*\$\{\{\s*!github\.event\.repository\.private\s*\}\}/);
  assert.match(text, /uses:\s*\.\/\.github\/workflows\/generator-generic-ossf-slsa3-publish\.yml/);
});

test('internal planning docs stay out of the shared repo surface', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^docs\//m);
  assert.equal(fs.existsSync(path.resolve('docs/superpowers/specs/2026-07-07-release-provenance-failure-analysis.md')), false);
});

test('workflows use modern action major versions', () => {
  const ci = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  const provenance = fs.readFileSync(path.resolve('.github/workflows/generator-generic-ossf-slsa3-publish.yml'), 'utf8');

  assert.match(ci, /actions\/checkout@v7/);
  assert.match(ci, /actions\/setup-node@v6/);

  assert.match(release, /actions\/checkout@v7/);
  assert.match(release, /actions\/setup-node@v6/);
  assert.match(release, /actions\/upload-artifact@v7/);
  assert.match(release, /npm install -g npm@11/);
  assert.match(release, /softprops\/action-gh-release@v3/);

  assert.match(provenance, /actions\/download-artifact@v8/);

  assert.doesNotMatch(ci + release + provenance, /actions\/checkout@v6/);
  assert.doesNotMatch(ci + release, /actions\/setup-node@v5/);
  assert.doesNotMatch(release, /actions\/upload-artifact@v5/);
  assert.doesNotMatch(release, /softprops\/action-gh-release@v2/);
  assert.doesNotMatch(provenance, /actions\/download-artifact@v5/);
});

// ponytail: action SHAs are a follow-up hardening step once maintainers choose exact pins.


test('release workflow reads release notes file and passes body to gh release', () => {
  const text = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(text, /name:\s*Read release notes/);
  assert.match(text, /id:\s*release_notes/);
  assert.match(text, /FILE="releases\/\$\{VERSION\}\.md"/);
  assert.match(text, /DELIM=/);
  assert.doesNotMatch(text, /echo "BODY<<EOF" >> \$GITHUB_OUTPUT/);
  assert.match(text, /body:\s*\$\{\{\s*steps\.release_notes\.outputs\.BODY\s*\}\}/);
});

test('tag-release workflow creates a tag then dispatches release from main', () => {
  const text = read('.github/workflows/tag-release.yml');
  assert.match(text, /branches:\s*\n\s*- main/);
  assert.match(text, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(text, /permissions:\s*[\s\S]*actions:\s*write/);
  assert.match(text, /echo "tag=v\$VERSION" >> "\$GITHUB_OUTPUT"/);
  assert.match(text, /git tag -a "\$TAG" -m "\$TAG"/);
  assert.match(text, /git push origin "\$TAG"/);
  assert.match(text, /gh workflow run release\.yml --ref main -f tag="\$TAG"/);
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

test('branch policy docs state main is public-facing and dev is the normal PR target', () => {
  const contributing = read('CONTRIBUTING.md');
  const checklist = read('PUBLIC_RELEASE_CHECKLIST.md');
  const gates = read('QUALITY_GATES.md');
  assert.match(contributing, /pull requests go to `dev`/i);
  assert.match(checklist, /merge `dev` into `main`/i);
  assert.match(gates, /work targets `dev` first/i);
});

test('public release checklist includes explicit public-launch gates', () => {
  const checklist = read('PUBLIC_RELEASE_CHECKLIST.md');
  assert.match(checklist, /npm test passed/i);
  assert.match(checklist, /npm run validate passed/i);
  assert.match(checklist, /npm run pack:dry-run passed/i);
  assert.match(checklist, /gitleaks working tree scan passed/i);
  assert.match(checklist, /gitleaks history scan passed/i);
  assert.match(checklist, /no internal docs exposed/i);
  assert.match(checklist, /SECURITY\.md exists/i);
  assert.match(checklist, /CODE_OF_CONDUCT\.md exists/i);
  assert.match(checklist, /branch protection verified/i);
  assert.match(checklist, /package tarball inspected/i);
  assert.match(checklist, /explicit maintainer approval before public visibility change/i);
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





