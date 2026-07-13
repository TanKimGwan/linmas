import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../src/policy/evaluate-policy.mjs';

const pack = {
  schemaVersion: 1,
  id: 'baseline-appsec',
  version: '1.0.0',
  rules: [
    { id: 'checks', type: 'minimum-checks', checks: ['security regression test'] },
    { id: 'high', type: 'finding-threshold', severities: ['Critical', 'High'], statuses: ['Confirmed finding'], status: 'blocked' },
    { id: 'evidence', type: 'require-evidence' },
    { id: 'verification', type: 'require-verification' }
  ]
};

const review = {
  schemaVersion: 1,
  caseId: 'case-1',
  specialist: 'secure-code-reviewer',
  findings: [],
  deterministicChecks: [{ id: 'security regression test', completed: true }],
  safetyBoundary: { satisfied: true, humanReviewRequired: true }
};

test('blocks contract or safety failure regardless of pack rules', () => {
  const result = evaluatePolicy(pack, { ...review, safetyBoundary: { satisfied: false, humanReviewRequired: true } });
  assert.equal(result.decision, 'blocked');
  assert.match(result.rules[0].reason, /safety boundary/);
});

test('uses blocked over needs-review and explains every rule', () => {
  const result = evaluatePolicy(pack, {
    ...review,
    deterministicChecks: [{ id: 'security regression test', completed: false }],
    findings: [{ id: 'F-1', severity: 'High', status: 'Confirmed finding', evidence: 'trace', verification: 'test' }]
  });
  assert.equal(result.decision, 'blocked');
  assert.equal(result.rules.every((rule) => typeof rule.reason === 'string' && rule.reason.length > 0), true);
  assert.deepEqual(result.outstandingChecks, ['security regression test']);
});

test('pass still requires human review and carries a disclaimer', () => {
  const result = evaluatePolicy(pack, review);
  assert.equal(result.decision, 'pass');
  assert.equal(result.humanReviewRequired, true);
  assert.match(result.disclaimer, /does not prove security or compliance/i);
});

test('require-evidence and require-verification produce needs-review', () => {
  const result = evaluatePolicy(pack, {
    ...review,
    findings: [{ id: 'F-2', severity: 'Medium', status: 'Recommendation', evidence: '', verification: '' }]
  });
  assert.equal(result.decision, 'needs-review');
  assert.match(result.rules.find((rule) => rule.id === 'evidence').reason, /F-2/);
  assert.match(result.rules.find((rule) => rule.id === 'verification').reason, /F-2/);
});
