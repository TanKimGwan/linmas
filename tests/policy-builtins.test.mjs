import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadPolicyPack } from '../src/policy/load-pack.mjs';

const rootDir = path.resolve(import.meta.dirname, '..');

test('all built-ins validate and target distinct review conditions', () => {
  const packs = ['baseline-appsec', 'cloud-change', 'release-security'].map((id) => loadPolicyPack({ id, rootDir }));
  assert.deepEqual(packs.map((pack) => pack.id), ['baseline-appsec', 'cloud-change', 'release-security']);
  assert.equal(new Set(packs.map((pack) => JSON.stringify(pack.rules))).size, 3);
  assert.equal(packs.every((pack) => pack.humanReview.required), true);
});

test('cloud and release packs carry their declared conditions', () => {
  const cloud = loadPolicyPack({ id: 'cloud-change', rootDir });
  const release = loadPolicyPack({ id: 'release-security', rootDir });
  assert.equal(cloud.specialists[0], 'cloud-hardening-architect');
  assert.ok(cloud.rules.some((rule) => rule.checks?.includes('least-privilege review')));
  assert.ok(release.rules.some((rule) => rule.checks?.includes('human release review')));
  assert.equal(release.specialists.length, 10);
});
