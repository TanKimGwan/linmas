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
  assert.match(text, /npm run demo:judge -- --live --yes --model gpt-5\.6-sol/);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /Review Capsule/);
  assert.match(text, /Human review remains required/);
});

test('README preserves the Linmas identity story without displacing the judge path', () => {
  const text = read('README.md');
  assert.match(text, /## Why the name [“\"]Linmas[”\"]\?/);
  assert.match(text, /Perlindungan Masyarakat/);
  assert.match(text, /first layer of defense closest to everyday builders/i);
  assert.match(text, /not (?:the )?[“\"]police[”\"], [“\"]military[”\"], or final authority/i);
  assert.match(text, /not affiliated with any government institution/i);
  assert.match(text, /solo developers and indie hackers/i);
  assert.match(text, /vibe coders/i);
  assert.ok(text.indexOf('npm run demo:judge') < text.indexOf('## Why the name'), 'judge demo must remain ahead of the origin story');
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
  assert.match(text, /LINMAS_EVAL_PROVIDER/);
  assert.match(text, /tmp\/windows-live-evaluation\.json/);
  assert.match(text, /no equivalent live Windows run is claimed/i);
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

test('bilingual usage guides are linked from README and excluded from npm packaging', () => {
  const text = read('README.md');
  assert.match(text, /USAGE\.md/);
  assert.match(text, /PANDUAN-PENGGUNAAN\.md/);
  assert.match(read('USAGE.md'), /codex plugin marketplace add TanKimGwan\/linmas/);
  assert.match(read('PANDUAN-PENGGUNAAN.md'), /codex plugin marketplace add TanKimGwan\/linmas/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.files.includes('USAGE.md'), false);
  assert.equal(pkg.files.includes('PANDUAN-PENGGUNAAN.md'), false);
});

test('README badges use renderable SVG endpoints and static release metadata stays current', () => {
  const text = read('README.md');
  const pkg = JSON.parse(read('package.json'));
  const sources = [...text.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  const badgeSources = sources.filter((source) => source.includes('/badge'));

  assert.ok(badgeSources.length >= 8, 'README should retain the public project badge set');
  for (const source of badgeSources) {
    const url = new URL(source);
    assert.match(url.pathname, /\.svg$/, `badge must use an explicit SVG endpoint: ${source}`);
    if (url.hostname === 'raw.githubusercontent.com') {
      const relativePath = url.pathname.replace(/^\/TanKimGwan\/linmas\/main\//, '');
      assert.equal(fs.existsSync(path.join(rootDir, relativePath)), true, `missing tracked badge asset: ${relativePath}`);
    }
  }
  assert.doesNotMatch(text, /img\.shields\.io/, 'README badges must not depend on the failing third-party proxy');
  assert.match(read('assets/badges/npm.svg'), new RegExp(`npm: v${pkg.version.replaceAll('.', '\\.')}`));
  assert.match(read('assets/badges/release.svg'), new RegExp(`release: v${pkg.version.replaceAll('.', '\\.')}`));
});

test('public docs describe Codex-first compatibility without overstating other agents', () => {
  for (const file of ['README.md', 'USAGE.md', 'PANDUAN-PENGGUNAAN.md']) {
    const text = read(file);
    assert.match(text, /Codex/i, `${file} must identify Codex`);
    assert.match(text, /Claude Code/i, `${file} must document verified Claude Code compatibility`);
    assert.match(text, /Gemini/i, `${file} must document the Gemini portability boundary`);
    assert.match(text, /(?:Codex-first|Codex is the primary native integration|Codex adalah integrasi native utama)/i, `${file} must keep Codex as the primary integration`);
    assert.match(text, /(?:portable|portabel)[\s\S]{0,400}(?:manual|native integration|integrasi native)/i, `${file} must distinguish portability from native integration`);
  }
});
