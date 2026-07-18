import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_SKILL_IDS } from '../src/core/skill-catalog.mjs';
import { parseArgv } from '../src/cli/parse-args.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

test('README leads with Proof Review and a runnable offline judge demo', () => {
  const text = read('README.md');
  const firstScreen = text.slice(0, 5000);
  assert.match(firstScreen, /Linmas Proof Review/);
  assert.match(firstScreen, /npm run demo:judge/);
  assert.match(firstScreen, /OFFLINE FIXTURE REPLAY/);
  assert.match(text, /npm run demo:judge -- --live --yes/);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /Review Capsule/);
  assert.match(text, /Human review remains required/);
});

test('README commands use canonical skills and match parser contracts', () => {
  const text = read('README.md');
  for (const skill of PUBLIC_SKILL_IDS) assert.match(text, new RegExp(`\\b${skill}\\b`));
  assert.match(text, /linmas review compare before\.json after\.json/);
  assert.match(text, /--capsule review-capsule\.json/);
  const review = parseArgv(['node', 'linmas', 'review', '--skill', 'linmas-secure-code-reviewer', '--input', 'patch.diff', '--provider', 'codex', '--capsule', 'review-capsule.json', '--yes']);
  assert.equal(review.skillName, 'linmas-secure-code-reviewer');
  assert.equal(review.capsulePath, 'review-capsule.json');
  const compare = parseArgv(['node', 'linmas', 'review', 'compare', 'before.json', 'after.json']);
  assert.equal(compare.reviewAction, 'compare');
});

test('README states provider-native auth and truthful filesystem privacy boundaries', () => {
  const text = read('README.md');
  assert.match(text, /ChatGPT subscription/);
  assert.match(text, /Codex-managed API key/);
  assert.match(text, /Linmas does not log you in/i);
  assert.match(text, /does not guarantee that Codex cannot read other filesystem paths/i);
  assert.doesNotMatch(text, /sandbox[^\n]*(?:only input|input-only)|Codex cannot read outside|Linmas handles (?:the )?login/i);
});

test('public Build Week evidence records only verified facts without private identifiers', () => {
  const text = read('OPENAI_BUILD_WEEK_2026.md');
  assert.match(text, /0476c7843d0f5adc8ccff3f6729def306aeb896e/);
  assert.match(text, /3c543f3/);
  assert.match(text, /a9a846c/);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /ChatGPT subscription/);
  assert.match(text, /private.*feedback.*not published/i);
  assert.doesNotMatch(text, /\/home\/|\/run\/media\/|019f[0-9a-f-]{20,}|@(?:gmail|outlook|yahoo)\./i);
});

test('all local README links resolve and public evidence is intentionally packaged', () => {
  const text = read('README.md');
  for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    assert.equal(fs.existsSync(path.join(rootDir, target)), true, `missing README link target: ${target}`);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.files.includes('OPENAI_BUILD_WEEK_2026.md'));
  assert.equal(pkg.files.some((item) => item.startsWith('docs')), false);
});
