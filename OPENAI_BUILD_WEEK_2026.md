# Linmas Proof Review — OpenAI Build Week 2026

This is the public implementation and reproducibility record for Linmas's entry in OpenAI Build Week 2026 on Devpost. It contains only evidence that can be checked from the repository or that was observed in a bounded live test. It is not an OpenAI endorsement.

**Version status:** this record targets Linmas **v0.7.0** (immutable tag `v0.7.0`, release commit `8ad6fbd`). Documentation and repository-metadata changes after that tag do not change the runtime or package version.

## Product claim

Linmas turns one explicitly named change into a review result, a deterministic policy decision, and a portable Review Capsule. The capsule binds the exact input bytes to the normalized review through SHA-256, records the execution mode, and preserves the non-negotiable safety statement: **Human review remains required.**

The current Build Week extension adds a Proof Chain above that capsule. A judge can run `npm run demo:proof` to see an offline human decision receipt, static reports, source hashes, and bundle verification. A completed Codex Security sealed scan can also be imported after Linmas verifies its manifest, findings, coverage, and listed artifact hashes.

The v0.7.0 release adds an additive native MCP human-review gate, `linmas_review_decide`, plus the bounded MCP surface described below. The release contains eleven namespaced skills and exactly seven native MCP tools. Existing review results remain advisory and continue to carry `humanReviewRequired=true`; the gate never grants automatic approval.

The judge path works without credentials or a network call:

```bash
npm ci
npm run demo:judge
npm run demo:proof
```

The default demo is an **OFFLINE FIXTURE REPLAY — NO MODEL CALL**. A live Codex run is separate, explicit, and confirmation-gated.

## Verifiable implementation history

Build Week implementation baseline: `0476c7843d0f5adc8ccff3f6729def306aeb896e` (2026-07-18).

| Commit | Date | Verifiable contribution |
|---|---|---|
| `3c543f3` | 2026-07-18 | Namespaced all public skills with the `linmas-` brand while retaining compatibility aliases. |
| `758bda6` | 2026-07-18 | Added bounded Codex account-capability and model discovery. |
| `9e086af` | 2026-07-18 | Added subscription-first Codex review execution and strict provider-output validation. |
| `5105007` | 2026-07-18 | Added versioned, atomic, exact-input Review Capsules. |
| `d903f23` | 2026-07-18 | Added the deterministic 60-second Build Week judge demo. |
| `a9a846c` | 2026-07-18 | Added offline before/after capsule comparison. |

The range above names the focused feature commits, not every repository commit made on that date.

Release and public-surface checkpoints:

| Commit | Date | Verifiable contribution |
|---|---|---|
| `161aaab` | 2026-07-21 | Added the additive `linmas_review_decide` interactive human-review gate with structured chat fallback. |
| `0b6f0ea` | 2026-07-21 | Prepared the v0.7.0 release surface and version-bound artifacts. |
| `8ad6fbd` | 2026-07-21 | Promoted v0.7.0 to `main` and created the immutable `v0.7.0` release tag. |

The current repository may contain later documentation-only and contribution-metadata commits; those do not change the v0.7.0 runtime claim.

## Verified live evidence

One authorized synthetic review was run on 2026-07-18 against `evaluations/cases/secure-code/sql-injection-001/input.txt`.

- Codex CLI: `0.144.5`
- Codex-reported authentication class: `chatgpt` (ChatGPT subscription)
- Requested and verified model: `gpt-5.6-sol`
- Skill: `linmas-secure-code-reviewer`
- Policy: `baseline-appsec`
- Result: schema-valid confirmed high-severity SQL injection finding; policy `blocked`; human review required

This proves that the tested local Codex account could run that model at that time. It does not promise model availability for every account, platform, or future Codex release. No email address, credential, raw provider response, session identifier, or request identifier is published. Private product-feedback evidence is retained by the maintainer but is not published here.

## Architecture and trust boundaries

```text
explicit input file/stdin
        |
        v
bounded request + exact-byte SHA-256
        |
        +---- offline fixture replay (judge default)
        |
        `---- opt-in Codex CLI execution (live only)
                         |
                         v
              strict normalized ReviewResult
                         |
             +-----------+-----------+
             v                       v
 human-review decision      deterministic policy
 MCP form or chat fallback  + Review Capsule
             |               + safety boundary
             +-----------------------+
                         |
                         v
                    Proof Chain
