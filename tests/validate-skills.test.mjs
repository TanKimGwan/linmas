import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

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
