# Linmas Proof Review — OpenAI Build Week 2026

This is the public implementation and reproducibility record for Linmas's entry in OpenAI Build Week 2026 on Devpost. It contains only evidence that can be checked from the repository or that was observed in a bounded live test. It is not an OpenAI endorsement.

## Product claim

Linmas turns one explicitly named change into a review result, a deterministic policy decision, and a portable Review Capsule. The capsule binds the exact input bytes to the normalized review through SHA-256, records the execution mode, and preserves the non-negotiable safety statement: **Human review remains required.**

The judge path works without credentials or a network call:

```bash
npm install
npm run demo:judge
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
 deterministic policy          Review Capsule
 pass / needs-review / blocked  + safety boundary
```

Linmas does not log users into Codex and does not store credentials. Codex owns authentication, whether the user has a ChatGPT subscription or a Codex-managed API key. Linmas probes only the capability class and account-visible model catalog needed to validate the requested run.

For live execution, Linmas reads the named input, creates a managed temporary working directory, requests a read-only Codex sandbox, disables approvals, uses an ephemeral session, and ignores user config and repository rules. These controls reduce ambient influence; they do **not** guarantee that Codex cannot read other filesystem paths allowed by the host and Codex sandbox. Linmas therefore does not claim input-only filesystem isolation.

## What Codex contributed and what humans decided

Codex was used as the review engine, implementation collaborator, test runner, and independent reasoning surface. The implementation uses Codex's provider-native authentication and account-visible models instead of requiring Linmas to collect an OpenAI API key.

Human decisions remained authoritative: the product scope, subscription-first transport, explicit live confirmation, model selection, policy thresholds, canonical safety boundary, privacy wording, evidence publication, and every commit were selected or reviewed by the maintainer. Linmas never turns a model response or a passing policy into approval.

## Reproduce the evidence

Use Node.js 24 or newer:

```bash
npm test
npm run validate
npm run eval:offline
npm run demo:judge
npm pack --dry-run --cache /tmp/linmas-npm-cache
```

Inspect a review without transmitting data:

```bash
node bin/linmas.mjs review --skill linmas-secure-code-reviewer --input examples/build-week/insecure-query.diff
```

Run live only when Codex is already usable and transmission is intended:

```bash
npm run demo:judge -- --live --yes
```

Compare two capsules without a provider call:

```bash
linmas review compare before.json after.json
```

## Limitations and safety

- Offline fixture replay demonstrates the pipeline, not a fresh model inference.
- A Review Capsule is deterministic evidence, not a digital signature, remote attestation, certification, or proof that software is secure.
- Policy `pass` means only that declared machine-checkable conditions passed; it is not approval.
- Live review sends the explicitly supplied review content to Codex after confirmation.
- Findings are advisory. Human review remains required.
- Linmas is defensive-only and intended for authorized environments.
- The verified live evidence above was collected on Linux. Cross-platform discovery is tested, but no equivalent live Windows run is claimed.

See the [README](README.md), [security policy](.github/SECURITY.md), and [license](LICENSE) for the full public contract.
