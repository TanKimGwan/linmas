import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_SKILL_IDS,
  SPECIALIST_IDS,
  resolveSkill,
  toSpecialistId
} from '../src/core/skill-catalog.mjs';

test('public skill inventory is Linmas-namespaced while specialist IDs remain stable', () => {
  assert.equal(PUBLIC_SKILL_IDS.length, 11);
  assert.ok(PUBLIC_SKILL_IDS.every((name) => name.startsWith('linmas-')));
  assert.ok(SPECIALIST_IDS.includes('secure-code-reviewer'));
  assert.ok(!SPECIALIST_IDS.includes('linmas-secure-code-reviewer'));
});

test('canonical and legacy names resolve to one catalog entry', () => {
  const canonical = resolveSkill('linmas-secure-code-reviewer');
  const legacy = resolveSkill('secure-code-reviewer');

  assert.equal(canonical, legacy);
  assert.equal(canonical.skillId, 'linmas-secure-code-reviewer');
  assert.equal(canonical.specialistId, 'secure-code-reviewer');
  assert.deepEqual(canonical.legacyAliases, ['secure-code-reviewer']);
});

test('router identity is namespaced but cannot resolve to an executable specialist', () => {
  assert.equal(resolveSkill('linmas-security-domain-router').kind, 'router');
  assert.equal(resolveSkill('security-domain-router').kind, 'router');
  assert.equal(toSpecialistId('linmas-security-domain-router'), null);
});

test('unknown and malformed skill names fail closed', () => {
  assert.equal(resolveSkill('unknown-skill'), null);
  assert.equal(resolveSkill(''), null);
  assert.equal(resolveSkill(null), null);
});
