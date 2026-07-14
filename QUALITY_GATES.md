# Linmas Quality Gates

## 1. Gate: Before Editing

Before modifying files, confirm:

- [ ] Task mode is clear: DISCOVERY, IMPLEMENT, REVIEW, or FINALIZE.
- [ ] Scope is clear.
- [ ] Files to modify are known.
- [ ] No global Claude config change is needed.
- [ ] No user-global skill directory under `~/.claude/skills` will be modified unless explicitly requested.

## 2. Gate: After Editing

Run relevant validation:

```bash
npm run validate
npm run pack:dry-run
npm test
```

If only docs changed, still run secret-pattern scan before commit.

## 3. Gate: Skill Tree Safety

Run:

```bash
node scripts/validate-skills.mjs
/usr/bin/find skills -type l -ls
/usr/bin/find skills \( -name ".env" -o -name ".env.*" -o -name "*.log" -o -name "*.bak" -o -name "*.tmp" -o -name ".DS_Store" \) -type f -print
```

Expected:

- validator passes
- symlink output empty
- forbidden file output empty

## 4. Gate: Secret Scan

Run:

```bash
grep -RInE "(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|password=|token=|api[_-]?key=|apikey=)" \
  README.md package.json scripts skills .gitignore || true
```

Classify matches:

- `PASS`: no matches
- `PASS WITH NOTES`: only safe doc examples/placeholders
- `NEEDS REVIEW`: ambiguous match
- `FAIL`: suspected real secret

If `FAIL`, stop.

## 5. Gate: Before Commit

Run:

```bash
git status --short --untracked-files=all
git diff --stat
```

Stage exact files only. Do not use `git add .`.

Then run:

```bash
git diff --cached --name-only
git diff --cached --stat
```

Confirm only approved files are staged.

## 6. Gate: Before Push

Run:

```bash
git branch --show-current
git status --short --untracked-files=all
git log --oneline -1
git show --stat --oneline HEAD
git show --name-only --oneline HEAD
```

Confirm:

- correct branch
- expected commit
- expected files only
- no uncommitted required work left behind

## 7. Gate: Before NPM Publish

Run:

```bash
npm run validate
npm run pack:dry-run
```

Also confirm:

- [ ] License selected.
- [ ] `LICENSE` exists.
- [x] Installer exists and `npm test` passes.
- [ ] Public release checklist passes.
- [ ] Explicit approval received.
- [ ] release tags must come from `main`.

## 8. Gate: Branch Protection

- [ ] `main` is protected: force pushes are blocked, and `verify` status check must pass before merging.
- [ ] `dev` is protected: force pushes are blocked, and `verify` status check must pass before merging.

## 9. Gate: Branch Policy

- [ ] Work targets `dev` first; `main` is release-ready only.
- [ ] Feature branches are based on `dev` and merged back to `dev`.
- [ ] `main` only receives changes through promotion from `dev`.
- [ ] Release tags `vX.Y.Z` are created only from commits on `main`.
- [ ] Direct work on `main` is an exception and must be reconciled back to `dev`.

## 10. Failure Handling

If any quality gate fails:

1. Stop.
2. Report the gate that failed.
3. Report exact file paths involved.
4. Do not commit, push, or publish.
5. Ask for approval before destructive or broad remediation.
