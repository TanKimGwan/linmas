# Linmas Public Release Checklist

## 1. Repository and Branch Readiness

- [x] Default branch strategy is defined: `main` is public-facing, `dev` is the integration branch.
- [x] Normal work targets `dev` first.
- [x] Merge `dev` into `main` for release promotion.
- [x] `main` only receives promotion from `dev`.
- [x] Branch protection is configured for both `main` and `dev`.
- [ ] Working tree is clean.
- [ ] No unrelated local files are present.
- [ ] No generated temporary artifacts are tracked.

## 2. Public Documentation Baseline

- [x] `README.md` accurately describes current capabilities.
- [x] `README.md` links to `CONTRIBUTING.md`.
- [x] `CONTRIBUTING.md` exists.
- [x] `QUALITY_GATES.md` exists.
- [x] `.github/SECURITY.md` exists.
- [x] `CODE_OF_CONDUCT.md` exists.
- [x] License and attribution files exist: `LICENSE`, `NOTICE`, `TRADEMARK.md`.

## 3. Skill Safety Review

For every published skill:

- [ ] Defensive/authorized-use framing exists.
- [ ] No credential theft guidance.
- [ ] No persistence guidance.
- [ ] No stealth guidance.
- [ ] No evasion guidance.
- [ ] No malware guidance.
- [ ] No unauthorized exploitation workflow.
- [ ] Includes safe reporting/remediation framing.

## 4. Secret Hygiene

Run:

```bash
gitleaks detect --source . --redact --verbose
gitleaks detect --source . --redact --log-opts="--all"
```

Checklist:

- [ ] gitleaks working tree scan passed.
- [ ] gitleaks history scan passed.
- [ ] No real secrets detected.
- [ ] No `.env` files tracked.
- [ ] No private keys tracked.

## 5. Validation and Package Surface

Run:

```bash
npm test
npm run validate
npm run pack:dry-run
npm pack
tar -tf linmas-*.tgz | sort
node scripts/smoke-published-package.mjs 0.1.6
```

Checklist:

- [ ] npm test passed.
- [ ] npm run validate passed.
- [ ] npm run pack:dry-run passed.
- [ ] Package tarball inspected.
- [ ] Package includes only intended public files.
- [ ] Package excludes local config, backups, logs, temp files, and `.env` files.

## 6. Internal/Public Boundary

- [ ] No internal docs exposed.
- [x] Shared ignore rules cover internal planning docs.
- [ ] Internal-only analysis/spec content is removed or sanitized before public launch.

## 7. Release and Visibility Gate

Before opening the repository visibility or shipping a public release:

- [ ] SECURITY.md exists.
- [ ] CODE_OF_CONDUCT.md exists.
- [ ] Branch protection verified.
- [ ] Explicit maintainer approval before public visibility change.
- [ ] Explicit maintainer approval before pushing a release tag.

## 8. Public Launch Gate

Public launch is ready only when all of the following are true:

- [ ] npm test passed.
- [ ] npm run validate passed.
- [ ] npm run pack:dry-run passed.
- [ ] gitleaks working tree scan passed.
- [ ] gitleaks history scan passed.
- [ ] no internal docs exposed.
- [ ] SECURITY.md exists.
- [ ] CODE_OF_CONDUCT.md exists.
- [ ] branch protection verified.
- [ ] package tarball inspected.
- [ ] explicit maintainer approval before public visibility change.
