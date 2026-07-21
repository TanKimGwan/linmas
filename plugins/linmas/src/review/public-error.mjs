const FAILURE_CLASSES = new Set([
  'provider-configuration', 'provider-authentication', 'provider-rate-limit',
  'provider-timeout', 'provider-transport', 'provider-upstream',
  'provider-rejected', 'provider-cancelled', 'provider-response-invalid',
  'normalization', 'timeout'
]);

const STAGES = new Set([
  'argument-validation', 'workspace-validation', 'provider-preflight',
  'provider-configuration', 'binary-discovery', 'capability-startup',
  'authentication', 'model-discovery', 'model-selection', 'provider-execution',
  'response-read', 'normalization', 'capsule-write', 'mcp-execution'
]);

const TRANSMISSION_STATES = new Set([
  'not-attempted', 'attempted', 'response-received', 'normalized', 'capsule-written'
]);

const CODE_BY_CLASS = Object.freeze({
  'provider-configuration': 'PROVIDER_CONFIGURATION_MISSING',
  'provider-authentication': 'PROVIDER_AUTHENTICATION_FAILED',
  'provider-rate-limit': 'PROVIDER_RATE_LIMITED',
  'provider-timeout': 'PROVIDER_TIMEOUT',
  'provider-transport': 'PROVIDER_TRANSPORT_FAILED',
  'provider-upstream': 'PROVIDER_UPSTREAM_FAILED',
  'provider-rejected': 'PROVIDER_REQUEST_REJECTED',
  'provider-cancelled': 'PROVIDER_EXECUTION_CANCELLED',
  'provider-response-invalid': 'PROVIDER_RESPONSE_INVALID',
  normalization: 'REVIEW_RESULT_CONTRACT_VIOLATION',
  timeout: 'MCP_TIMEOUT'
});

const CODE_BY_TOOL = Object.freeze({
  unknown_tool: 'TOOL_UNSUPPORTED',
  invalid_path: 'INVALID_PATH',
  input_too_large: 'INPUT_TOO_LARGE',
  output_too_large: 'OUTPUT_TOO_LARGE',
  write_target_exists: 'WRITE_TARGET_EXISTS',
  contract_violation: 'CONTRACT_VIOLATION',
  contract: 'CONTRACT_VIOLATION',
  input_field_unsupported: 'INPUT_FIELD_UNSUPPORTED',
  input_field_required: 'INPUT_FIELD_REQUIRED',
  input_field_invalid: 'INPUT_FIELD_INVALID',
  input_source_invalid: 'INPUT_SOURCE_INVALID',
  specialist_unsupported: 'SPECIALIST_UNSUPPORTED',
  provider_unsupported: 'PROVIDER_UNSUPPORTED',
  policy_unsupported: 'POLICY_UNSUPPORTED'
});

export const PUBLIC_ERROR_SCHEMA_VERSION = 1;
export const PUBLIC_TRANSMISSION_STATES = Object.freeze([...TRANSMISSION_STATES]);

export function toPublicReviewError(error, { transmitting = false } = {}) {
  const category = error?.toolCode ?? error?.failureClass ?? error?.category;
  const failureClass = FAILURE_CLASSES.has(category) ? category : null;
  const code = failureClass ? CODE_BY_CLASS[failureClass] : CODE_BY_TOOL[category] ?? 'INPUT_FIELD_INVALID';
  const transmissionState = safeTransmissionState(error?.transmissionState, transmitting);
  const result = {
    schemaVersion: PUBLIC_ERROR_SCHEMA_VERSION,
    code,
    message: publicMessage(code),
    stage: safeStage(error?.stage, failureClass, category),
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : defaultRetryable(failureClass, code),
    transmissionState,
    transmissionAttempted: error?.transmissionAttempted ?? transmissionState !== 'not-attempted',
    providerResponseReceived: error?.providerResponseReceived ?? ['response-received', 'normalized', 'capsule-written'].includes(transmissionState),
    capsuleWritten: error?.capsuleWritten ?? transmissionState === 'capsule-written'
  };
  const reasonCode = typeof error?.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.reasonCode)
    ? error.reasonCode
    : defaultReasonCode(failureClass, code);
  if (reasonCode) result.reasonCode = reasonCode;
  if (typeof error?.provider === 'string' && error.provider) result.provider = error.provider;
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599) result.httpStatus = error.httpStatus;
  if (isSafeIdentifier(error?.field)) result.field = error.field;
  const missingRequirements = safeIdentifierList(error?.missingRequirements);
  const allowedValues = safeIdentifierList(error?.allowedValues);
  if (missingRequirements.length) result.missingRequirements = missingRequirements;
  if (allowedValues.length) result.allowedValues = allowedValues;
  return result;
}

