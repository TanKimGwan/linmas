import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills, EXPECTED_SKILLS } from '../src/core/list-skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('listSkills returns only first-class skills in validator order', () => {
  const skills = listSkills(rootDir);
  assert.deepEqual(skills.map((skill) => skill.name), EXPECTED_SKILLS);
  assert.equal(skills.length, 11);
  assert.match(skills[0].description, /security|review|incident|cloud/i);
});
