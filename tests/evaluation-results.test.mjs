import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewResult } from '../src/evaluation/validate-result.mjs';

const good = { schemaVersion: 1, caseId: 'secure-code/sql-injection-001', specialist: 'secure-code-reviewer', modelMetadata: { provider: 'fixture', model: 'golden' }, scopeAndAssumptions: ['Only supplied synthetic code was reviewed.'], findings: [{ id: 'sql-injection', status: 'Confirmed finding', severity: 'High', evidence: 'Interpolated request.query.name in SELECT query', affectedSurface: 'User lookup query', preconditions: 'Attacker controls request.query.name', remediation: 'Use a parameterized query', verification: 'Add a regression test with quote and boolean payload characters' }], deterministicChecks: ['security regression test'], safetyBoundary: { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' } };

test('validateReviewResult accepts contract-complete result and normalizes checks/safety', () => {
  const result = validateReviewResult(good);
  assert.equal(result.findings[0].status, 'Confirmed finding');
  assert.deepEqual(result.deterministicChecks, [{ id: 'security regression test', completed: true }]);
  assert.equal(result.safetyBoundary.humanReviewRequired, true);
});

test('validateReviewResult rejects missing verification, unknown status, and duplicate IDs', () => {
  const invalid = structuredClone(good); delete invalid.findings[0].verification; invalid.findings[0].status = 'Approved';
  assert.throws(() => validateReviewResult(invalid), /invalid status|verification/);
  const duplicate = structuredClone(good); duplicate.findings.push(structuredClone(duplicate.findings[0]));
  assert.throws(() => validateReviewResult(duplicate), /duplicate finding id/);
});

test('F-012 deterministic checks reject a duplicated ID', () => {
  const duplicate = structuredClone(good);
  duplicate.deterministicChecks = [
    { id: 'security regression test', completed: true },
    { id: 'security regression test', completed: false }
  ];
  assert.throws(() => validateReviewResult(duplicate), /duplicate deterministic check id/);
});

test('F-013 actual NUL is rejected from every bounded ReviewResult text surface', () => {
  const mutations = [
    (value) => { value.caseId = 'case\0id'; },
    (value) => { value.modelMetadata.provider = 'provider\0id'; },
    (value) => { value.modelMetadata.model = 'model\0id'; },
    (value) => { value.modelMetadata.generatedAt = 'time\0value'; },
    (value) => { value.modelMetadata.requestId = 'request\0id'; },
    (value) => { value.scopeAndAssumptions[0] = 'scope\0value'; },
    (value) => { value.findings[0].evidence = 'evidence\0value'; },
    (value) => { value.deterministicChecks = ['check\0id']; },
    (value) => { value.safetyBoundary.statement = 'Human review remains required.\0'; }
  ];
  for (const mutate of mutations) {
    const value = structuredClone(good);
    mutate(value);
    assert.throws(() => validateReviewResult(value), /NUL/);
  }
});
