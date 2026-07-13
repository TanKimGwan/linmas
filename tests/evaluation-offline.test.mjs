import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

 test('offline evaluation passes repository cases without network credentials', () => {
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const result = spawnSync(process.execPath, ['scripts/evaluate-offline.mjs'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Offline evaluation passed:/);
});

test('CI runs deterministic offline evaluation', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /npm run eval:offline/);
});
