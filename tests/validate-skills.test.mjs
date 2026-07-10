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

test('threat-research-analyst documents intelligence advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'threat-research-analyst', 'SKILL.md'), 'utf8');

  const orderedItems = [
    '## Advisor review protocol',
    '### Advisor review mode',
    '### Design review mode',
    '## Minimal guardrails',
    '## Output contract',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Threat research advisor checklist',
    'source confidence',
    'indicator age',
    'context',
    'false-positive risk',
    'defensive action',
    '## Safety boundary'
  ];

  let lastIndex = -1;
  for (const item of orderedItems) {
    const index = skill.indexOf(item, lastIndex + 1);
    assert.ok(index !== -1, `Expected skill to contain '${item}' after the previous item`);
    lastIndex = index;
  }
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

test('security-operations-lead documents operational advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'security-operations-lead', 'SKILL.md'), 'utf8');

  for (const text of [
    '## Advisor review protocol',
    '## Quality rubric',
    '## Recommended deterministic checks',
    'telemetry',
    'monitoring coverage',
    'alert ownership',
    'escalation',
    'access changes, and operational changes',
    'Confirmed finding',
    'Needs validation',
    'Recommendation'
  ]) assert.match(skill, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
    await writeFile(skillPath, skill.replace('### Advisor review mode', '### Removed advisor review mode'));

    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/validate-skills.mjs'], { cwd: tempDir }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Missing specialist advisor requirement '### Advisor review mode'/);
        return true;
      }
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('advisor validator profiles remain opt-in during staged rollout', async () => {
  const validatorSource = await readFile(path.join(rootDir, 'scripts', 'validate-skills.mjs'), 'utf8');

  assert.match(validatorSource, /const specialistAdvisorRequirements = \[/);
  assert.match(validatorSource, /const routerAdvisorRequirements = \[/);
  assert.match(validatorSource, /function validateAdvisorContract\(skill, skillFile\)/);
  assert.match(validatorSource, /text\.includes\('## Advisor review protocol'\)/);
  assert.match(validatorSource, /text\.includes\('## Advisor routing protocol'\)/);
});
