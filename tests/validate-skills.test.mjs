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

test('validate-skills reuses the canonical public skill inventory contract', async () => {
  const validatorSource = await readFile(path.join(rootDir, 'scripts', 'validate-skills.mjs'), 'utf8');

  assert.match(validatorSource, /import \{ PUBLIC_SKILL_IDS \} from '\.\.\/src\/core\/skill-catalog\.mjs';/);
  assert.match(validatorSource, /const expectedSkills = PUBLIC_SKILL_IDS;/);
  assert.doesNotMatch(validatorSource, /const expectedSkills = \[/);
});

test('threat-research-analyst documents intelligence advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-threat-research-analyst', 'SKILL.md'), 'utf8');

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

test('secure-systems-architect documents systems advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-secure-systems-architect', 'SKILL.md'), 'utf8');
  let lastIndex = -1;

  for (const item of [
    '## Advisor review protocol',
    'runs only when invoked',
    'optional repository policy',
    '### Advisor review mode',
    '### Design review mode',
    '## Minimal guardrails',
    '## Output contract',
    'Scope and assumptions',
    'Findings',
    'Recommended deterministic checks',
    'Safety boundary',
    'Status',
    'Confirmed finding',
    'Needs validation',
    'Recommendation',
    'Severity',
    'Evidence',
    'Affected surface',
    'Preconditions',
    'Remediation',
    'Verification',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Systems advisor checklist',
    'trust boundaries',
    'identity',
    'data flow',
    'isolation',
    'failure modes',
    'defense in depth',
    '## Safety boundary'
  ]) {
    const index = skill.indexOf(item, lastIndex + 1);
    assert.notEqual(index, -1, `missing or out-of-order: ${item}`);
    lastIndex = index;
  }
});

test('secure-code-reviewer documents the bounded advisor review contract', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-secure-code-reviewer', 'SKILL.md'), 'utf8');
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

test('README separates installation hosts and execution providers', async () => {
  const text = await readFile(path.join(rootDir, 'README.md'), 'utf8');

  assert.match(text, /installation hosts/i);
  assert.match(text, /execution providers/i);
  assert.match(text, /Claude Code.*Codex|Codex.*Claude Code/is);
  assert.match(text, /credentials.*(?:not|never).*manifest|manifest.*never.*credentials/is);
  assert.match(text, /live execution.*opt-in|execution.*explicitly enabled/is);
  assert.match(text, /additional (?:installation )?hosts.*demand|demand.*additional (?:installation )?hosts/is);
  assert.match(text, /human review/i);
});

test('README defines policy decision limits', async () => {
  const text = await readFile(path.join(rootDir, 'README.md'), 'utf8');
  assert.match(text, /--policy baseline-appsec/);
  assert.match(text, /pass.*does not.*secure|does not.*prove.*security/is);
  assert.match(text, /human review.*required/i);
  assert.doesNotMatch(text, /certified by Linmas/i);
});

test('README documents safe review boundaries', async () => {
  const readme = await readFile(path.join(rootDir, 'README.md'), 'utf8');
  assert.match(readme, /linmas review --skill secure-code-reviewer --input patch\.diff/);
  assert.match(readme, /prepare mode/i);
  assert.match(readme, /no network call/i);
  assert.match(readme, /data leaves (your|the) machine/i);
  assert.match(readme, /human review/i);
});

test('README documents the specialist advisor rollout', async () => {
  const readme = await readFile(path.join(rootDir, 'README.md'), 'utf8');

  for (const text of [
    '## Security advisor skills',
    'advisor review mode',
    'design review mode',
    'security-domain-router',
    'Confirmed finding',
    'Needs validation',
    'Recommendation',
    'does not automatically filter every agent response',
    'Human review is required'
  ]) assert.match(readme, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('security-operations-lead documents operational advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-security-operations-lead', 'SKILL.md'), 'utf8');

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

test('controls-compliance-reviewer documents controls advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-controls-compliance-reviewer', 'SKILL.md'), 'utf8');

  // Verify all headers are present and in order
  const headings = [
    '## Advisor review protocol',
    '### Advisor review mode',
    '### Design review mode',
    '## Minimal guardrails',
    '## Output contract',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Controls advisor checklist',
    '## Safety boundary'
  ];

  let lastIndex = -1;
  for (const heading of headings) {
    const index = skill.indexOf(heading);
    assert.ok(index !== -1, `Missing expected heading: "${heading}"`);
    assert.ok(index > lastIndex, `Heading "${heading}" appeared out of order`);
    lastIndex = index;
  }

  // Verify Output contract fields are present and in order
  const outputContractIndex = skill.indexOf('## Output contract');
  const outputContractSection = skill.slice(outputContractIndex);

  const outputFields = [
    'Scope and assumptions',
    'Findings',
    'Recommended deterministic checks',
    'Safety boundary',
    'Status',
    'Confirmed finding',
    'Needs validation',
    'Recommendation',
    'Severity',
    'Evidence',
    'Affected surface',
    'Preconditions',
    'Remediation',
    'Verification'
  ];

  lastIndex = -1;
  for (const field of outputFields) {
    const index = outputContractSection.indexOf(field);
    assert.ok(index !== -1, `Missing expected output contract field: "${field}"`);
    assert.ok(index > lastIndex, `Output contract field "${field}" appeared out of order`);
    lastIndex = index;
  }

  // Verify Controls advisor checklist terms are present and in order
  const checklistIndex = skill.indexOf('## Controls advisor checklist');
  const checklistSection = skill.slice(checklistIndex);

  const checklistTerms = [
    'applicable control',
    'evidence sufficiency',
    'ownership',
    'test or attestation',
    'remediation tracking'
  ];

  lastIndex = -1;
  for (const term of checklistTerms) {
    const index = checklistSection.indexOf(term);
    assert.ok(index !== -1, `Missing expected checklist term: "${term}"`);
    assert.ok(index > lastIndex, `Checklist term "${term}" appeared out of order`);
    lastIndex = index;
  }
});

