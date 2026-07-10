import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

test('validate-skills secret scan surface includes all published files entries', async () => {
  const packageJson = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const validatorSource = await readFile(path.join(rootDir, 'scripts', 'validate-skills.mjs'), 'utf8');

  for (const entry of packageJson.files) {
    const normalizedEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    assert.match(
      validatorSource,
      new RegExp(`['\"]${normalizedEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]`),
      `validator should scan published entry ${normalizedEntry}`
    );
  }
});

test('validate-skills reuses the shared expected skill inventory contract', async () => {
  const validatorSource = await readFile(path.join(rootDir, 'scripts', 'validate-skills.mjs'), 'utf8');

  assert.match(validatorSource, /import \{ EXPECTED_SKILLS \} from '\.\.\/src\/core\/list-skills\.mjs';/);
  assert.match(validatorSource, /const expectedSkills = EXPECTED_SKILLS;/);
  assert.doesNotMatch(validatorSource, /const expectedSkills = \[/);
});

test('secure-code-reviewer documents the bounded advisor review contract', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'secure-code-reviewer', 'SKILL.md'), 'utf8');
  const readme = await readFile(path.join(rootDir, 'README.md'), 'utf8');

  for (const requiredText of [
    '## Advisor review protocol',
    '### Advisor review mode',
    '### Design review mode',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Safety boundary',
    'Confirmed finding',
    'Needs validation',
    'Recommendation',
    'Affected surface',
    'Preconditions',
    'Remediation',
    'Verification',
    'runs only when invoked',
    'optional repository policy'
  ]) {
    assert.match(skill, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(readme, /## Secure code advisor review/);
  assert.match(readme, /Optional repository policy/);
  assert.match(readme, /does not automatically filter every agent response/i);
  assert.match(readme, /human review/i);
  assert.match(readme, /npm run validate/);
});

test('validate-skills rejects a missing secure-code-reviewer advisor requirement', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'linmas-validator-'));

  try {
    await cp(rootDir, tempDir, {
      recursive: true,
      filter(source) {
        return !['.git', 'node_modules', 'docs'].includes(path.basename(source));
      }
    });

    const skillPath = path.join(tempDir, 'skills', 'secure-code-reviewer', 'SKILL.md');
    const skill = await readFile(skillPath, 'utf8');
    await writeFile(skillPath, skill.replace('## Advisor review protocol', '## Removed advisor review protocol'));

    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/validate-skills.mjs'], { cwd: tempDir }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Missing secure-code-reviewer requirement '## Advisor review protocol'/);
        return true;
      }
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
