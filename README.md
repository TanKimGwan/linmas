# Linmas

Linmas is an open-source defensive security skill collection for Claude Code and compatible AI coding agents.

It is designed to provide reusable, specialist security guidance that stays practical, reviewable, and safe for legitimate defensive work.

## What Linmas Includes

Installable skills are the first-class entries under `skills/<skill-name>/SKILL.md`.
The current public package includes:
- `skills/`
- `scripts/`
- `README.md`
- `package.json`
- `LICENSE`
- `NOTICE`
- `TRADEMARK.md`

## Skill Catalog

- `secure-code-reviewer` — secure code review, threat modeling, and remediation guidance
- `smart-contract-reviewer` — smart contract and protocol risk review for authorized Web3 work
- `cloud-hardening-architect` — cloud IAM, segmentation, hardening, and platform guardrails
- `controls-compliance-reviewer` — control mapping, evidence review, and audit readiness support
- `incident-triage-lead` — incident triage, containment planning, and evidence-preserving response coordination
- `exploit-validation-specialist` — authorized exploit-path validation and bounded proof-of-impact review
- `secure-systems-architect` — trust-boundary analysis, control placement, and secure system design review
- `security-domain-router` — routing help for choosing the right Linmas security specialist
- `security-operations-lead` — monitoring workflows, operational hardening, and escalation readiness
- `detection-rules-engineer` — SIEM rules, alert tuning, telemetry mapping, and detection engineering
- `threat-research-analyst` — IOC analysis, adversary tracking, and defensive intelligence reporting

## Intended Use

Linmas is intended for defensive, authorized, and legitimate security work, including:
- application security review
- secure architecture review
- cloud security review
- incident response support
- detection engineering
- compliance review
- threat intelligence analysis
- authorized penetration testing planning and reporting

Do not use Linmas for unauthorized access, credential theft, destructive attacks, stealth, persistence, evasion, or harm.

## Validation

```bash
npm run validate
npm run pack:dry-run
```

## Installation

Install from the package and inspect available skills:

```bash
npx linmas list
npx linmas detect
npx linmas install secure-code-reviewer --dry-run
```

Key commands:
- `npx linmas install <skill>` — install one skill to a detected host
- `npx linmas install --all` — install all first-class Linmas skills
- `npx linmas onboard` — show what the skills are for and where they are installed
- `npx linmas doctor` — inspect host detection and managed-install health
- `npx linmas uninstall <skill>` — remove one Linmas-managed skill

## Licensing and Attribution

Linmas is licensed under Apache License 2.0.
See:
- `LICENSE` for the full license text
- `NOTICE` for attribution guidance
- `TRADEMARK.md` for name and branding restrictions

Apache-2.0 allows commercial and noncommercial use, redistribution, and modification, but Linmas branding is not part of the software license. If you redistribute or adapt Linmas, keep attribution intact and use distinct branding for derivative projects.

## Project Goals

- maintain reusable security-specialist skills
- keep skill structure consistent and reviewable
- enforce safety boundaries for dual-use domains
- validate the package surface before release
- support a future npm installer CLI
