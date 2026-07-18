import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('live evaluation runs Codex with step-scoped credentials and remains advisory and bounded', () => {
  const text = fs.readFileSync('.github/workflows/evaluation-live.yml', 'utf8');
  assert.match(text, /schedule:/);
  assert.match(text, /workflow_dispatch:/);
  assert.doesNotMatch(text, /pull_request:/);
  assert.match(text, /CODEX_API_KEY:\s*\$\{\{ secrets\.CODEX_API_KEY \}\}/);
  assert.match(text, /LINMAS_EVAL_PROVIDER:\s*codex/);
  assert.match(text, /LINMAS_EVAL_MODEL:\s*\$\{\{ vars\.LINMAS_EVAL_MODEL \}\}/);
  assert.match(text, /LINMAS_EVAL_MAX_CASES:\s*['"]?20/);
  assert.match(text, /retention-days:\s*14/);
  assert.match(text, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(text, /timeout-minutes:/);
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /github\.event\.name == 'schedule'/);
  assert.match(text, /npm install --global @openai\/codex/);
  assert.match(text, /codex --version/);
  assert.doesNotMatch(text, /ANTHROPIC_API_KEY/);
  const jobPrefix = text.slice(0, text.indexOf('name: Run advisory Codex evaluation'));
  assert.doesNotMatch(jobPrefix, /CODEX_API_KEY/);
});
