import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvaluationCases } from '../src/evaluation/load-cases.mjs';
import { evaluateReviewResult } from '../src/evaluation/evaluate-result.mjs';
import { formatEvaluationSummary } from '../src/evaluation/format-report.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.argv[2] || path.join(rootDir, 'evaluations/cases'));
let cases;
try { cases = loadEvaluationCases(root); } catch (error) { console.error(`Offline evaluation failed: ${error.message}`); process.exitCode = 1; }
if (cases) {
  const results = cases.map(({ caseData, caseDir }) => evaluateReviewResult(caseData, JSON.parse(fs.readFileSync(path.join(caseDir, 'good-result.json'), 'utf8'))));
  const report = { schemaVersion: 1, mode: 'offline', results };
  process.stdout.write(formatEvaluationSummary(report));
  if (results.some((item) => !item.passed)) process.exitCode = 1;
}
