import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvaluationCases } from '../src/evaluation/load-cases.mjs';
import { runLiveEvaluation } from '../src/evaluation/run-live-evaluation.mjs';
import { createClaudeRunner } from '../src/providers/claude-api.mjs';
import { formatEvaluationReport } from '../src/evaluation/format-report.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxCases = Number(process.env.LINMAS_EVAL_MAX_CASES || 20);
if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 20) throw new Error('LINMAS_EVAL_MAX_CASES must be an integer from 1 to 20');
if (!process.env.LINMAS_EVAL_REPORT) throw new Error('LINMAS_EVAL_REPORT is required');
const cases = loadEvaluationCases(path.join(rootDir, 'evaluations/cases'));
const runner = createClaudeRunner({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.LINMAS_EVAL_MODEL });
const report = await runLiveEvaluation({ cases, runner, maxCases });
const reportPath = path.resolve(rootDir, process.env.LINMAS_EVAL_REPORT);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, formatEvaluationReport(report));
process.stdout.write(`Live evaluation completed: ${report.results.length} cases\n`);
