import { validateReviewResult } from '../evaluation/validate-result.mjs';
import { EXIT_CODES, ReviewError } from './errors.mjs';

export function normalizeProviderResponse(runResult, { caseId, specialist }) {
  try {
    const value = JSON.parse(runResult.rawResponse);
    value.caseId ??= caseId;
    value.specialist ??= specialist;
    value.modelMetadata = {
      provider: runResult.provider,
      model: runResult.model,
      usage: runResult.usage,
      requestId: runResult.requestId
    };
    return validateReviewResult(value, { source: `${runResult.provider} response` });
  } catch (error) {
    throw new ReviewError(`provider response failed contract validation: ${error.message}`, 'normalization', EXIT_CODES.CONTRACT, {
      stage: 'normalization', reasonCode: 'RESPONSE_INVALID', retryable: false,
      provider: runResult?.provider ?? null, transmissionState: 'attempted'
    });
  }
}
