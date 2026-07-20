const FAILURE_CLASSES = new Set([
  'provider-configuration', 'provider-authentication', 'provider-rate-limit',
  'provider-timeout', 'provider-transport', 'normalization', 'timeout'
]);

const STAGES = new Set([
  'provider-configuration', 'binary-discovery', 'capability-startup',
  'authentication', 'model-discovery', 'model-selection', 'provider-execution',
  'response-read', 'normalization', 'mcp-execution'
]);

const TRANSMISSION_STATES = new Set(['not-started', 'attempted', 'unknown']);

const CODE_BY_CLASS = Object.freeze({
  'provider-configuration': 'PROVIDER_FAILURE',
  'provider-authentication': 'PROVIDER_FAILURE',
  'provider-rate-limit': 'PROVIDER_FAILURE',
  'provider-timeout': 'TIMEOUT',
  'provider-transport': 'PROVIDER_FAILURE',
  normalization: 'INVALID_INPUT',
  timeout: 'TIMEOUT'
});

export function toPublicReviewError(error, { transmitting = false } = {}) {
  const category = error?.toolCode ?? error?.failureClass ?? error?.category;
  const code = category === 'invalid_path' ? 'INVALID_PATH'
    : category === 'input_too_large' ? 'INPUT_TOO_LARGE'
      : category === 'output_too_large' ? 'OUTPUT_TOO_LARGE'
        : category === 'write_target_exists' ? 'WRITE_TARGET_EXISTS'
          : category === 'contract_violation' || category === 'contract' ? 'CONTRACT_VIOLATION'
            : CODE_BY_CLASS[category] ?? 'INVALID_INPUT';
  const failureClass = FAILURE_CLASSES.has(category) ? category : null;
  const result = { code, message: publicMessage(code, transmitting) };
  if (failureClass) {
    result.schemaVersion = 1;
    result.failureClass = failureClass;
    result.stage = STAGES.has(error?.stage) ? error.stage : defaultStage(failureClass);
    result.reasonCode = safeReasonCode(error?.reasonCode, failureClass);
    result.retryable = typeof error?.retryable === 'boolean' ? error.retryable : defaultRetryable(failureClass);
    if (typeof error?.provider === 'string' && error.provider) result.provider = error.provider;
    result.transmissionState = TRANSMISSION_STATES.has(error?.transmissionState) ? error.transmissionState : (transmitting ? 'unknown' : 'not-started');
    result.message = curatedMessage(error, result.reasonCode, transmitting);
  }
  return result;
}

function publicMessage(code, transmitting) {
  return transmitting && (code === 'PROVIDER_FAILURE' || code === 'TIMEOUT')
    ? 'Provider execution did not complete. Structured diagnostic metadata is provided; sensitive provider details are omitted.'
    : `Linmas tool rejected the request (${code}).`;
}

function curatedMessage(error, reasonCode, transmitting) {
  if (transmitting && (error?.failureClass?.startsWith?.('provider') || error?.failureClass === 'timeout')) {
    return reasonCode === 'MODEL_NOT_AVAILABLE'
      ? 'Requested model is not visible to the authenticated provider account.'
      : reasonCode === 'AUTHENTICATION_REQUIRED'
        ? 'The provider is not authenticated in the Linmas execution environment.'
          : publicMessage('PROVIDER_FAILURE', true);
  }
  return publicMessage('PROVIDER_FAILURE', transmitting);
}

function defaultStage(failureClass) {
  return failureClass === 'provider-timeout' || failureClass === 'timeout' ? 'mcp-execution' : failureClass === 'normalization' ? 'normalization' : 'provider-execution';
}

function defaultRetryable(failureClass) {
  return failureClass === 'provider-rate-limit' || failureClass === 'provider-timeout' || failureClass === 'provider-transport' || failureClass === 'timeout';
}

function safeReasonCode(value, failureClass) {
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)) return value;
  return failureClass === 'provider-authentication' ? 'AUTHENTICATION_REQUIRED'
    : failureClass === 'provider-rate-limit' ? 'EXECUTION_RATE_LIMITED'
      : failureClass === 'provider-timeout' || failureClass === 'timeout' ? 'EXECUTION_TIMEOUT'
        : failureClass === 'normalization' ? 'RESPONSE_INVALID' : 'UNKNOWN_PROVIDER_FAILURE';
}
