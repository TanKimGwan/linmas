# Linmas Public Release Checklist

## 1. Repository Readiness

- [ ] Repository has clean branch strategy.
- [ ] Development branch contains current work.
- [ ] Main release branch is protected or reviewed manually.
- [ ] No unrelated local files are present.
- [ ] No generated temporary artifacts are tracked.

## 2. Documentation Readiness

- [x] `README.md` accurately describes current capabilities.
- [x] README does not claim npm install works before CLI exists.
- [ ] `AGENTS.md` exists.
- [ ] `CLAUDE.md` exists.
- [ ] `docs/PRD.md` exists.
- [ ] `docs/TASKLIST.md` exists.
- [ ] `docs/NPM_PACKAGING_PLAN.md` exists.
- [ ] `docs/SECURITY_AND_AUTHORIZED_USE.md` exists.
- [ ] `docs/SKILL_STANDARD.md` exists.
- [ ] `docs/QUALITY_GATES.md` exists.

## 3. License Readiness

- [ ] License selected.
- [ ] `package.json` license updated.
- [ ] `LICENSE` file added.
- [ ] `NOTICE` file added.
- [ ] `TRADEMARK.md` file added.
- [ ] README license section updated.
- [ ] Third-party derived-content review completed if needed.

Current expectation:

```txt
package.json license, LICENSE, NOTICE, and TRADEMARK.md match the intended release state
```

## 4. Skill Safety Review

For every skill:

- [ ] Defensive/authorized-use framing exists.
- [ ] No credential theft guidance.
- [ ] No persistence guidance.
- [ ] No stealth guidance.
- [ ] No evasion guidance.
- [ ] No malware guidance.
- [ ] No unauthorized exploitation workflow.
- [ ] Includes safe reporting/remediation framing.

Special review:

- [ ] `skills/secure-code-reviewer/SKILL.md:105` reviewed.

## 5. Secret Hygiene

Run:

```bash
grep -RInE "(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|password=|token=|api[_-]?key=|apikey=)" \
  README.md package.json scripts docs skills .gitignore AGENTS.md CLAUDE.md || true
```

Checklist:

- [ ] No real secrets detected.
- [ ] Placeholders are clearly fake.
- [ ] Example tokens are not realistic-looking.
- [ ] No `.env` files tracked.
- [ ] No private keys tracked.

## 6. Validator Readiness

Run:

```bash
npm run validate
```

Checklist:

- [ ] Expected skills exist.
- [ ] Each skill has `SKILL.md`.
- [ ] Skill frontmatter and minimum shared headings validate.
- [ ] Explicit authorized-use language is present in every skill.
- [ ] No symlinks under `skills/`.
- [ ] No forbidden files under `skills/`.
- [ ] Only normalized first-class skill directories are treated as installable.

## 7. Package Surface Readiness

Run:

```bash
npm run pack:dry-run
```

Checklist:

- [ ] Package includes only intended files.
- [ ] Package excludes local config.
- [ ] Package excludes backups.
- [ ] Package excludes logs.
- [ ] Package excludes temporary files.
- [ ] Package excludes `.env` files.

## 8. Installer Readiness

Required before real npm release:

- [x] CLI entrypoint exists.
- [x] `linmas list` works.
- [x] `linmas detect` works.
- [x] `linmas onboard` works.
- [x] `linmas doctor` works.
- [x] `linmas install --dry-run` works.
- [x] Selected skill install works.
- [x] All skill install works.
- [x] Existing target backup behavior works.
- [x] Silent overwrite is prevented.
- [x] `linmas uninstall` works.
- [x] Installer does not modify global Claude config.

## 9. Git Release Readiness

Before tagging:

```bash
git status --short --untracked-files=all
git log --oneline -5
npm run validate
npm run pack:dry-run
```

Checklist:

- [ ] Working tree clean.
- [ ] Last commit reviewed.
- [ ] No uncommitted changes.
- [ ] Tag version matches `package.json`.

## 10. NPM Publish Readiness

Do not run `npm publish` until all are true:

- [ ] License state is confirmed.
- [ ] Public safety review complete.
- [x] Installer implemented and tested.
- [ ] Package dry-run approved.
- [ ] Release notes prepared.
- [ ] Explicit approval received.

Publish command should be run manually and intentionally:

```bash
npm publish --access public
```

Only after final approval.