```

Linmas does not log users into Codex and does not store credentials. Codex owns authentication, whether the user has a ChatGPT subscription or a Codex-managed API key. Linmas probes only the capability class and account-visible model catalog needed to validate the requested run.

For live execution, Linmas reads the named input, creates a managed temporary working directory, requests a read-only Codex sandbox, disables approvals, uses an ephemeral session, and ignores user config and repository rules. These controls reduce ambient influence; they do **not** guarantee that Codex cannot read other filesystem paths allowed by the host and Codex sandbox. Linmas therefore does not claim input-only filesystem isolation.

## v0.7.0 release surface

The v0.7.0 package and Codex marketplace plugin require Node.js 24 or newer. The public plugin contains eleven Linmas skills and the following seven bounded MCP tools:

| Tool | Boundary |
|---|---|
| `linmas_review_decide` | Explicit human disposition after findings; never an approval. |
| `linmas_review_prepare` | Offline preparation; no provider call and no writes. |
| `linmas_review_compare` | Offline Review Capsule comparison. |
| `linmas_policy_evaluate` | Offline deterministic policy evaluation. |
| `linmas_proof_verify` | Offline proof-bundle verification. |
| `linmas_proof_create` | Local write only after `confirm_write=true`. |
| `linmas_review_execute` | Provider transmission only after `confirm_transmission=true`. |

When the host supports MCP form elicitation, `linmas_review_decide` presents explicit choices to fix findings, continue with documented risk acknowledgement, stop for manual review, or provide custom guidance. Without elicitation, the same choices are returned as structured chat data and no choice is made automatically. Full Access or `--dangerously-skip-permissions` does not count as a human disposition.

## What Codex contributed and what humans decided

Codex was used as the review engine, implementation collaborator, test runner, and independent reasoning surface. The implementation uses Codex's provider-native authentication and account-visible models instead of requiring Linmas to collect an OpenAI API key.

Human decisions remained authoritative: the product scope, subscription-first transport, explicit live confirmation, model selection, policy thresholds, canonical safety boundary, privacy wording, evidence publication, and every commit were selected or reviewed by the maintainer. Linmas never turns a model response or a passing policy into approval.

## Reproduce the evidence

Use Node.js 24 or newer:

```bash
npm test
npm run coverage
npm run validate
npm run eval:offline
npm run demo:judge
npm run pack:dry-run
```

Inspect a review without transmitting data:

```bash
node bin/linmas.mjs review --skill linmas-secure-code-reviewer --input examples/build-week/insecure-query.diff
```

Run live only when Codex is already usable and transmission is intended:

```bash
npm run demo:judge -- --live --yes --model gpt-5.6-sol
```

### Trusted Windows live-evidence gate

The deterministic suite runs on Windows in CI. A native live Windows claim additionally requires a trusted Windows machine where Codex is already authenticated. After confirming that the synthetic evaluation cases may be transmitted, run in PowerShell with an account-visible model:

```powershell
$env:LINMAS_EVAL_PROVIDER = "codex"
$env:LINMAS_EVAL_MODEL = "<account-visible-model>"
$env:LINMAS_EVAL_MAX_CASES = "20"
$env:LINMAS_EVAL_REPORT = "tmp/windows-live-evaluation.json"
npm run eval:live
```

The generated report excludes raw provider responses and request identifiers. Before publishing evidence, record only the OS and architecture, Node and Codex versions, Codex-reported authentication class, selected model, case count, pass/fail result, and report SHA-256. At the time of this document, no equivalent live Windows run is claimed.

Compare two capsules without a provider call:

```bash
linmas review compare before.json after.json
```

Install or pin the v0.7.0 release for a reproducible Codex marketplace check:

```bash
npm install --global linmas@0.7.0
codex plugin marketplace add TanKimGwan/linmas --ref v0.7.0
codex plugin add linmas@linmas
codex plugin list
```

After upgrading the native MCP plugin, restart Codex desktop/app-server and create a fresh task. An existing task or stale app-server may retain an older plugin child process or cache.

## Limitations and safety

- Offline fixture replay demonstrates the pipeline, not a fresh model inference.
- A Review Capsule is deterministic evidence, not a digital signature, remote attestation, certification, or proof that software is secure.
- A Proof Chain bundle is a portable human-review record, not an approval or certification. Optional SSH signatures provide integrity and optional signer trust; they do not validate the finding itself.
- Policy `pass` means only that declared machine-checkable conditions passed; it is not approval.
- Live review sends the explicitly supplied review content to Codex after confirmation.
- Findings are advisory. Human review remains required.
- Linmas is defensive-only and intended for authorized environments.
- The verified live evidence above was collected on Linux. Cross-platform discovery is tested, but no equivalent live Windows run is claimed.
- Native MCP v0.7.0 is verified on the documented Node.js 24+ Linux path. Windows CI validates deterministic behavior, but no live Windows provider or fresh-task MCP discovery claim is made here.
- To roll back, use a Git revert and pin npm or the Codex marketplace to `0.6.0` / `v0.6.0`; restart the app-server and verify from a fresh task. Do not use destructive reset or npm unpublish.

See the [README](README.md), [security policy](.github/SECURITY.md), and [license](LICENSE) for the full public contract.
