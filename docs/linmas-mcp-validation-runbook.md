# Linmas v0.9.0 MCP Validation Runbook

Status: **UNRELEASED**. This is a validation map, not a test receipt, runtime observation, or release approval.

## Scope and safety

The source contract is in [`mcp/server.mjs`](../mcp/server.mjs); operation-to-evidence mappings are in [`scripts/evidence-operations.mjs`](../scripts/evidence-operations.mjs). The deterministic MCP assertions are in [`tests/mcp-server.test.mjs`](../tests/mcp-server.test.mjs). The test file uses synthetic inputs and a mocked provider for provider execution; it does not establish host loading or live-provider behavior.

For a separately authorized deterministic check, the focused test command is `node --test tests/mcp-server.test.mjs`. CP0 did not run this command. Preserve the tested revision and exact operation-bound test locator with any future evidence. Never promote a fixture result to actual-runtime evidence.

## Seven MCP operations

1. linmas_review_prepare
2. linmas_review_compare
3. linmas_policy_evaluate
4. linmas_proof_verify
5. linmas_proof_create
6. linmas_review_execute
7. linmas_review_decide

## Evidence map

Each row names the source contract and the operation-specific test locator. These are evidence locations to inspect; this draft does not claim that the tests were run.

| Operation | Source contract | Assertion in `tests/mcp-server.test.mjs` | Boundary |
| --- | --- | --- | --- |
| `linmas_review_prepare` | [`mcp/server.mjs`](../mcp/server.mjs); [`evidence-operations.mjs`](../scripts/evidence-operations.mjs) | `offline prepare is read-only and returns prepared plus human-review state` | Offline preparation; no provider call or file write. |
| `linmas_review_compare` | [`mcp/server.mjs`](../mcp/server.mjs); [`evidence-operations.mjs`](../scripts/evidence-operations.mjs) | `offline compare, policy evaluate, and proof verify return verified bounded results` | Local comparison; absence of findings is not remediation proof. |
| `linmas_policy_evaluate` | [`mcp/server.mjs`](../mcp/server.mjs); [`evidence-operations.mjs`](../scripts/evidence-operations.mjs) | `offline compare, policy evaluate, and proof verify return verified bounded results` | Deterministic policy result; not certification or approval. |
| `linmas_proof_verify` | [`mcp/server.mjs`](../mcp/server.mjs); [`evidence-operations.mjs`](../scripts/evidence-operations.mjs) | `offline compare, policy evaluate, and proof verify return verified bounded results` | Integrity/source-binding verification does not prove authorship or correctness. |
| `linmas_proof_create` | [`mcp/server.mjs`](../mcp/server.mjs); [`evidence-operations.mjs`](../scripts/evidence-operations.mjs) | `proof create requires explicit write confirmation and verifies its own result` | Requires explicit local write confirmation and a new destination. |
| `linmas_review_execute` | [`mcp/server.mjs`](../mcp/server.mjs); [`evidence-operations.mjs`](../scripts/evidence-operations.mjs) | `review execute is prepared without consent and only executes a mocked provider after consent` | Transmission requires explicit consent; the cited test uses a mock. |
| `linmas_review_decide` | [`mcp/server.mjs`](../mcp/server.mjs); [`evidence-operations.mjs`](../scripts/evidence-operations.mjs) | `F-006 decision gate rejects tampered review references and uses immutable severity` | Bound review reference; human disposition does not approve security. |

## Evidence record requirements

Keep records revision-bound and operation-specific. Include `evidenceKind`, `expectedResult`, `observedResult`, `evidenceRevision`, `evidenceLocation`, and a limitation. The locator must identify the relevant assertion rather than only the test file. A mocked/deterministic result is not actual host loading or live model evaluation; without an independently addressable runtime observation, retain `UNKNOWN`.

## Related material

- [Compatibility boundaries](compatibility/COMPATIBILITY.md)
- [Implementation notes](implementation/v0.9.0.md)
- [v0.9.0 roadmap outcomes](roadmap/versions/v0.9.0.md)
- [Compatibility evidence assertions](../tests/compatibility-evidence.test.mjs)
