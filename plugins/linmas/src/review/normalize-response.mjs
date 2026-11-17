import { validateReviewResult } from '../evaluation/validate-result.mjs';
import { EXIT_CODES, ReviewError } from './errors.mjs';

export function normalizeProviderResponse(runResult, { caseId, specialist }) {
  let value;
  try {
    value = JSON.parse(runResult.rawResponse);
  } catch {
    throw invalidJsonError(runResult, 'invalid JSON');
  }
  // A ReviewResult must be a JSON object; null, arrays, and primitives are not.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidJsonError(runResult, 'JSON value is not an object');
  value.caseId ??= caseId;
  value.specialist ??= specialist;
  value.modelMetadata = {
    provider: runResult.provider,
    model: runResult.model,
    usage: runResult.usage,
    requestId: runResult.requestId
  };
  try {
    return validateReviewResult(value, { source: `${runResult.provider} response` });
  } catch (error) {
    throw new ReviewError('provider response violated the ReviewResult contract', 'normalization', EXIT_CODES.CONTRACT, {
      stage: 'normalization', reasonCode: 'REVIEW_RESULT_INVALID', retryable: false,
      provider: runResult?.provider ?? null, transmissionState: 'response-received'
    });
  }
}

function invalidJsonError(runResult, detail) {
  return new ReviewError(`provider response failed contract validation: ${detail}`, 'provider-response-invalid', EXIT_CODES.PROVIDER, {
    stage: 'response-read', reasonCode: 'RESPONSE_JSON_INVALID', retryable: false,
    provider: runResult?.provider ?? null, transmissionState: 'response-received'
  });
}
