import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewResult } from '../src/evaluation/validate-result.mjs';

function makeResult(safetyBoundary) {
  return { schemaVersion: 1, caseId: 'x', specialist: 'secure-code-reviewer', modelMetadata: { provider: 'fixture', model: 'test' }, scopeAndAssumptions: ['x'], findings: [], deterministicChecks: [], safetyBoundary };
}

test('rejects a string safety boundary that negates human review', () => {
  assert.throws(() => validateReviewResult(makeResult('Human review is not required.')), /safety boundary/);
});

test('rejects a string with auto-approve contradiction (also contains without human review)', () => {
  assert.throws(
    () => validateReviewResult(makeResult('Human review remains required for critical findings; all other findings may be auto-approved without human review.')),
    /contradictory clauses/
  );
});

test('rejects "automatically approved" when combined with a valid statement', () => {
  assert.throws(
    () => validateReviewResult(makeResult('Human review remains required for all findings. Non-critical findings are automatically approved.')),
    /contradictory clauses/
  );
});

test('rejects "auto-approved" without "without human review" present', () => {
  assert.throws(
    () => validateReviewResult(makeResult('Human review remains required. Critical findings reviewed; others auto-approved.')),
    /contradictory clauses/
  );
});

test('rejects "auto approve" (space) when combined with a valid statement', () => {
  assert.throws(
    () => validateReviewResult(makeResult('Human review remains required. Low severity findings auto approve.')),
    /contradictory clauses/
  );
});

test('rejects "automatically approve" when combined with a valid statement', () => {
  assert.throws(
    () => validateReviewResult(makeResult('Human review remains required. System may automatically approve low severity.')),
    /contradictory clauses/
  );
});

test('rejects full contradictory sentence (required + auto + without)', () => {
  assert.throws(
    () => validateReviewResult(makeResult('Human review remains required for critical findings; all non-critical findings are automatically approved without human review.')),
    /contradictory clauses/
  );
});

test('rejects a string with "without human review" and no valid statement', () => {
  assert.throws(
    () => validateReviewResult(makeResult('The system can operate without human review.')),
    /safety boundary/
  );
});

test('rejects a safety object where humanReviewRequired is false', () => {
  assert.throws(
    () => validateReviewResult(makeResult({ satisfied: false, humanReviewRequired: false, statement: 'Human review remains required.' })),
    /must have satisfied and humanReviewRequired set to true/
  );
});

test('rejects a safety object where satisfied is false even when humanReviewRequired is true', () => {
  assert.throws(
    () => validateReviewResult(makeResult({ satisfied: false, humanReviewRequired: true, statement: 'Human review remains required.' })),
    /must have satisfied and humanReviewRequired set to true/
  );
});

test('rejects a canonical object whose statement contradicts the human-review flags', () => {
  assert.throws(
    () => validateReviewResult(makeResult({
      satisfied: true,
      humanReviewRequired: true,
      statement: 'Human review remains required for critical findings; all others are automatically approved without human review.'
    })),
    /contradictory clauses/
  );
});

test('rejects a canonical object whose statement does not require human review', () => {
  assert.throws(
    () => validateReviewResult(makeResult({ satisfied: true, humanReviewRequired: true, statement: 'Automated processing completed.' })),
    /must require human review/
  );
});

test('accepts a canonical object safety boundary', () => {
  const result = validateReviewResult(makeResult({ satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' }));
  assert.equal(result.safetyBoundary.satisfied, true);
  assert.equal(result.safetyBoundary.humanReviewRequired, true);
  assert.equal(result.safetyBoundary.statement, 'Human review remains required.');
});

test('accepts a valid string and normalizes to canonical object', () => {
  const result = validateReviewResult(makeResult('Human review remains required.'));
  assert.equal(result.safetyBoundary.satisfied, true);
  assert.equal(result.safetyBoundary.humanReviewRequired, true);
  assert.equal(typeof result.safetyBoundary.statement, 'string');
});

test('accepts a statement with "remains required" and additional context that is not contradictory', () => {
  const result = validateReviewResult(makeResult('Human review remains required; harmful operational detail is refused.'));
  assert.equal(result.safetyBoundary.humanReviewRequired, true);
});

test('rejects an object safety boundary with extra unknown fields', () => {
  assert.throws(
    () => validateReviewResult(makeResult({ satisfied: true, humanReviewRequired: true, statement: 'required', autoApprove: false })),
    /unknown safety boundary field/
  );
});
