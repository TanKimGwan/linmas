# Linmas

Linmas is an open-source defensive security skill collection for Claude Code and compatible AI coding agents.

Installable skills are the first-class entries under `skills/<skill-name>/SKILL.md`. Treat the `skills/` directory and `npm run validate` output as the source of truth for the current installable skill set.

The npm package currently publishes:
- `skills/`
- `scripts/`
- `README.md`
- `package.json`


## What Linmas Is For

Linmas is intended for defensive, authorized, and legitimate security work, including:

- application security review
- secure architecture review
- cloud security review
- incident response support
- detection engineering
- compliance review
- threat intelligence analysis
- authorized penetration testing planning and reporting

Do not use these skills for unauthorized access, exploitation, evasion, persistence, credential theft, or harm.

## Repository Goals

- maintain reusable security-specialist skills
- keep skill structure consistent and reviewable
- enforce safety boundaries for dual-use domains
- validate the package surface before release
- support a future npm installer CLI

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

## Validate

```bash
npm run validate
npm run pack:dry-run
```

## Installation

An npm-based installer is planned but not implemented yet.

Do not assume `npx linmas install` exists until the installer CLI is added.

## License

This project is licensed under `MIT`. See `LICENSE` for the full text.
