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
  assert.match(text, /actions\/upload-artifact@v4/);
  assert.match(text, /name:\s*release-artifact/);
  assert.match(text, /npm publish --access public/);
  assert.match(text, /softprops\/action-gh-release@v2/);
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
  assert.match(text, /actions\/download-artifact@v4/);
  assert.match(text, /name:\s*\$\{\{ inputs\.artifact-name \}\}/);
  assert.match(text, /actions\/attest@v4/);
  assert.match(text, /subject-path:\s*\$\{\{ inputs\.subject-path \}\}/);
});

test('provenance workflow uses subject-path attestation without custom predicate requirement', () => {
  const text = read('.github/workflows/generator-generic-ossf-slsa3-publish.yml');
  assert.match(text, /actions\/download-artifact@v4/);
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

test('release 0.1.2 artifacts exist', () => {
  const notes = fs.readFileSync(path.resolve('docs/releases/0.1.2.md'), 'utf8');
  assert.match(notes, /Linmas 0.1.2/);
  assert.match(notes, /release automation is active/i);
});

test('release 0.1.3 artifacts exist and version is bumped', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'));
  const notes = fs.readFileSync(path.resolve('docs/releases/0.1.3.md'), 'utf8');

  assert.equal(pkg.version, '0.1.3');
  assert.equal(lock.version, '0.1.3');
  assert.match(notes, /Linmas 0.1.3/);
  assert.match(notes, /provenance validation/i);
});


