import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEvaluationSummary } from '../src/evaluation/format-report.mjs';

test('formats concise deterministic evaluation summary', () => {
  const text = formatEvaluationSummary({ results: [{ caseId: 'case-1', passed: false, failures: [{ dimension: 'safety', code: 'missing-human-review', message: 'human review required' }] }] });
  assert.match(text, /Offline evaluation failed: 0\/1 cases/);
  assert.match(text, /case-1 \[safety\/missing-human-review\]/);
});
