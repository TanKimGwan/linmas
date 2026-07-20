# Linmas Usage Guide

Linmas is a Codex-first defensive security review toolkit for AI-assisted software. It provides a CLI, eleven namespaced security skills, deterministic policy checks, portable proof evidence, and a native MCP server for Codex. The skills can also be used by other AI coding agents at the compatibility levels documented below. Human review remains required for every result.

## Requirements

- Node.js 24 or newer for the CLI, source checkout, and local MCP runtime.
- Git for the source installation and Codex marketplace installation.
- Codex CLI or Codex desktop/app-server for the Codex plugin path.
- Claude Code only when using the verified Claude managed-skill path.

Linmas does not require an OpenAI API key for subscription-first Codex use. Codex owns provider authentication. Live review is opt-in and requires explicit confirmation before input leaves the machine.

## Choose an installation path

| Path | Best for | What it installs |
| --- | --- | --- |
| GitHub source | Contributors, reproducible local development, and the offline demo | The repository and its development scripts |
| npm | Running the Linmas CLI without cloning the repository | The published `linmas` package and CLI |
| Codex marketplace | Using Linmas skills and MCP tools inside Codex | The ready-to-install `linmas@linmas` plugin |
| Claude Code managed skills | Using the eleven Linmas skills inside Claude Code | Skills installed through the Linmas CLI |

The npm package and Codex marketplace are separate distribution paths. Installing the npm package does not register a Codex marketplace, and installing the Codex plugin does not add the package to another Node.js project.

## AI agent compatibility

Codex is the primary native integration and the reference path for OpenAI Build Week 2026. Linmas remains compatible with other agents through verified managed installation or portable Markdown instructions:

| AI agent or surface | Compatibility level | Available Linmas surface |
| --- | --- | --- |
| Codex | **Primary / native** | Git marketplace plugin, eleven skills, six native MCP tools, managed skill directory, and Codex provider-backed review. |
| Claude Code | **Verified compatible** | Managed installation of eleven skills and Claude API provider-backed review. Native Linmas MCP plugin registration is not claimed for Claude Code. |
| Gemini CLI and other coding agents | **Portable / manual** | Import or adapt the relevant `skills/linmas-*/SKILL.md` instructions if the agent supports equivalent project or user instructions. There is no Gemini-specific installer, provider adapter, MCP registration, or verified parity claim yet. |

Portable compatibility covers the defensive instruction content, not automatic installation or identical runtime behavior. Human review, authorization, and the Linmas safety boundary still apply in every host.

## Install from GitHub

Clone the public repository and run the deterministic offline demo:

```bash
git clone https://github.com/TanKimGwan/linmas.git
cd linmas
npm ci
npm run demo:judge
```

The demo is an offline fixture replay. It makes no model call and needs no provider credentials.

To make the CLI available as `linmas` on the local machine:

```bash
npm link
linmas list
```

To avoid a global link, run the entry point directly:

```bash
node bin/linmas.mjs list
node bin/linmas.mjs review --skill linmas-secure-code-reviewer --input patch.diff
```

## Install from npm

For a global CLI installation:

```bash
npm install --global linmas@0.5.3
linmas list
```

For a one-time invocation without a global install:

```bash
npx --yes linmas@0.5.3 list
npx --yes linmas@0.5.3 review --skill linmas-secure-code-reviewer --input patch.diff
```

For a project-local dependency:

```bash
npm install --save-dev linmas@0.5.3
npx linmas list
```

The npm package includes the canonical runtime, skills, policies, examples, and MCP source. It intentionally does not register a marketplace entry in your Codex configuration. Use the Codex marketplace installation below for that.

## Install as a Codex plugin

Add the public Git marketplace once, then install the plugin:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref main
codex plugin add linmas@linmas
codex plugin list
```

### Important: marketplace visibility is per device

This is a public **GitHub repository marketplace**, not an entry in the global Codex/ChatGPT Plugins Directory. The marketplace configuration is local to each computer, so installing Linmas on one computer does not make it appear automatically on another computer or in global search.

On every computer where you want to use Linmas, run:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref v0.5.3
codex plugin add linmas@linmas
codex plugin list
```

