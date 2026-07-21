<div align="center">
  <img src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/linmas.jpg" alt="Linmas logo" width="180">

  <h1>Linmas Proof Review</h1>

  <p><strong>Proof-carrying defensive security reviews for AI-assisted software.</strong></p>

  <p>Turn one explicit change into a normalized finding, deterministic policy decision, and portable Review Capsule—with human review always required.</p>

  <p>
    <a href="https://github.com/TanKimGwan/linmas/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI" src="https://github.com/TanKimGwan/linmas/actions/workflows/ci.yml/badge.svg?branch=main"></a>
    <a href="https://www.npmjs.com/package/linmas"><img alt="npm version 0.6.0" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/npm.svg"></a>
    <a href="https://github.com/TanKimGwan/linmas/releases/tag/v0.6.0"><img alt="release v0.6.0" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/release.svg"></a>
    <a href="LICENSE"><img alt="License: Apache-2.0" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/license.svg"></a>
    <img alt="Node.js 24+" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/node.svg">
    <a href="https://github.com/TanKimGwan/linmas/blob/main/.agents/plugins/marketplace.json"><img alt="Codex primary" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/codex.svg"></a>
    <a href="#ai-agent-compatibility"><img alt="Claude Code compatible" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/claude-code.svg"></a>
    <a href="#ai-agent-compatibility"><img alt="AI agent skills portable" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/agent-skills.svg"></a>
    <a href="OPENAI_BUILD_WEEK_2026.md"><img alt="OpenAI Build Week 2026" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/openai-build-week.svg"></a>
    <img alt="Security: defensive only" src="https://raw.githubusercontent.com/TanKimGwan/linmas/main/assets/badges/security.svg">
  </p>
</div>

## See it in 60 seconds

From a clone of this repository, with Node.js 24 or newer:

```bash
npm install
npm run demo:judge
```

The default judge demo is an **OFFLINE FIXTURE REPLAY — NO MODEL CALL**. It needs no provider credentials and makes no network call. It validates a synthetic SQL-injection change, replays a checked-in normalized result, evaluates the `baseline-appsec` policy, and validates the generated capsule in memory.

What a judge sees:

```text
LINMAS PROOF REVIEW
Execution   OFFLINE FIXTURE REPLAY — NO MODEL CALL
Finding     Confirmed · High · SQL injection
Policy      BLOCKED
Safety      Human review remains required.
Capsule     Validated in memory
```

This is a reproducible demonstration of the review pipeline, not a claim that a model was called during offline replay.

## Documentation

Choose the guide that matches your language and installation goal:

- [Linmas Usage Guide — English](USAGE.md): GitHub source, npm CLI, Codex marketplace, CLI/MCP usage, verification, and troubleshooting.
- [Panduan Penggunaan Linmas — Bahasa Indonesia](PANDUAN-PENGGUNAAN.md): panduan instalasi dan penggunaan dalam bahasa Indonesia.

GitHub's standard repository navigation exposes fixed tabs; these public usage guides are tracked at the repository root and linked here for reliable discovery. The guides are intentionally excluded from the npm package.

## AI agent compatibility

Linmas is **Codex-first for OpenAI Build Week 2026** and designed to remain portable across AI coding agents. The Codex plugin, native MCP tools, offline judge, and verified live-review evidence are the primary event path. Compatibility with other agents depends on the integration level below.

| AI agent or surface | Status | Supported integration |
| --- | --- | --- |
| Codex | **Primary / native** | Git marketplace plugin, eleven skills, six native MCP tools, managed skill directory, and provider-backed review. |
| Claude Code | **Verified compatible** | Managed installation of eleven skills and Claude API provider-backed review. |
| Gemini CLI and other coding agents | **Portable / manual** | The Markdown skill instructions can be imported or adapted where the agent supports equivalent instructions. Linmas does not yet provide a Gemini-specific installer, provider adapter, or MCP registration. |

“Portable / manual” means the defensive instructions can be reused; it does not mean native integration has been verified. New native hosts must have deterministic detection, install/uninstall tests, safety-boundary parity, and a maintenance owner before Linmas labels them verified.

