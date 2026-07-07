import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('cli smoke: list and onboard exit successfully', () => {
  const list = spawnSync('node', ['bin/linmas.mjs', 'list'], { encoding: 'utf8' });
  const onboard = spawnSync('node', ['bin/linmas.mjs', 'onboard'], { encoding: 'utf8' });

  assert.equal(list.status, 0);
  assert.match(list.stdout, /Available Linmas skills:/);
  assert.equal(onboard.status, 0);
  assert.match(onboard.stdout, /Linmas onboarding:/);
});