Then restart Codex completely and create a fresh task. If the plugin is still missing, verify Git, Node.js 24+, and GitHub network access on that computer. Publication to the official Plugins Directory is a separate OpenAI submission, review, and approval process; publishing to GitHub and npm does not automatically publish Linmas there.

For a reproducible immutable release, pin the repository ref:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref v0.5.3
codex plugin add linmas@linmas
```

After installation or upgrade, restart the Codex desktop/app-server and start a fresh task. A stale app-server can retain an MCP child process from an older plugin cache.

The plugin exposes eleven skills:

- `linmas-security-domain-router`
- `linmas-secure-code-reviewer`
- `linmas-cloud-hardening-architect`
- `linmas-controls-compliance-reviewer`
- `linmas-detection-rules-engineer`
- `linmas-exploit-validation-specialist`
- `linmas-incident-triage-lead`
- `linmas-secure-systems-architect`
- `linmas-security-operations-lead`
- `linmas-smart-contract-reviewer`
- `linmas-threat-research-analyst`

The native MCP server exposes exactly six tools:

| Tool | Behavior |
| --- | --- |
| `linmas_review_prepare` | Offline preparation; no provider call and no write. |
| `linmas_review_compare` | Offline comparison of two validated capsules. |
| `linmas_policy_evaluate` | Deterministic local policy evaluation. |
| `linmas_proof_verify` | Offline proof-bundle verification. |
| `linmas_proof_create` | Local write only with `confirm_write=true`. |
| `linmas_review_execute` | Provider transmission only with `confirm_transmission=true`. |

To upgrade an existing marketplace installation:

```bash
codex plugin marketplace upgrade linmas
codex plugin add linmas@linmas
```

To remove it:

```bash
codex plugin remove linmas@linmas
codex plugin marketplace remove linmas
```

This is a Codex plugin marketplace installation. It does not make Linmas appear in the ChatGPT `@` plugin catalog. ChatGPT plugins/apps are a separate surface and would require a separately hosted ChatGPT App or remote MCP integration.

## Install skills in Claude Code

Install all eleven managed skills from the published package:

```bash
npx --yes linmas@0.5.3 detect
npx --yes linmas@0.5.3 install --all
```

Choose `Claude` when the interactive host prompt appears. Linmas writes managed skills under `~/.claude/skills` and records ownership in `~/.claude/linmas-manifest.json`. To install only one specialist:

```bash
npx --yes linmas@0.5.3 install linmas-secure-code-reviewer
```

Verify the managed installation:

```bash
npx --yes linmas@0.5.3 doctor
```

Live Claude provider execution is a separate opt-in surface. It requires `ANTHROPIC_API_KEY`, an explicit model through `LINMAS_EVAL_MODEL` or the CLI, and confirmation before the named input leaves the machine. Installing skills does not transmit review data.

## Use Linmas with Gemini or another AI coding agent

Linmas does not currently mutate Gemini or other unregistered agent configuration. If an agent supports persistent Markdown instructions or an Agent Skills-style directory, you can manually import or adapt the relevant canonical file from `skills/linmas-*/SKILL.md`.

Treat this as portable instruction compatibility, not a verified native integration. The agent must preserve Linmas authorization, evidence, consent, and human-review requirements. Native provider execution and the six Codex MCP tools are not implied by copying a skill file.

## Use Linmas from the CLI

Prepare a local review without sending data to a provider:

```bash
linmas review \
  --skill linmas-secure-code-reviewer \
  --input patch.diff
