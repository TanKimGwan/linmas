import { createHash } from 'node:crypto';
import { normalizeProviderResponse } from '../review/normalize-response.mjs';
import { validateReviewResult } from './validate-result.mjs';

// Keep live evaluation on the same provider-normalization boundary as `linmas review`.
// The validator remains here as a defensive second check for report generation.
import { evaluateReviewResult } from './evaluate-result.mjs';

export async function runLiveEvaluation({ cases, runner, now = new Date(), maxCases = 20, attempts = 2 }) {
  if (!Number.isInteger(maxCases) || maxCases < 1) throw new Error('maxCases must be a positive integer');
  const selected = cases.slice(0, maxCases);
  const results = [];
  for (const item of selected) {
    try {
      const response = await withTransientRetry(() => runner.run({ system: buildSystem(item.caseData), user: item.inputText }), attempts);
      const normalized = normalizeProviderResponse(response, {
        caseId: item.caseData.id,
        specialist: item.caseData.specialist
      });
      validateReviewResult(normalized, { source: item.caseData.id });
      results.push({ ...evaluateReviewResult(item.caseData, normalized), provider: response.provider, model: response.model, usage: response.usage });
    } catch (error) {
      results.push({ caseId: item.caseData.id, passed: false, dimensions: {}, failureClass: error.failureClass || 'normalization-failed', failures: [{ dimension: 'live', code: error.failureClass || 'normalization-failed', findingId: null, message: error.message }] });
    }
  }
  return { schemaVersion: 1, mode: 'live', generatedAt: now.toISOString(), runner: { provider: runner.id, model: runner.model }, caseSetSha256: createHash('sha256').update(selected.map((item) => JSON.stringify(item.caseData)).join('\n')).digest('hex'), results };
}

async function withTransientRetry(operation, attempts) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (!['provider-rate-limit', 'provider-transport'].includes(error.failureClass) || attempt >= attempts) throw error;
    }
  }
}

function buildSystem(caseData) {
  return `You are the Linmas ${caseData.specialist}. Return only JSON matching ReviewResult schemaVersion 1. Work only in the supplied authorized scope. Human review remains required.`;
}
