# Linmas Detailed Task List

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked / needs decision

## Historical Note

Early bootstrap work, repository import, identity cleanup, skill renaming, and provenance removal have already been completed. This task list tracks the remaining forward-looking work.

## Phase 1 — Docs and Archive Follow-Through

Goal: keep project docs current while separating active guidance from archival material.

- [x] Reframe active docs so Linmas reads as a standalone open-source project.
- [x] Remove private machine-local path leakage from active docs.
- [x] Align README, PRD, roadmap, AGENTS, and CLAUDE guidance around the current Linmas identity.
- [ ] Run a final docs-only pass for secret-like examples and private-endpoint leakage.
- [ ] Decide whether bootstrap/provenance notes should stay in place or move to a dedicated history/archive area.

## Phase 2 — Skill Content Safety Review

Goal: ensure every first-class skill is public-release safe in substance, not only in top-level framing.

- [ ] Review all 11 first-class skills for authorized-use and public-safety compliance.
- [ ] Check each skill body for risky examples, overly offensive tradecraft, or unsafe operational assumptions.
- [ ] Confirm every skill keeps clear defensive-use framing and actionable remediation guidance.
- [ ] Review `skills/secure-code-reviewer/SKILL.md:105`.
- [ ] Classify the candidate as `DOC_EXAMPLE`, `PLACEHOLDER`, `NEEDS_REVIEW`, or `REAL_SECRET_SUSPECTED`.
- [ ] Normalize wording or examples if needed after classification.

## Phase 3 — Skill Standard and Validator Enforcement

Goal: reconcile the documented skill standard with the current Linmas house style and enforce it automatically.

- [x] Define a documented skill standard in `docs/SKILL_STANDARD.md`.
- [ ] Decide whether YAML frontmatter is required or optional for first-class skills.
- [ ] Decide whether the current Linmas house style becomes the canonical standard or whether skills must be reshaped again to match the existing standard doc.
- [ ] Normalize all first-class skills to the final chosen standard.
- [ ] Add automated checks for required headings/structure.
- [ ] Extend `scripts/validate-skills.mjs` beyond inventory checks to enforce the chosen structure and basic safety expectations.

## Phase 4 — Non-First-Class `security` Material

Goal: finish follow-through on the current decision for archival/category security material.

- [x] Record the current decision that `security` is not a first-class skill unless intentionally normalized.
- [ ] Remove or archive any lingering ambiguous references that imply `security` is still awaiting basic discovery.
- [ ] Decide the intended long-term role of `security-domain-router` versus archival `docs/security/readme.md`.
- [ ] Revisit promotion to `skills/security/SKILL.md` only if intentionally requested later.

## Phase 5 — NPM Installer Design Signoff

Goal: finalize the already-documented installer design before implementation.

- [x] Document the installer concept in `docs/NPM_PACKAGING_PLAN.md`.
- [x] Review `docs/NPM_PACKAGING_PLAN.md` for final design signoff.
- [x] Confirm any unresolved details around install confirmation, overwrite behavior, backup behavior, and command output.

## Phase 6 — NPM Installer Implementation

Goal: add a working CLI installer.

- [x] Add `bin/linmas.mjs`.
- [x] Add `bin` field to `package.json`.
- [x] Implement `list` command.
- [x] Implement `validate` command (via validate-skills.mjs and test integrations).
- [x] Implement `install --dry-run`.
- [x] Implement selected-skill install.
- [x] Implement all-skill install.
- [x] Implement backup for existing target skill.
- [x] Prevent silent overwrite.
- [x] Add tests for installer behavior.
- [x] Update README installation section.
- [x] Run `npm pack --dry-run` after implementation.

## Phase 7 — Release Readiness

Goal: prepare for public repository and npm release.

- [ ] Review all skills for safety and consistency after the full safety pass completes.
- [ ] Run final secret scan.
- [ ] Run validator.
- [ ] Run pack dry-run.
- [ ] Verify package content list.
- [ ] Review package metadata, README clarity, and release notes.
- [ ] Tag release candidate.
- [ ] Publish only after explicit approval.

## Phase 8 — CI/CD

Goal: prevent unsafe or broken changes from entering main branches.

- [ ] Add GitHub Actions workflow for validation.
- [ ] Run `npm run validate` in CI.
- [ ] Run `npm run pack:dry-run` in CI.
- [ ] Add secret scanning action or local equivalent.
- [ ] Add markdown linting if useful.
- [ ] Add package content check.
- [ ] Require PR review before main release branch.

## Phase 9 — Documentation and Examples

Goal: make the package useful for external users.

- [x] Add installation docs after CLI exists.
- [ ] Add usage examples.
- [ ] Add skill selection guide.
- [ ] Add FAQ.
- [ ] Improve contributor guidance if needed.
- [ ] Add changelog.

## Phase 10 — Long-Term Enhancements

- [x] Add machine-readable skill manifest.
- [ ] Add compatibility layer for other AI coding agents.
- [ ] Add generated index of skills.
- [ ] Add test fixtures.
- [ ] Add release automation.
- [ ] Add signed release artifact consideration.
