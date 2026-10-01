# Linmas v0.9.0 Compatibility

Status: **UNRELEASED**. This page records source-level boundaries; it does not certify a host, runtime, or release.

## Runtime matrix

| Surface | Status | Boundary |
| --- | --- | --- |
| Node.js | Declared minimum: `>=24`; observed compatibility: `UNKNOWN` | The package engine declaration is not a runtime observation. |
| MCP server | Protocol version `2025-11-25` and seven tool definitions are declared in source; host interoperability: `UNKNOWN` | Source discovery does not prove a host can load or invoke the server. |
| Codex host loading | `UNKNOWN` | No host-load result is asserted here. |
| Claude Code host loading | `UNKNOWN` | No host-load result is asserted here. |
| Hermes format loading | `UNKNOWN` | Format-level expectations do not prove actual runtime loading. |
| Live provider/model evaluation | `UNKNOWN` / OUT OF SCOPE | Deterministic fixtures are not live evaluations. |
| Destructive uninstall on Windows | `UNSUPPORTED` | Secure destructive filesystem operations fail closed with `SAFE_FILESYSTEM_OPERATION_UNAVAILABLE`. |

## Evidence contract

Compatibility claims must be machine-readable and revision-bound. A record should identify its runtime product and version, OS version, adapter version, operation, capability profile, evidence revision, collection date, evidence kind, expected and observed results, evidence location, and limitation. Missing runtime observations remain `UNKNOWN`; a fixture result must not be relabeled as host or live-runtime evidence.

The compatibility evidence tests check completeness, exact inventories, revision binding, operation-specific test references, and rejection of fixture promotion. Those assertions describe the evidence contract, not a new result from this draft.

## Scope boundary

Windows destructive uninstall remains unsupported until the safe filesystem primitive exists. This is a deliberate denial, not a compatibility pass. No release, host support, or live-provider claim is made here.

## Related material

- [Implementation notes](../implementation/v0.9.0.md)
- [MCP validation runbook](../linmas-mcp-validation-runbook.md)
- [v0.9.0 roadmap outcomes](../roadmap/versions/v0.9.0.md)
- [Package engine declaration](../../package.json)
- [MCP server source](../../mcp/server.mjs)
- [Compatibility evidence assertions](../../tests/compatibility-evidence.test.mjs)
- [Windows uninstall boundary](../../src/core/uninstall-skills.mjs)