```

Run the deterministic judge demo:

```bash
npm run demo:judge
```

Compare two local review capsules:

```bash
linmas review compare before.json after.json
```

Create and verify a human-reviewed proof bundle:

```bash
linmas proof create review-capsule.json --bundle proof-bundle
linmas proof verify proof-bundle
```

Provider-backed review is deliberately separate. It requires a configured provider, an explicitly selected model when needed, and `--yes` acknowledgement that the named input leaves the machine:

```bash
linmas review \
  --skill linmas-secure-code-reviewer \
  --input patch.diff \
  --provider codex \
  --model gpt-5.6-sol \
  --policy baseline-appsec \
  --capsule review-capsule.json \
  --yes
```

Do not use live review with secrets or data you are not authorized to transmit.

## Use Linmas in Codex

After installing the plugin and starting a fresh task, ask Codex for a bounded defensive review. For example:

```text
Use Linmas secure code review to analyze this patch for SQL injection.
Review only the supplied patch, identify evidence and preconditions, and keep the result advisory.
Do not run a provider or transmit data unless I explicitly confirm it.
```

For an architecture question:

```text
Use the Linmas security domain router, then the best specialist, to review this cloud trust boundary.
State assumptions, missing context, and deterministic checks. Human review remains required.
```

The MCP tools keep offline work local. Writes and provider transmission have separate explicit consent gates. Tool output never claims approval, certification, remediation, or proof that software is secure.

## Choose and use each skill

In Codex, call a skill by its full namespaced name, for example `linmas:linmas-secure-code-reviewer`. In Claude Code managed skills, the same skill normally appears without the plugin namespace as `linmas-secure-code-reviewer`. For Gemini or another agent, invocation depends on how that agent loads the manually imported Markdown instructions; native parity is not claimed.

Every beginner prompt should provide four things:

1. the exact skill name;
2. the authorized scope and the material to review;
3. the question or decision you need help with; and
4. the expected output and safety boundary.

Do not paste credentials, tokens, private keys, or data you are not authorized to share. The examples below are advisory and read-only. Replace the bracketed placeholders with your own authorized, sanitized material.

### 1. Security Domain Router

Use `linmas-security-domain-router` when you are unsure which specialist should lead or when a request touches several security domains.

**Example case:** You are adding file upload, object storage, and malware scanning to an API, but you do not know whether to start with code, cloud, or architecture review.

```text
Use `linmas:linmas-security-domain-router`.

Authorized scope: the attached design summary for our new file-upload feature.
Decide which Linmas specialist should review it first. Explain why, name one alternate skill if the scope changes, and list the missing inputs I should provide next.
Do not modify files, execute tests, or call a live provider.
```

**Expected result:** one best-fit skill, a reason, one relevant alternate, and the next context to collect.

### 2. Secure Code Reviewer

Use `linmas-secure-code-reviewer` for application code, APIs, authentication, authorization, input handling, dependencies, and secure remediation guidance.

**Example case:** An Express route builds a SQL query from a request parameter and you want a review before merge.

```text
Use `linmas:linmas-secure-code-reviewer`.

Authorized scope: the attached `user-route.diff` only.
Review the data flow from the HTTP parameter to the database query, including injection, authorization, error handling, and data minimization risks.
Return Scope and assumptions, Findings with evidence and severity, Recommended deterministic checks, and Safety boundary. Separate Confirmed finding, Needs validation, and Recommendation. Do not exploit the endpoint or modify the patch.
```

**Expected result:** evidence-linked findings, practical remediation, and tests that can verify the fix.

### 3. Cloud Hardening Architect

Use `linmas-cloud-hardening-architect` for AWS, Azure, or GCP IAM, account boundaries, networking, workload identity, logging, encryption, and cloud guardrails.

**Example case:** A team plans to run an API on AWS ECS behind an ALB with RDS and S3.

```text
Use `linmas:linmas-cloud-hardening-architect`.

