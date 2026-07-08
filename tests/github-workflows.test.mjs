import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
}

test('release workflow is tag-driven and verifies main/tag/version before publish', () => {
  const text = read('.github/workflows/release.yml');
  assert.match(text, /tags:\s*\n\s*- 'v\*\.\*\.\*'/);
  assert.match(text, /git fetch origin main/);
  assert.doesNotMatch(text, /git fetch origin main --depth=1/);
  assert.match(text, /node scripts\/verify-release-tag\.mjs/);
  assert.match(text, /npm test/);
  assert.match(text, /npm run validate/);
  assert.match(text, /npm run pack:dry-run/);
  assert.match(text, /npm pack/);
  assert.match(text, /actions\/upload-artifact@v5/);
  assert.match(text, /name:\s*release-artifact/);
  assert.match(text, /npm publish --access public/);
  assert.match(text, /softprops\/action-gh-release@v3/);
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
  assert.match(text, /actions\/download-artifact@v5/);
  assert.match(text, /name:\s*\$\{\{ inputs\.artifact-name \}\}/);
  assert.match(text, /actions\/attest@v4/);
  assert.match(text, /subject-path:\s*\$\{\{ inputs\.subject-path \}\}/);
});

test('provenance workflow uses subject-path attestation without custom predicate requirement', () => {
  const text = read('.github/workflows/generator-generic-ossf-slsa3-publish.yml');
  assert.match(text, /actions\/download-artifact@v5/);
  assert.match(text, /actions\/attest@v4/);
  assert.match(text, /subject-path:\s*\$\{\{ inputs\.subject-path \}\}/);
  assert.doesNotMatch(text, /predicate-type:/);
});

test('package metadata declares the hardened CI/runtime support floor', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(fs.existsSync(path.join(rootDir, 'package-lock.json')), true);
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
  const notes = fs.readFileSync(path.join(rootDir, 'docs/releases/0.1.1.md'), 'utf8');
  assert.match(notes, /Linmas 0.1.1/);
  assert.match(notes, /release CI\/CD workflows/i);
});

test('release workflow skips provenance automatically on private repositories', () => {
  const text = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(text, /provenance:\s*[\s\S]*if:\s*\$\{\{\s*!github\.event\.repository\.private\s*\}\}/);
  assert.match(text, /uses:\s*\.\/\.github\/workflows\/generator-generic-ossf-slsa3-publish\.yml/);
});

test('provenance failure analysis documents the private repo limitation and skip decision', () => {
  const text = fs.readFileSync(path.resolve('docs/superpowers/specs/2026-07-07-release-provenance-failure-analysis.md'), 'utf8');
  assert.match(text, /private user-owned repos/i);
  assert.match(text, /skip provenance/i);
});

test('workflows use modern action major versions', () => {
  const ci = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  const provenance = fs.readFileSync(path.resolve('.github/workflows/generator-generic-ossf-slsa3-publish.yml'), 'utf8');

  assert.match(ci, /actions\/checkout@v6/);
  assert.match(ci, /actions\/setup-node@v5/);

  assert.match(release, /actions\/checkout@v6/);
  assert.match(release, /actions\/setup-node@v5/);
  assert.match(release, /actions\/upload-artifact@v5/);
  assert.match(release, /softprops\/action-gh-release@v3/);

  assert.match(provenance, /actions\/download-artifact@v5/);

  assert.doesNotMatch(ci + release + provenance, /actions\/checkout@v4/);
  assert.doesNotMatch(ci + release, /actions\/setup-node@v4/);
  assert.doesNotMatch(release, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(release, /softprops\/action-gh-release@v2/);
  assert.doesNotMatch(provenance, /actions\/download-artifact@v4/);
});

test('release workflow reads release notes file and passes body to gh release', () => {
  const text = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(text, /name:\s*Read release notes/);
  assert.match(text, /id:\s*release_notes/);
  assert.match(text, /FILE="docs\/releases\/\$\{VERSION\}\.md"/);
  assert.match(text, /echo "BODY<<EOF" >> \$GITHUB_OUTPUT/);
  assert.match(text, /body:\s*\$\{\{\s*steps\.release_notes\.outputs\.BODY\s*\}\}/);
});




