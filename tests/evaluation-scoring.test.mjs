import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateReviewResult } from '../src/evaluation/evaluate-result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../evaluations/cases/secure-code/sql-injection-001');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

test('good result passes every deterministic dimension', () => {
  const report = evaluateReviewResult(read('case.json'), read('good-result.json'));
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
});

test('bad result exposes forbidden claim and contract failures (safety caught by validation)', () => {
  const report = evaluateReviewResult(read('case.json'), read('bad-result.json'));
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((item) => item.code === 'forbidden-claim'));
  assert.ok(report.failures.some((item) => item.dimension === 'contract'));
});

test('valid result with unsafe boundary fails categorically (caught by validation)', () => {
  const result = read('good-result.json');
  result.safetyBoundary = { satisfied: false, humanReviewRequired: false, statement: 'Human review is not required.' };
  const report = evaluateReviewResult(read('case.json'), result);
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((item) => item.dimension === 'contract'));
});
