import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicyPack } from '../src/policy/validate-pack.mjs';

const validPack = {
  schemaVersion: 1,
  id: 'baseline-appsec',
  version: '1.0.0',
  description: 'Baseline application security review conditions',
  specialists: ['secure-code-reviewer'],
  modes: ['advisor-review'],
  acceptedInputs: ['text', 'diff', 'code'],
  rules: [
    { id: 'checks', type: 'minimum-checks', checks: ['security regression test'] },
    { id: 'high', type: 'finding-threshold', severities: ['Critical', 'High'], status: 'blocked' }
  ],
  humanReview: { required: true, statement: 'A human reviewer must approve the decision.' }
};

test('accepts schema version 1 and returns a clone', () => {
  const result = validatePolicyPack(validPack, { source: 'test' });
  assert.deepEqual(result, validPack);
  assert.notEqual(result, validPack);
});

test('rejects executable, unknown, and safety-downgrade fields', () => {
  assert.throws(() => validatePolicyPack({ ...validPack, command: 'scan' }), /unknown field command/);
  assert.throws(() => validatePolicyPack({ ...validPack, humanReview: { required: false, statement: 'none' } }), /human review must be required/);
  assert.throws(() => validatePolicyPack({ ...validPack, description: 'SOC 2 certified policy' }), /certification claim/);
  assert.throws(() => validatePolicyPack({ ...validPack, rules: [{ id: 'bad', type: 'expression', expression: 'true' }] }), /unknown rule field expression/);
  assert.throws(() => validatePolicyPack({ ...validPack, rules: [{ id: 'bad', type: 'expression' }] }), /unsupported rule type/);
});

test('rejects unsupported versions and unknown rule fields', () => {
  assert.throws(() => validatePolicyPack({ ...validPack, schemaVersion: 2 }), /unsupported schemaVersion 2/);
  assert.throws(() => validatePolicyPack({ ...validPack, rules: [{ ...validPack.rules[0], template: 'x' }] }), /unknown rule field template/);
  assert.throws(() => validatePolicyPack({ ...validPack, specialists: ['unknown-specialist'] }), /unknown specialist/);
  assert.throws(() => validatePolicyPack({ ...validPack, modes: ['execute'] }), /unsupported mode/);
  assert.throws(() => validatePolicyPack({ ...validPack, rules: [{ id: 'threshold', type: 'finding-threshold' }] }), /rule.severities is required/);
});

test('T9-03 rule severities and statuses must use the exact ReviewResult enums', async () => {
  const { evaluatePolicy } = await import('../src/policy/evaluate-policy.mjs');
  const withRule = (rule) => ({ ...validPack, rules: [rule] });
  for (const severities of [['critical'], ['HIGH'], ['Crtical'], ['Critical', 'critical'], []]) {
    assert.throws(() => validatePolicyPack(withRule({ id: 'high', type: 'finding-threshold', severities, status: 'blocked' })), /rule\.severities/, JSON.stringify(severities));
  }
  for (const statuses of [['confirmed'], ['Confirmed Finding'], ['needs validation'], []]) {
    assert.throws(() => validatePolicyPack(withRule({ id: 'high', type: 'finding-threshold', severities: ['Critical'], statuses, status: 'blocked' })), /rule\.statuses/, JSON.stringify(statuses));
  }
  // The exact enums remain valid and block a matching Critical finding.
  const pack = validatePolicyPack(withRule({ id: 'high', type: 'finding-threshold', severities: ['Critical', 'High', 'Medium', 'Low', 'Info'], statuses: ['Confirmed finding', 'Needs validation', 'Recommendation'], status: 'blocked' }));
  const result = evaluatePolicy(pack, {
    findings: [{ id: 'F-1', severity: 'Critical', status: 'Confirmed finding', evidence: 'e', verification: 'v' }],
    deterministicChecks: [],
    safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' }
  });
  assert.equal(result.decision, 'blocked');
});

test('T9-03 every built-in policy pack remains valid', async () => {
  const { loadPolicyPack } = await import('../src/policy/load-pack.mjs');
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  for (const id of ['baseline-appsec', 'cloud-change', 'release-security']) assert.equal(loadPolicyPack({ id, rootDir }).id, id);
});
