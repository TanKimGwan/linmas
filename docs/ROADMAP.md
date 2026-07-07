# Linmas Roadmap

## Roadmap Principles

Linmas should grow conservatively. Because it is a security-focused open-source repository, the project should prioritize safety, reviewability, and package hygiene over fast feature expansion.

## [x] Milestone 1 — Documentation Hardening

Scope:

- align `README.md`, `AGENTS.md`, `CLAUDE.md`, and core docs around one standalone project identity
- remove stale bootstrap/import framing from active docs
- remove machine-specific paths from active guidance
- keep canonical docs short, current, and internally consistent

Exit criteria:

- active docs describe Linmas in present tense as an independent project
- docs do not include private secrets or machine-specific configuration
- repo-level guidance is internally consistent

## [ ] Milestone 2 — Public Safety Review

Scope:

- review each first-class skill
- normalize allowed/disallowed use framing
- review candidate secret-pattern examples
- remove or reword ambiguous risky examples

Exit criteria:

- each skill has explicit defensive-use framing
- no skill includes unauthorized exploitation, persistence, stealth, evasion, credential theft, or malware guidance
- secret scan is clean or only documented placeholders remain

## [ ] Milestone 3 — Skill Standardization

Scope:

- define required sections
- normalize skill style
- add optional metadata/frontmatter where needed
- update validator to check required headings

Exit criteria:

- every skill follows `docs/SKILL_STANDARD.md`
- validator enforces basic structure
- skill inventory and docs stay synchronized

## [ ] Milestone 4 — `security` Directory Decision

Scope:

- decide whether the `security` concept should remain archival, become category docs, become a first-class skill, or map to `security-domain-router`
- update validator and docs accordingly

Exit criteria:

- decision recorded in `docs/DECISIONS.md`
- repository structure reflects the decision
- docs explain the resulting structure clearly

## [x] Milestone 5 — NPM Installer MVP

Scope:

- add CLI entrypoint
- add `list`, `validate`, and `install --dry-run`
- add selected-skill install
- add safe backup behavior
- add no silent overwrite rule

Exit criteria:

- `npx linmas list` works after local package link or pack test
- `npx linmas install --dry-run` shows intended actions without writing
- installer does not modify global Claude config
- installer does not overwrite existing skills without confirmation or backup

## [ ] Milestone 6 — Release Candidate

Scope:

- review package metadata
- add CI validation
- run final release checklist
- confirm package surface, documentation, and installer behavior

Exit criteria:

- public release checklist passes
- package dry-run content is approved
- repository state is clean and reviewable
- release tag is ready

## [ ] Milestone 7 — NPM Publish

Scope:

- publish only after explicit approval
- verify npm package page
- test install from npm
- update README with real installation instructions

Exit criteria:

- package can be installed from npm
- installer works from npm package
- release notes are published

## Long-Term Ideas

- skill manifest file
- agent compatibility matrix
- GitHub Action to validate skill packages
- marketplace-style generated docs
- versioned skill migration tool
- optional local user config for install path