## Why the name “Linmas”?

**Linmas** stands for **Perlindungan Masyarakat**—an Indonesian phrase for community protection. The name reflects the idea that useful protection should be close to the people doing the work, available before a problem becomes an incident, and understandable enough to support better human decisions.

That idea matters for AI-assisted software. Solo developers, indie hackers, vibe coders, maintainers, and engineering teams can ship quickly without always having a dedicated security specialist nearby. Linmas gives them a practical first checkpoint: focused security skills, a bounded review workflow, deterministic policy, and portable evidence that can be inspected rather than blindly trusted.

Linmas is not the “police”, “military”, or final authority of application security. It is intended to be the **first layer of defense closest to everyday builders**—helping people notice risks earlier, ask better questions, and bring stronger evidence to the humans responsible for the final decision.

This open-source project is independently developed. It is not affiliated with any government institution, and its name does not imply government authority, certification, or endorsement. It is also not endorsed by OpenAI.

### Who Linmas is for

- solo developers and indie hackers building with AI coding agents;
- vibe coders who need security guidance without becoming security specialists first;
- engineering teams that want repeatable defensive review and evidence;
- maintainers who want safer review workflows for open-source projects; and
- security practitioners who need bounded specialist instructions for authorized work.

## Run a live Codex review

If Codex is already usable on the machine, run the same synthetic case live:

```bash
npm run demo:judge -- --live --yes
```

Without `--model`, Linmas uses the single default reported by the current Codex account and fails closed if selection is ambiguous. To reproduce the verified Build Week model explicitly:

```bash
npm run demo:judge -- --live --yes --model gpt-5.6-sol
```

The live demo is intentionally opt-in. `--yes` acknowledges that the named input leaves the machine. To preserve an atomic evidence artifact:

```bash
npm run demo:judge -- --live --yes --capsule review-capsule.json
```

Or review your own explicit input:

```bash
npx linmas review \
  --skill linmas-secure-code-reviewer \
  --input patch.diff \
  --provider codex \
  --model gpt-5.6-sol \
  --policy baseline-appsec \
  --capsule review-capsule.json \
  --yes
```

On 2026-07-18, one authorized synthetic run was verified with Codex CLI `0.144.5`, ChatGPT subscription authentication, and the account-visible `gpt-5.6-sol` model. It returned a schema-valid high-severity SQL-injection finding and a blocked policy decision. This is evidence for that tested configuration, not a guarantee that the model is available to every account.

## The Review Capsule

A Review Capsule is a versioned JSON evidence object that connects:

- the SHA-256 digest and byte length of the exact input;
- the selected Linmas skill and policy;
- offline fixture or live execution mode;
- the normalized finding and deterministic policy result;
- a small allowlisted provider metadata set; and
- the canonical safety boundary: **Human review remains required.**

Capsules are written with destination preflight and atomic no-overwrite behavior. They deliberately exclude raw provider responses, credentials, email addresses, session identifiers, and request identifiers.

A capsule is not a digital signature, remote attestation, certification, or proof that software is secure. It is a reviewable evidence envelope for a bounded run.

## The Proof Chain

Turn a validated Review Capsule or a completed Codex Security sealed scan into a portable, human-reviewed evidence bundle:

```bash
linmas proof create review-capsule.json --bundle proof-bundle
linmas proof verify proof-bundle
npm run demo:proof
```

The creation wizard records a disposition and rationale for every finding, derives an overall disposition, and writes `decision-receipt.json`, `report.md`, `report.html`, and hashed source evidence. The bundle is immutable at the destination and can be verified offline without provider credentials or network access.

Codex Security imports require the complete sealed scan directory containing `scan-manifest.json`, `findings.json`, and `coverage.json`. Linmas verifies the manifest references and artifact hashes before importing the three structured files. It does not copy the full scan, execute scan content, or accept a findings-only file as a verified source.

SSH signing is optional. A valid signature proves integrity and key possession; identity becomes trusted only when the verifier supplies a matching `--allowed-signers` file:

