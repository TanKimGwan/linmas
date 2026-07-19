# Linmas Usage Guide

Linmas is a defensive security review toolkit for AI-assisted software. It provides a CLI, eleven namespaced security skills, deterministic policy checks, portable proof evidence, and a native MCP server for Codex. Human review remains required for every result.

## Requirements

- Node.js 24 or newer for the CLI, source checkout, and local MCP runtime.
- Git for the source installation and Codex marketplace installation.
- Codex CLI or Codex desktop/app-server for the Codex plugin path.

Linmas does not require an OpenAI API key for subscription-first Codex use. Codex owns provider authentication. Live review is opt-in and requires explicit confirmation before input leaves the machine.

## Choose an installation path

| Path | Best for | What it installs |
| --- | --- | --- |
| GitHub source | Contributors, reproducible local development, and the offline demo | The repository and its development scripts |
| npm | Running the Linmas CLI without cloning the repository | The published `linmas` package and CLI |
| Codex marketplace | Using Linmas skills and MCP tools inside Codex | The ready-to-install `linmas@linmas` plugin |

The npm package and Codex marketplace are separate distribution paths. Installing the npm package does not register a Codex marketplace, and installing the Codex plugin does not add the package to another Node.js project.

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
npm install --global linmas@0.5.1
linmas list
```

For a one-time invocation without a global install:

```bash
npx --yes linmas@0.5.1 list
npx --yes linmas@0.5.1 review --skill linmas-secure-code-reviewer --input patch.diff
```

For a project-local dependency:

```bash
npm install --save-dev linmas@0.5.1
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

For a reproducible immutable release, pin the repository ref:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref v0.5.1
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

## Verification after installation

Check the plugin and version:

```bash
codex plugin list
```

Expected plugin entry:

```text
linmas@linmas  installed, enabled  0.5.1
```

If a new installation is not discovered in a current task, restart the Codex desktop/app-server and create a new task. Then ask Codex to list the Linmas skills or MCP tools.

## Troubleshooting

### `linmas@linmas` is not found

Add or refresh the marketplace, then retry the plugin installation:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref main
codex plugin add linmas@linmas
```

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
