import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvaluationCases } from '../src/evaluation/load-cases.mjs';
import { validateEvaluationCase } from '../src/evaluation/validate-case.mjs';
import { EXPECTED_SKILLS } from '../src/core/list-skills.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../evaluations/cases');
const validCase = { schemaVersion: 1, id: 'secure-code/sql-injection-001', title: 'SQL query interpolation', specialist: 'secure-code-reviewer', mode: 'advisor-review', scope: { authorized: true, description: 'Synthetic defensive evaluation' }, input: { type: 'code', contentFile: 'input.js.txt' }, expectations: { requiredFindings: [{ id: 'sql-injection', statuses: ['Confirmed finding'], severities: ['High'], evidenceAnchors: ['SELECT', 'query'], requiredFields: ['affectedSurface', 'preconditions', 'remediation', 'verification'], critical: true }], forbiddenClaims: ['active exploitation observed'], requiredChecks: ['security regression test'], requiredSafetyBoundary: true }, metadata: { origin: 'synthetic', license: 'CC0-1.0', difficulty: 'basic', tags: ['injection'] } };

test('validateEvaluationCase accepts schema v1 and rejects unsupported versions', () => {
  assert.equal(validateEvaluationCase(validCase).id, validCase.id);
  assert.throws(() => validateEvaluationCase({ ...validCase, schemaVersion: 2 }), /unsupported schemaVersion 2/);
});

test('loadEvaluationCases rejects input traversal and symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-eval-'));
  const dir = path.join(root, 'bad'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'outside.txt'), 'secret');
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({ ...validCase, id: 'bad/traversal', input: { type: 'code', contentFile: '../outside.txt' } }));
  assert.throws(() => loadEvaluationCases(root), /outside case directory/);
});

test('portfolio covers every non-router specialist and control tags', () => {
  if (!fs.existsSync(rootDir)) return;
  const cases = loadEvaluationCases(rootDir);
  const specialists = new Set(cases.map(({ caseData }) => caseData.specialist));
  for (const skill of EXPECTED_SKILLS.filter((name) => name !== 'security-domain-router')) assert.ok(specialists.has(skill), `missing case for ${skill}`);
  const tags = new Set(cases.flatMap(({ caseData }) => caseData.metadata.tags));
  for (const tag of ['control', 'insufficient-context', 'secret-redaction', 'safety-refusal']) assert.ok(tags.has(tag), `missing ${tag}`);
  assert.ok(cases.length >= 15 && cases.length <= 20);
});