test('cloud-hardening-architect documents the cloud advisor contract in order', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-cloud-hardening-architect', 'SKILL.md'), 'utf8');
  let lastIndex = -1;

  for (const item of [
    '## Advisor review protocol',
    'runs only when invoked',
    'optional repository policy',
    '### Advisor review mode',
    '### Design review mode',
    '## Minimal guardrails',
    '## Output contract',
    'Scope and assumptions',
    'Findings',
    'Recommended deterministic checks',
    'Safety boundary',
    'Status',
    'Confirmed finding',
    'Needs validation',
    'Recommendation',
    'Severity',
    'Evidence',
    'Affected surface',
    'Preconditions',
    'Remediation',
    'Verification',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Cloud hardening advisor checklist',
    'IAM',
    'network exposure',
    'encryption',
    'secrets',
    'logs',
    'baseline and policy enforcement',
    '## Safety boundary'
  ]) {
    const index = skill.indexOf(item, lastIndex + 1);
    assert.notEqual(index, -1, `missing or out-of-order: ${item}`);
    lastIndex = index;
  }
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

    const skillPath = path.join(tempDir, 'skills', 'linmas-secure-code-reviewer', 'SKILL.md');
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

test('smart-contract-reviewer documents contract advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-smart-contract-reviewer', 'SKILL.md'), 'utf8');

  for (const text of ['## Advisor review protocol', '### Advisor review mode', '### Design review mode', '## Quality rubric', '## Recommended deterministic checks', 'asset flow', 'authorization', 'external calls', 'arithmetic/invariants', 'upgrade and admin controls']) {
    assert.match(skill, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('exploit-validation-specialist documents bounded validation focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-exploit-validation-specialist', 'SKILL.md'), 'utf8');

  for (const text of [
    '## Advisor review protocol',
    '### Advisor review mode',
    '### Design review mode',
    '## Minimal guardrails',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Safety boundary',
    'authorization',
    'bounded non-destructive proof',
    'evidence',
    'remediation priority'
  ]) {
    assert.match(skill, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const checklistIdx = skill.indexOf('## Exploit validation advisor checklist');
  const checksIdx = skill.indexOf('## Recommended deterministic checks');
  const safetyIdx = skill.indexOf('## Safety boundary');

  assert.ok(checklistIdx > checksIdx, 'Checklist should be after Recommended deterministic checks');
  assert.ok(checklistIdx < safetyIdx, 'Checklist should be before Safety boundary');
});

test('detection-rules-engineer documents detection advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-detection-rules-engineer', 'SKILL.md'), 'utf8');

  for (const text of ['## Advisor review protocol', 'telemetry prerequisites', 'detection logic', 'false positives', 'tuning', 'test data', 'response path']) {
    assert.match(skill, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const headings = [
    '## Advisor review protocol',
    '### Advisor review mode',
    '### Design review mode',
    '## Minimal guardrails',
    '## Output contract',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Detection advisor checklist',
    '## Safety boundary'
  ];
  let lastIndex = -1;
  for (const heading of headings) {
    const idx = skill.indexOf(heading, lastIndex + 1);
    assert.ok(idx > lastIndex, `Expected '${heading}' to appear after position ${lastIndex}, got ${idx}`);
    lastIndex = idx;
  }
});

test('incident-triage-lead documents triage advisor focus', async () => {
  const skill = await readFile(path.join(rootDir, 'skills', 'linmas-incident-triage-lead', 'SKILL.md'), 'utf8');

  for (const text of ['## Advisor review protocol', 'evidence integrity', 'incident scope', 'containment/recovery trade-offs', 'ownership', 'rollback']) {
    assert.match(skill, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const headings = [
    '## Advisor review protocol',
    '### Advisor review mode',
    '### Design review mode',
    '## Minimal guardrails',
    '## Output contract',
    '## Quality rubric',
    '## Recommended deterministic checks',
    '## Incident triage advisor checklist',
    '## Safety boundary'
  ];
  let lastIndex = -1;
  for (const heading of headings) {
    const idx = skill.indexOf(heading, lastIndex + 1);
    assert.ok(idx > lastIndex, `Expected '${heading}' to appear after position ${lastIndex}, got ${idx}`);
    lastIndex = idx;
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