```bash
linmas proof create review-capsule.json --bundle signed-proof --signing-key ~/.ssh/id_ed25519
linmas proof verify signed-proof --allowed-signers ~/.ssh/allowed_signers --output json
```

Proof bundles are evidence summaries, not approvals, certifications, or proof that software is secure. Human review remains required.

## Compare before and after

Compare two capsules locally, without a provider or network call:

```bash
linmas review compare before.json after.json
```

The comparison validates both complete capsules, then reports added, resolved, persistent, and changed findings plus the policy transition. It does not claim that an empty delta proves security.

## Deterministic policy, never automatic approval

Apply a built-in declarative policy after normalization:

```bash
linmas review --skill linmas-secure-code-reviewer --input patch.diff --provider codex --policy baseline-appsec
```

Built-in packs are `baseline-appsec`, `cloud-change`, and `release-security`. Local policy files are bounded, schema-validated JSON with no commands, code, expressions, templates, plugins, remote imports, or provider hooks.

Decisions are `pass`, `needs-review`, or `blocked`. A policy `pass` does not prove the change is secure, compliant, certified, or approved. Safety failures fail closed, and **human review is required** for every result.

## Authentication and privacy boundaries

Linmas is subscription-first for Codex. It supports accounts whose Codex installation reports either:

- **ChatGPT subscription** authentication; or
- a **Codex-managed API key** authentication class.

Linmas does not log you in, ask for an OpenAI API key, or store credentials. Codex owns authentication. Linmas uses the Codex app-server capability surface to classify the current auth mode and list account-visible models, then verifies the explicitly selected model before live execution.

Prepare mode reads only the named input file or explicit stdin, never invokes Git, never scans the repository, and makes no network call:

```bash
linmas review --skill linmas-secure-code-reviewer --input patch.diff
```

For compatibility, the legacy alias also resolves:

```bash
linmas review --skill secure-code-reviewer --input patch.diff
```

Native MCP tools accept both the namespaced specialist ID and this legacy alias, then normalize both to the same specialist contract. Invalid MCP requests return schema-versioned errors with safe field/reason metadata. Provider failures use granular codes such as `PROVIDER_CONFIGURATION_MISSING`, `PROVIDER_RATE_LIMITED`, and `PROVIDER_TRANSPORT_FAILED`; credentials, review input, raw stderr, and provider responses are never returned.

Live execution is separately enabled and visibly confirms that data leaves the machine. Linmas constructs the request from the named input and runs Codex in a managed temporary working directory with a read-only sandbox request, approvals disabled, an ephemeral session, and user config and repository rules ignored.

Those controls reduce ambient influence, but this does not guarantee that Codex cannot read other filesystem paths permitted by the host and Codex sandbox.

Linmas makes no claim of filesystem isolation to the named input. Use live review only with content you are authorized to transmit.

## Linmas-branded security skills

Every public skill is namespaced for discoverability and attribution:

| Skill | Focus |
|---|---|
| `linmas-secure-code-reviewer` | Application security findings, threat modeling, and remediation. |
| `linmas-smart-contract-reviewer` | Authorized smart-contract and protocol risk review. |
| `linmas-cloud-hardening-architect` | IAM, segmentation, workload, and platform hardening. |
| `linmas-controls-compliance-reviewer` | Control mapping, evidence, and audit-readiness gaps. |
| `linmas-incident-triage-lead` | Classification, containment planning, and evidence preservation. |
| `linmas-exploit-validation-specialist` | Bounded proof-of-impact in authorized environments. |
| `linmas-secure-systems-architect` | Trust zones, identity, and secure system design. |
| `linmas-security-domain-router` | Route a request to the appropriate Linmas specialist. |
| `linmas-security-operations-lead` | Monitoring, escalation, and operational hardening. |
| `linmas-detection-rules-engineer` | SIEM logic, telemetry mapping, tuning, and false-positive reduction. |
| `linmas-threat-research-analyst` | IOC analysis and intelligence-to-detection translation. |

