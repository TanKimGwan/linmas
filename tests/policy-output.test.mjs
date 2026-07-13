import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPolicyResult } from '../src/policy/format-policy.mjs';

const result = {
  schemaVersion: 1,
  policy: { id: 'baseline-appsec', version: '1.0.0' },
  review: { caseId: 'case-1', specialist: 'secure-code-reviewer' },
  decision: 'needs-review',
  rules: [{ id: 'checks', outcome: 'failed', decision: 'needs-review', reason: 'Outstanding checks: security regression test' }],
  completedChecks: [],
  outstandingChecks: ['security regression test'],
  humanReviewRequired: true,
  disclaimer: 'This decision only evaluates declared conditions and does not prove security or compliance.'
};

test('renders decision, reasons, disclaimer, and human review', () => {
  const text = formatPolicyResult(result);
  assert.match(text, /Decision: needs-review/);
  assert.match(text, /Outstanding checks/);
  assert.match(text, /Human review required: yes/);
  assert.match(text, /does not prove security or compliance/i);
});

test('renders parseable schema-versioned JSON', () => {
  assert.deepEqual(JSON.parse(formatPolicyResult(result, { output: 'json' })), result);
});
