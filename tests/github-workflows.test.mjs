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

test('release docs mention dev to main to vX.Y.Z flow', () => {
  const npmPlan = read('docs/NPM_PACKAGING_PLAN.md');
  const checklist = read('docs/PUBLIC_RELEASE_CHECKLIST.md');
  const gates = read('docs/QUALITY_GATES.md');
  assert.match(npmPlan, /dev.*main.*vX\.Y\.Z/s);
  assert.match(checklist, /merge `dev` into `main`/i);
  assert.match(checklist, /approval happens before pushing the release tag/i);
  assert.match(checklist, /push `main` to the remote before pushing the `vX\.Y\.Z` tag/i);
  assert.doesNotMatch(checklist, /Publish command should be run manually and intentionally/i);
  assert.doesNotMatch(checklist, /npm publish --access public/);
  assert.match(gates, /release tags must come from `main`/);
}
);
