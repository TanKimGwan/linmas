import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills, EXPECTED_SKILLS } from '../src/core/list-skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const CONTRACT_SKILLS = [
  'security-operations-lead',
  'smart-contract-reviewer',
  'exploit-validation-specialist',
  'threat-research-analyst',
  'detection-rules-engineer',
  'incident-triage-lead',
  'controls-compliance-reviewer',
  'cloud-hardening-architect',
  'secure-systems-architect',
  'secure-code-reviewer',
  'security-domain-router'
];

const PUBLIC_SKILLS = CONTRACT_SKILLS.map((name) => `linmas-${name}`);

function writeFixtureSkill(rootDir, name) {
  const skillDir = path.join(rootDir, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\ndescription: Fixture description for ${name}.\n---\n`,
    'utf8'
  );
}

function createFixtureRoot(skillNames) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-list-skills-'));
  fs.mkdirSync(path.join(fixtureRoot, 'skills'), { recursive: true });
  for (const skillName of skillNames) {
    writeFixtureSkill(fixtureRoot, skillName);
  }
  return fixtureRoot;
}

test('EXPECTED_SKILLS exports the shared explicit inventory contract', () => {
  assert.deepEqual(EXPECTED_SKILLS, CONTRACT_SKILLS);
});

test('listSkills returns repo skills in shared contract order', () => {
  const skills = listSkills(rootDir);
  assert.deepEqual(skills.map((skill) => skill.name), PUBLIC_SKILLS);
  assert.deepEqual(skills.map((skill) => skill.specialistId), CONTRACT_SKILLS);
  assert.match(skills[0].description, /security|review|incident|cloud/i);
});

test('listSkills ignores unexpected skill directories in controlled fixtures', () => {
  const fixtureRoot = createFixtureRoot([...PUBLIC_SKILLS, 'unexpected-skill']);
  const skills = listSkills(fixtureRoot);

  assert.deepEqual(skills.map((skill) => skill.name), PUBLIC_SKILLS);
});

test('listSkills fails when an expected skill is missing in controlled fixtures', () => {
  const fixtureRoot = createFixtureRoot(PUBLIC_SKILLS.slice(0, -1));

  assert.throws(() => listSkills(fixtureRoot), /ENOENT/);
});

test('listSkills includes absolute source and skill file paths', () => {
  const skills = listSkills(rootDir);
  assert.ok(path.isAbsolute(skills[0].sourceDir));
  assert.ok(path.isAbsolute(skills[0].skillFile));
  assert.equal(path.basename(skills[0].skillFile), 'SKILL.md');
});

test('listSkills uses a safe fallback when a skill has no description metadata', () => {
  const fixtureRoot = createFixtureRoot(PUBLIC_SKILLS);
  const skillFile = path.join(fixtureRoot, 'skills', PUBLIC_SKILLS[0], 'SKILL.md');
  fs.writeFileSync(skillFile, '---\ntitle: Fixture without description\n---\n', 'utf8');

  const skills = listSkills(fixtureRoot);

  assert.equal(skills[0].description, 'No description found');
});
