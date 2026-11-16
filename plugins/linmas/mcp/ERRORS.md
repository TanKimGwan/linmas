# Native MCP public errors

Tool failures return `result.isError: true` and `structuredContent: { status: 'needs_human_review', error: ... }` with `error.schemaVersion: 1`. Codes are additive: callers must tolerate an unknown code and use the safe message, stage, retryability, and transmission flags. Messages never echo request values, paths, provider output, or internal error text.

| Internal tool code / ReviewError category | Public code | Generic message | Default stage |
| --- | --- | --- | --- |
| `unknown_tool` | `TOOL_UNSUPPORTED` | The requested Linmas tool is not supported. | `argument-validation` |
| `invalid_input`, `input` | `INPUT_FIELD_INVALID` | A request field is invalid. | `argument-validation` |
| `decision_input_required` | `DECISION_INPUT_REQUIRED` | A required review decision input is missing. | `argument-validation` |
| `risk_acknowledgement_required` | `RISK_ACKNOWLEDGEMENT_REQUIRED` | Explicit risk acknowledgement is required to continue. | `argument-validation` |
| `invalid_path` | `INVALID_PATH` | The requested path is invalid or outside the workspace. | `argument-validation` |
| `input_too_large` | `INPUT_TOO_LARGE` | The request exceeds the bounded input limit. | `argument-validation` |
| `output_too_large` | `OUTPUT_TOO_LARGE` | The tool output exceeds the bounded output limit. | `mcp-execution` |
| `write_target_exists` | `WRITE_TARGET_EXISTS` | The requested write target already exists. | `argument-validation` |
| `contract_violation`, `contract`, `proof` | `CONTRACT_VIOLATION` | The supplied artifact violates the Linmas contract. | `argument-validation` |
| `write` | `ARTIFACT_WRITE_FAILED` | The local artifact could not be written. | `mcp-execution` |
| `signature` | `SIGNATURE_VERIFICATION_FAILED` | The artifact signature could not be verified. | `mcp-execution` |
| `input_field_unsupported` | `INPUT_FIELD_UNSUPPORTED` | The request contains an unsupported field. | `argument-validation` |
| `input_field_required` | `INPUT_FIELD_REQUIRED` | A required request field is missing. | `argument-validation` |
| `input_field_invalid` | `INPUT_FIELD_INVALID` | A request field is invalid. | `argument-validation` |
| `input_source_invalid` | `INPUT_SOURCE_INVALID` | Provide exactly one valid review input source. | `argument-validation` |
| `specialist_unsupported` | `SPECIALIST_UNSUPPORTED` | The requested specialist is not supported. | `argument-validation` |
| `provider_unsupported` | `PROVIDER_UNSUPPORTED` | The requested provider is not supported. | `argument-validation` |
| `policy_unsupported` | `POLICY_UNSUPPORTED` | The requested policy is not supported. | `argument-validation` |
| `policy_result_incompatible` | `POLICY_RESULT_INCOMPATIBLE` | The provider response is incompatible with the requested policy. | `normalization` |
| `provider-configuration` | `PROVIDER_CONFIGURATION_MISSING` | Provider configuration is incomplete. | `provider-execution` |
| `provider-authentication` | `PROVIDER_AUTHENTICATION_FAILED` | Provider authentication failed. | `provider-execution` |
| `provider-rate-limit` | `PROVIDER_RATE_LIMITED` | The provider rate-limited the request. | `provider-execution` |
| `provider-timeout` | `PROVIDER_TIMEOUT` | The provider request timed out. | `provider-execution` |
| `provider-transport` | `PROVIDER_TRANSPORT_FAILED` | The provider transport failed. | `provider-execution` |
| `provider-upstream` | `PROVIDER_UPSTREAM_FAILED` | The provider returned an upstream failure. | `provider-execution` |
| `provider-rejected` | `PROVIDER_REQUEST_REJECTED` | The provider rejected the request. | `provider-execution` |
| `provider-cancelled` | `PROVIDER_EXECUTION_CANCELLED` | Provider execution was cancelled. | `provider-execution` |
| `provider-response-invalid` | `PROVIDER_RESPONSE_INVALID` | The provider response was invalid. | `normalization` |
| `normalization` | `REVIEW_RESULT_CONTRACT_VIOLATION` | The provider response violated the ReviewResult contract. | `normalization` |
| `timeout` | `MCP_TIMEOUT` | The Linmas tool operation timed out. | `mcp-execution` |
| unclassified | `INTERNAL_ERROR` | The Linmas tool failed unexpectedly. | `mcp-execution` |

Explicit allowlisted stage metadata overrides the default, except `INTERNAL_ERROR` and `OUTPUT_TOO_LARGE` always use `mcp-execution`. Existing stages are `argument-validation`, `workspace-validation`, `provider-preflight`, `provider-configuration`, `binary-discovery`, `capability-startup`, `authentication`, `model-discovery`, `model-selection`, `provider-execution`, `response-read`, `normalization`, `capsule-write`, and `mcp-execution`.

Capsule build, validation, and write failures after provider response use `CONTRACT_VIOLATION`, stage `capsule-write`, reason `CAPSULE_CONTRACT_VIOLATION`, and message “The review capsule could not be built, validated, or written.” Abort and timeout errors retain their own classification.

A policy rejected before transmission retains `POLICY_UNSUPPORTED` with `POLICY_SPECIALIST_UNSUPPORTED` or `POLICY_MODE_UNSUPPORTED`. A provider response with a specialist the policy rejects uses the separate `POLICY_RESULT_INCOMPATIBLE` code, stage `normalization`, and `POLICY_RESPONSE_SPECIALIST_UNSUPPORTED`; it omits request `field` and `allowedValues` because the submitted specialist was valid. The original policy code keeps its request-validation meaning, and the existing mode guard remains unchanged.

User-supplied capsules, policy packs, proof bundles, and decision receipts are validated at their tool boundary. Invalid artifact schemas use `CONTRACT_VIOLATION` with its existing `argument-validation` default; invalid receipt fields, duplicate finding IDs, approval language, review references, and decision form content use the existing input or decision codes. `INTERNAL_ERROR` is reserved for unclassified failures outside these validation operations.

Transmission state is independent of the code: `not-attempted`, `attempted`, `response-received`, `normalized`, or `capsule-written`. The dispatcher preserves the latest known state for execute failures, including oversized output. Outer execute timeouts have a conservative `attempted` floor and retain a higher known state; an unannotated execute error otherwise defaults to `not-attempted`. Offline-tool failures report `not-attempted`.