Legacy unprefixed names remain aliases for migration, but new documentation and installations use canonical `linmas-*` identities.

### Installation hosts and execution providers

Installation hosts and execution providers are independent:

| Capability | Supported surface |
|---|---|
| Installation hosts | Claude Code and Codex managed skill directories |
| Execution providers | Claude and Codex provider-native configuration |

Credentials are never stored in an installation manifest. Live execution is opt-in. Gemini and other agents are not registered installation hosts or execution providers in version 0.6.0. Additional installation hosts remain demand-driven and require testable install/uninstall behavior, safety-boundary parity, and a maintenance owner.

```bash
npx linmas list
npx linmas detect
npx linmas onboard
npx linmas install linmas-secure-code-reviewer --dry-run
npx linmas install linmas-secure-code-reviewer
npx linmas doctor
npx linmas uninstall linmas-secure-code-reviewer
```

## Security advisor skills

The skill files remain useful directly inside compatible coding agents. Each specialist defines an **advisor review mode**, a **design review mode**, and a stable finding vocabulary:

- **Confirmed finding** — supported by concrete evidence;
- **Needs validation** — plausible but missing proof;
- **Recommendation** — preventive improvement rather than a demonstrated defect.

`linmas-security-domain-router` selects a specialist while preserving scope and authorization. Optional repository policy can shape agent behavior, but it does not automatically filter every agent response. Human review is required.

## Secure code advisor review

`linmas-secure-code-reviewer` emphasizes affected surface, preconditions, impact, remediation, and verification. Its deterministic checks are recommendations that run only when invoked. Optional repository policy can strengthen local review conventions but does not automatically filter every agent response or replace human review.

## What changed for Build Week

| Before the Build Week implementation | Linmas Proof Review |
|---|---|
| A collection of defensive skill instructions | A bounded review workflow plus branded installable skills |
| Provider output without portable evidence | Strict normalized result and exact-input Review Capsule |
| Provider-specific credential assumptions | Codex-native ChatGPT subscription or Codex-managed API key discovery |
| Individual review result | Deterministic policy and offline before/after comparison |
| Manual product walkthrough | 60-second offline judge demo plus explicit live path |

Codex contributed as the provider-native review engine, implementation collaborator, and verification surface. Humans chose the scope, authorization boundaries, model, policy thresholds, safety contract, privacy language, publication scope, and final commits. See the [public Build Week evidence](OPENAI_BUILD_WEEK_2026.md) for the verifiable history and reproduction commands.

## Platform and runtime

- Node.js `>=24` is required.
- The offline workflow is provider-independent and deterministic.
- The verified live evidence was collected on Linux.
- Codex executable discovery covers native POSIX and Windows layouts; unsafe Windows `.cmd` and `.bat` shims are rejected.
- The native MCP stdio path is verified on Linux with Node.js 24+. Native Windows MCP and a successful live Windows provider run are not currently claimed.

## Native MCP plugin

Install the public Git marketplace and the Linmas plugin:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref main
codex plugin add linmas@linmas
codex plugin list
```

### Important: marketplace visibility is per device

This is a public **GitHub repository marketplace**, not yet an entry in the global Codex/ChatGPT Plugins Directory. Therefore, Linmas will not automatically appear in search on another computer just because you are signed in to the same ChatGPT account. Add the marketplace once on each computer:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref v0.6.0
codex plugin add linmas@linmas
codex plugin list
```

After installation, restart Codex completely and create a new task. If `linmas@linmas` is still not listed, verify that the computer has Git, Node.js 24+, and network access to GitHub. The official Plugins Directory is a separate publication channel that requires OpenAI submission, review, and approval; GitHub and npm publication do not automatically add Linmas to that global catalog.

To pin an immutable release instead of following `main`, replace `--ref main` with `--ref v0.6.0`. After installation or upgrade, restart the Codex desktop/app-server and start a fresh task. A stale app-server can retain an MCP child process from an older or deleted plugin cache.

To upgrade an existing marketplace installation:

```bash
codex plugin marketplace upgrade linmas
codex plugin add linmas@linmas
```