Authorized scope: the attached AWS staging architecture. It includes an internet-facing ALB, ECS services, RDS, S3, and the listed IAM roles.
Review identity boundaries, public exposure, segmentation, secrets, logging, encryption, blast radius, rollout, and rollback. Mark assumptions that need account or region evidence.
Return prioritized findings and deterministic validation checks. Do not connect to AWS or change cloud resources.
```

**Expected result:** a prioritized cloud hardening plan with explicit evidence gaps and safe rollout checks.

### 4. Controls Compliance Reviewer

Use `linmas-controls-compliance-reviewer` for SOC 2, ISO 27001, HIPAA, or PCI-DSS control mapping, evidence sufficiency, audit readiness, and gap planning.

**Example case:** You have MFA policy text, a quarterly access-review export, and a backup restore-test record for a SOC 2 readiness review.

```text
Use `linmas:linmas-controls-compliance-reviewer`.

Authorized scope: the attached sanitized evidence index for our SOC 2 readiness period [start date] to [end date].
Map the supplied evidence to the relevant controls, distinguish a missing document from a failed control, identify the evidence owner and verification method, and create a prioritized gap list.
Do not claim certification or compliance. Do not invent or alter evidence.
```

**Expected result:** an evidence-based control map and honest gaps, not an audit approval.

### 5. Detection Rules Engineer

Use `linmas-detection-rules-engineer` for SIEM rules, telemetry requirements, ATT&CK mapping, threat hunts, alert tuning, false positives, and detection-as-code design.

**Example case:** You want to detect repeated failed sign-ins followed by a successful sign-in from a new location.

```text
Use `linmas:linmas-detection-rules-engineer`.

Authorized scope: the attached sanitized authentication-event schema and five sample events from our staging SIEM.
Design a vendor-neutral detection for repeated failures followed by success from a new location. State telemetry prerequisites, ATT&CK mapping, rule logic, likely benign cases, tuning fields, a validation fixture, alert owner, and response path.
Do not claim coverage without evidence and do not deploy the rule.
```

**Expected result:** testable detection logic with known blind spots and a promotion checklist.

### 6. Exploit Validation Specialist

Use `linmas-exploit-validation-specialist` only for an explicitly authorized lab, staging, CTF, or research environment where a suspected weakness needs bounded validation.

**Example case:** An internal review suspects SSRF in an isolated staging service and the owner wants the least harmful validation plan.

```text
Use `linmas:linmas-exploit-validation-specialist`.

Authorized scope: isolated staging service `staging.example.invalid`, owned by our team, during the approved window [time]. The suspected issue is SSRF in the URL-preview feature.
Produce a non-destructive validation plan that states the hypothesis, minimum proof threshold, preconditions, evidence to capture, stop conditions, remediation, and retest criteria.
Do not send requests, provide persistence or stealth guidance, access credentials, or execute a payload.
```

**Expected result:** a bounded validation plan; no target interaction occurs unless separately authorized and executed by a human-controlled process.

### 7. Incident Triage Lead

Use `linmas-incident-triage-lead` for active security-event classification, evidence preservation, containment planning, investigation coordination, recovery, and post-incident follow-up.

**Example case:** A repository scanner reports that a GitHub token may have been committed.

```text
Use `linmas:linmas-incident-triage-lead`.

Authorized scope: the attached redacted alert, commit timestamps, and access-log summary for our repository. Treat the credential value itself as secret and never reproduce it.
Create an initial severity assessment, fact-versus-hypothesis timeline, volatile evidence checklist, containment options with operational trade-offs, owners, communication cadence, and next validation steps.
Do not revoke credentials, delete history, contact external parties, or alter evidence.
```

**Expected result:** a calm, evidence-preserving triage plan with explicit owners and decision points.

### 8. Secure Systems Architect

Use `linmas-secure-systems-architect` for cross-system trust boundaries, identity and authorization models, data flows, multi-tenancy, control placement, and secure failure modes.

**Example case:** You are designing a multi-tenant SaaS with an API, background workers, PostgreSQL, and object storage.

```text
Use `linmas:linmas-secure-systems-architect`.