function publicMessage(code) {
  return Object.freeze({
    TOOL_UNSUPPORTED: 'The requested Linmas tool is not supported.',
    INPUT_FIELD_UNSUPPORTED: 'The request contains an unsupported field.',
    INPUT_FIELD_REQUIRED: 'A required request field is missing.',
    INPUT_FIELD_INVALID: 'A request field is invalid.',
    INPUT_SOURCE_INVALID: 'Provide exactly one valid review input source.',
    SPECIALIST_UNSUPPORTED: 'The requested specialist is not supported.',
    PROVIDER_UNSUPPORTED: 'The requested provider is not supported.',
    POLICY_UNSUPPORTED: 'The requested policy is not supported.',
    INVALID_PATH: 'The requested path is invalid or outside the workspace.',
    INPUT_TOO_LARGE: 'The request exceeds the bounded input limit.',
    OUTPUT_TOO_LARGE: 'The tool output exceeds the bounded output limit.',
    WRITE_TARGET_EXISTS: 'The requested write target already exists.',
    CONTRACT_VIOLATION: 'The supplied artifact violates the Linmas contract.',
    PROVIDER_CONFIGURATION_MISSING: 'Provider configuration is incomplete.',
    PROVIDER_AUTHENTICATION_FAILED: 'Provider authentication failed.',
    PROVIDER_RATE_LIMITED: 'The provider rate-limited the request.',
    PROVIDER_TIMEOUT: 'The provider request timed out.',
    PROVIDER_TRANSPORT_FAILED: 'The provider transport failed before a response was received.',
    PROVIDER_UPSTREAM_FAILED: 'The provider returned an upstream failure.',
    PROVIDER_REQUEST_REJECTED: 'The provider rejected the request.',
    PROVIDER_EXECUTION_CANCELLED: 'Provider execution was cancelled.',
    PROVIDER_RESPONSE_INVALID: 'The provider response was invalid.',
    REVIEW_RESULT_CONTRACT_VIOLATION: 'The provider response violated the ReviewResult contract.',
    MCP_TIMEOUT: 'The Linmas tool operation timed out.'
  }[code] ?? 'The Linmas tool request failed.');
}

function safeStage(value, failureClass, category) {
  if (STAGES.has(value)) return value;
  if (category?.startsWith?.('input_') || category === 'unknown_tool') return 'argument-validation';
  if (failureClass === 'timeout') return 'mcp-execution';
  if (failureClass === 'normalization' || failureClass === 'provider-response-invalid') return 'normalization';
  return failureClass ? 'provider-execution' : 'argument-validation';
}

function defaultRetryable(failureClass, code) {
  return failureClass === 'provider-rate-limit'
    || failureClass === 'provider-timeout'
    || failureClass === 'provider-transport'
    || failureClass === 'provider-upstream'
    || failureClass === 'timeout'
    || code === 'MCP_TIMEOUT';
}

function defaultReasonCode(failureClass, code) {
  return failureClass === 'provider-configuration' ? 'CONFIGURATION_MISSING'
    : failureClass === 'provider-authentication' ? 'AUTHENTICATION_FAILED'
      : failureClass === 'provider-rate-limit' ? 'RATE_LIMITED'
        : failureClass === 'provider-timeout' || code === 'MCP_TIMEOUT' ? 'EXECUTION_TIMEOUT'
          : failureClass === 'provider-transport' ? 'TRANSPORT_FAILED'
            : failureClass === 'provider-upstream' ? 'UPSTREAM_FAILED'
              : failureClass === 'provider-rejected' ? 'REQUEST_REJECTED'
                : failureClass === 'provider-cancelled' ? 'EXECUTION_CANCELLED'
                  : failureClass === 'provider-response-invalid' ? 'RESPONSE_INVALID'
                    : failureClass === 'normalization' ? 'REVIEW_RESULT_INVALID' : null;
}

function safeTransmissionState(value, transmitting) {
  if (TRANSMISSION_STATES.has(value)) return value;
  return transmitting ? 'attempted' : 'not-attempted';
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function safeIdentifierList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isSafeIdentifier).slice(0, 32);
}
