import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReviewCapsule, fingerprintReviewInput } from '../src/review/build-capsule.mjs';
import { compareReviewCapsules, formatSecurityDelta, loadAndCompareCapsules } from '../src/review/compare-capsules.mjs';

const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };

function finding(id, severity = 'High', status = 'Confirmed finding') {
  return {
    id, status, severity, evidence: `Evidence for ${id}.`, affectedSurface: 'synthetic surface',
    preconditions: 'Synthetic precondition.', remediation: 'Apply the bounded remediation.', verification: 'Run a regression test.'
  };
}

function capsule({ findings, specialist = 'secure-code-reviewer', provider = 'fixture', model = 'fixture', source = 'input.diff', decision = 'blocked' }) {
  return buildReviewCapsule({
    input: { source, bytes: 3, sha256: fingerprintReviewInput(Buffer.from(source.slice(0, 3))) },
    execution: { mode: 'offline-fixture', provider, authMode: 'unavailable', model, modelVerified: false },
    review: {
      schemaVersion: 1, caseId: 'delta/case', specialist,
      modelMetadata: { provider, model, usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic capsule.'], findings,
      deterministicChecks: [], safetyBoundary
    },
    policyResult: {
      schemaVersion: 1, policy: { id: 'baseline-appsec', version: '1.0.0' },
      review: { caseId: 'delta/case', specialist }, decision, rules: [], completedChecks: [], outstandingChecks: [],
      humanReviewRequired: true,
      disclaimer: 'This decision only evaluates declared conditions and does not prove security or compliance.'
    },
    now: new Date('2026-07-18T15:00:00.000Z')
  });
}

test('computes deterministic added, resolved, persistent, and changed findings', () => {
  const before = capsule({ findings: [finding('B'), finding('A'), finding('CHANGED', 'High')] });
  const after = capsule({ findings: [finding('C'), finding('CHANGED', 'Low'), finding('B')] });
  const delta = compareReviewCapsules(before, after);
  assert.deepEqual(delta.findings.added, ['C']);
  assert.deepEqual(delta.findings.resolved, ['A']);
  assert.deepEqual(delta.findings.persistent, ['B', 'CHANGED']);
  assert.deepEqual(delta.findings.changed, [{ id: 'CHANGED', before: { severity: 'High', status: 'Confirmed finding' }, after: { severity: 'Low', status: 'Confirmed finding' } }]);
});

test('rejects duplicate IDs, incompatible specialists, and unsupported capsule versions', () => {
  const valid = capsule({ findings: [finding('A')] });
  const duplicate = structuredClone(valid);
  duplicate.review.findings.push(structuredClone(duplicate.review.findings[0]));
  assert.throws(() => compareReviewCapsules(duplicate, valid), /duplicate finding/i);

  const incompatible = capsule({ findings: [], specialist: 'cloud-hardening-architect' });
  assert.throws(() => compareReviewCapsules(valid, incompatible), /specialist/i);

  const unsupported = structuredClone(valid);
  unsupported.schemaVersion = 2;
  assert.throws(() => compareReviewCapsules(unsupported, valid), /schemaVersion/i);
});

test('provider, model, and input differences produce comparability warnings', () => {
  const before = capsule({ findings: [], provider: 'fixture', model: 'fixture-a', source: 'before.diff' });
  const after = capsule({ findings: [], provider: 'fixture-two', model: 'fixture-b', source: 'after.diff' });
  const delta = compareReviewCapsules(before, after);
  assert.ok(delta.warnings.some((item) => /provider/i.test(item)));
  assert.ok(delta.warnings.some((item) => /model/i.test(item)));
  assert.ok(delta.warnings.some((item) => /input/i.test(item)));
});

test('formatted delta keeps policy separate and never implies approval or remediation proof', () => {
  const before = capsule({ findings: [finding('A')], decision: 'blocked' });
  const after = capsule({ findings: [], decision: 'pass' });
  const output = formatSecurityDelta(compareReviewCapsules(before, after));
  assert.match(output, /Policy transition\s+blocked -> pass/);
  assert.match(output, /absence.*does not prove remediation/i);
  assert.match(output, /Human review remains required/);
  assert.doesNotMatch(output, /\bis secure\b|\bapproved\b|\bfixed\b/i);
});

test('loads and validates both capsule files before comparison', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-delta-'));
  try {
    const beforePath = path.join(root, 'before.json');
    const afterPath = path.join(root, 'after.json');
    await fs.writeFile(beforePath, JSON.stringify(capsule({ findings: [finding('A')] })));
    await fs.writeFile(afterPath, JSON.stringify(capsule({ findings: [] })));
    const delta = await loadAndCompareCapsules(beforePath, afterPath);
    assert.deepEqual(delta.findings.resolved, ['A']);

    await fs.writeFile(afterPath, '{malformed');
    await assert.rejects(loadAndCompareCapsules(beforePath, afterPath), /invalid JSON/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