Authorized scope: the attached pre-implementation architecture for our multi-tenant SaaS.
Map trust zones, identities, tenant context, sensitive data flows, privileged paths, external integrations, and failure modes. Identify architecture risks and the controls that must exist in code, infrastructure, and monitoring, with downstream owners and deterministic checks.
Keep the result at design-review level; do not implement or deploy changes.
```

**Expected result:** an architecture threat model that turns trust assumptions into testable control decisions.

### 9. Security Operations Lead

Use `linmas-security-operations-lead` for monitoring plans, operational hardening, alert ownership, escalation paths, runbooks, telemetry health, and vulnerability-management workflows.

**Example case:** A new payment service needs an operational security plan before production.

```text
Use `linmas:linmas-security-operations-lead`.

Authorized scope: the attached deployment and operations plan for our new payment service.
Design the minimum monitoring, log-retention, hardening, escalation, and recovery runbook. For every proposed alert, name the signal, threshold, owner, response action, evidence requirement, and rollback-safe operational step.
Do not change infrastructure, enable alerts, or claim monitoring coverage that has not been tested.
```

**Expected result:** an actionable SecOps runbook whose alerts have owners and response paths.

### 10. Smart Contract Reviewer

Use `linmas-smart-contract-reviewer` for authorized Solidity or Web3 code review, asset-flow analysis, protocol invariants, access control, external calls, oracle assumptions, and upgrade safety.

**Example case:** A local Solidity vault has a withdrawal function and an upgradeable admin path that need pre-deployment review.

```text
Use `linmas:linmas-smart-contract-reviewer`.

Authorized scope: commit [hash] of the attached Solidity contracts in a local test project; no deployed or live-network contracts are in scope.
Review asset flows, withdrawal state transitions, reentrancy, privileged roles, initialization, upgrades, external calls, and protocol invariants. Return evidence-linked findings, safe regression or invariant tests, remediation, and assumptions that need chain-state validation.
Do not submit transactions, deploy exploit code, or interact with a live network.
```

**Expected result:** a read-only protocol-risk review with safe validation tests and no on-chain action.

### 11. Threat Research Analyst

Use `linmas-threat-research-analyst` for supplied IOC analysis, campaign hypotheses, ATT&CK mapping, source confidence, intelligence briefs, and detection-oriented handoff.

**Example case:** Your SOC has a sanitized list of domains, file hashes, and phishing-email observations from an internal case.

```text
Use `linmas:linmas-threat-research-analyst`.

Authorized scope: the attached sanitized IOC list and source notes from our internal phishing case.
Normalize the indicators, separate observations from hypotheses, assess source confidence and indicator age, map supported behavior to ATT&CK, identify benign lookalikes, and produce bounded hunt leads plus a handoff to detection engineering.
Do not query external services, interact with infrastructure, identify victims, or make high-confidence attribution from a single signal.
```

**Expected result:** a confidence-scored defensive intelligence brief with actionable but bounded next steps.

## Verification after installation

Check the plugin and version:

```bash
codex plugin list
```

Expected plugin entry:

```text
linmas@linmas  installed, enabled  0.5.3
```

If a new installation is not discovered in a current task, restart the Codex desktop/app-server and create a new task. Then ask Codex to list the Linmas skills or MCP tools.

## Troubleshooting

### `linmas@linmas` is not found

The GitHub marketplace must be added separately on each computer. Add or refresh it, then retry the plugin installation:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref main
codex plugin add linmas@linmas
```

If you were searching the Codex Plugins Directory, Linmas may not appear there yet because the public GitHub marketplace and the official global directory are separate distribution channels.

### The plugin is installed but skills or MCP tools are missing

Restart the Codex desktop/app-server and create a fresh task. Existing app-server child processes can retain an older cache.

### npm reports an unsupported engine

Install Node.js 24 or newer and verify it:

```bash
node --version
```

### ChatGPT cannot find Linmas in its plugin catalog

That is expected for this release. Linmas is currently a Codex Git marketplace plugin. A ChatGPT integration would require a separate hosted ChatGPT App or remote MCP deployment.

## Related documentation

- [Panduan Penggunaan Linmas — Bahasa Indonesia](PANDUAN-PENGGUNAAN.md)
- [README](README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](.github/SECURITY.md)
