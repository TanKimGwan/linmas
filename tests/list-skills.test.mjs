import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills } from '../src/core/list-skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('listSkills returns installable skills derived from the filesystem in validator order', () => {
  const skills = listSkills(rootDir);
  const expectedNames = fs.readdirSync(path.join(rootDir, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'security')
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(rootDir, 'skills', name, 'SKILL.md')))
    .sort();

  assert.deepEqual(skills.map((skill) => skill.name), expectedNames);
  assert.ok(skills.length > 0);
  assert.match(skills[0].description, /security|review|incident|cloud/i);
});


test('listSkills includes absolute source and skill file paths', () => {
  const skills = listSkills(rootDir);
  assert.ok(path.isAbsolute(skills[0].sourceDir));
  assert.ok(path.isAbsolute(skills[0].skillFile));
  assert.equal(path.basename(skills[0].skillFile), 'SKILL.md');
});
