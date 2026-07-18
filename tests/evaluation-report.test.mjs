import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEvaluationReport, formatEvaluationSummary } from '../src/evaluation/format-report.mjs';

test('formats concise deterministic evaluation summary', () => {
  const text = formatEvaluationSummary({ results: [{ caseId: 'case-1', passed: false, failures: [{ dimension: 'safety', code: 'missing-human-review', message: 'human review required' }] }] });
  assert.match(text, /Offline evaluation failed: 0\/1 cases/);
  assert.match(text, /case-1 \[safety\/missing-human-review\]/);
});

test('formats full reports as either JSON or text', () => {
  const report = { results: [{ caseId: 'case-1', passed: true, failures: [] }] };
  assert.deepEqual(JSON.parse(formatEvaluationReport(report)), report);
  assert.match(formatEvaluationReport(report, { output: 'text' }), /Offline evaluation passed: 1\/1 cases/);
});
