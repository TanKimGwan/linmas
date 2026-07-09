# Contributing to Linmas

Normal pull requests go to `dev`.
`main` is the public-facing default branch and only accepts promotion from `dev`.

## 1. Contribution Scope

Linmas accepts contributions that improve:

- defensive security skill quality
- authorized-use safety boundaries
- skill consistency
- validator coverage
- npm packaging safety
- documentation clarity
- public release readiness

Do not contribute content that enables unauthorized access, credential theft, stealth, persistence, evasion, malware, or harm.

## 2. Local Setup

```bash
npm install
npm run validate
npm run pack:dry-run
```

The project currently uses minimal dependencies. Do not add dependencies unless there is a clear need.

## 3. Skill Changes

Each skill must live at:

```txt
skills/<skill-name>/SKILL.md
```

Before changing a skill, read:

- `SKILL_STANDARD.md`
- `SECURITY_AND_AUTHORIZED_USE.md`

## 4. Validation

Run:

```bash
npm run validate
npm run pack:dry-run
```

Run secret-pattern scan before submitting changes:

```bash
grep -RInE "(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|password=|token=|api[_-]?key=|apikey=)" \
  README.md package.json scripts docs skills .gitignore AGENTS.md CLAUDE.md || true
```

## 5. Git Hygiene

Do not use:

```bash
git add .
```

Stage exact files only.

Before commit:

```bash
git status --short --untracked-files=all
git diff --stat
git diff --cached --name-only
```

## 6. Pull Request Checklist

- [ ] Scope is clear.
- [ ] Only relevant files changed.
- [ ] `npm run validate` passes.
- [ ] `npm run pack:dry-run` passes.
- [ ] No secrets included.
- [ ] No unsafe security content added.
- [ ] README/docs updated if behavior changed.

## 7. Release Contributions

Published-package smoke tests must run from a neutral temporary directory, not from inside the Linmas source checkout. Running `npx linmas@<version>` inside the package checkout can produce false negatives due npm/npx same-package resolution behavior.

Use:

```bash
npm view linmas version
node scripts/smoke-published-package.mjs 0.1.6
```

Release-related changes must also pass `PUBLIC_RELEASE_CHECKLIST.md`.