The public marketplace tracks a ready-to-install plugin at `plugins/linmas`. Maintainers regenerate it from canonical sources and verify every file byte-for-byte:

```bash
npm run sync:codex-marketplace
python3 /home/tan/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/linmas
```

Npm users can also build an independent local plugin directory:

```bash
npm run build:codex-plugin -- --target /absolute/path/to/plugins/linmas
python3 /home/tan/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py /absolute/path/to/plugins/linmas
```

The builder copies exactly eleven canonical Linmas skills, the bounded MCP server, policy/runtime files, `.mcp.json`, and the package metadata required to report the canonical version. It does not mutate a user's marketplace configuration. Development cachebusters are host-artifact metadata and are not part of the canonical source or package version.

The MCP server exposes exactly six tools:

| Tool | Boundary |
|---|---|
| `linmas_review_prepare` | Offline preparation; no provider and no writes. |
| `linmas_review_compare` | Offline capsule comparison. |
| `linmas_policy_evaluate` | Offline deterministic policy evaluation. |
| `linmas_proof_verify` | Offline proof-bundle verification. |
| `linmas_proof_create` | Local write only after `confirm_write=true`. |
| `linmas_review_execute` | Provider transmission only after `confirm_transmission=true`. |

Tool results expose bounded status values such as `prepared`, `verified`, and `executed`, plus `humanReviewRequired=true`; every result remains `needs_human_review`. A prepared result does not call a provider or write output. Offline tools do not transmit data. A provider-backed review transmits only after explicit consent, and a proof bundle is written only after explicit write confirmation. Timeouts cancel provider work and prevent late normalization, policy evaluation, capsule creation, or final output writes.

## Command reference

| Command | Purpose |
|---|---|
| `linmas list` | List canonical Linmas skills. |
| `linmas detect` | Detect supported installation hosts. |
| `linmas onboard` | Inspect host and Codex account capabilities. |
| `linmas doctor` | Diagnose managed installations and duplicates. |
| `linmas install <skill>` | Install one canonical skill; add `--dry-run` to preflight. |
| `linmas uninstall <skill>` | Remove a Linmas-managed skill. |
| `linmas review ...` | Prepare locally or execute an explicit provider review. |
| `linmas review compare before.json after.json` | Compare two capsules offline. |
| `linmas proof create <source> --bundle <dir>` | Record human decisions and create a portable proof bundle. |
| `linmas proof verify <dir>` | Verify bundle hashes and optional SSH signature offline. |
| `npm run demo:judge` | Run the deterministic judge demo. |
| `npm run demo:proof` | Create and verify an ephemeral offline Proof Chain bundle. |
| `npm run validate` | Validate package structure, skills, examples, and secrets. |
| `npm run eval:offline` | Run checked-in evaluation cases without model calls. |
| `npm run coverage` | Run tests with enforced source coverage thresholds. |

## Limitations and safety

- Linmas is defensive-only and intended for authorized environments.
- Model findings can be wrong or incomplete; human review remains required.
- Linmas never approves, merges, releases, or automatically fixes a change.
- A policy `pass` or an empty comparison does not prove security.
- Offline replay is not a fresh model inference.
- A valid Proof Chain bundle records human disposition; it does not approve or certify a change.
- Codex Security adapter input must be a completed sealed scan directory; findings-only JSON is not treated as verified evidence.
- Live review transmits the explicit input to the selected provider after confirmation.
- No claim is made that a read-only sandbox limits provider reads to the Linmas input.
- Native MCP support is bounded to the documented Node.js 24+ Linux-verified path; Codex fresh-task discovery requires a separately verified host reinstall and is not implied by direct stdio validation.

## Contributing, security, and license

Contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities according to the [security policy](.github/SECURITY.md). Community conduct is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Linmas is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [TRADEMARK.md](TRADEMARK.md) for attribution and name-use guidance. Linmas is inspired by Indonesia's community-protection concept, *Perlindungan Masyarakat*, and is not affiliated with a government institution or endorsed by OpenAI.
