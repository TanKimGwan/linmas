# Linmas Repository Setup Guide

This document lists everything that must be reconfigured when creating a new `TanKimGwan/linmas` repository from the clean public source tree.

## 1. Default Branch

- `main` — set as the default branch after first push.

## 2. Branches

- `main` — public-facing default, release-ready only.
- `dev` — integration branch, normal PR target. Create after first push:

  ```bash
  git push -u origin main
  git switch -c dev
  git push -u origin dev
  git switch main
  ```

## 3. Branch Protection

Both `main` and `dev` must be protected:

| Setting | main | dev |
|---|---|---|
| Require pull request before merging | ✅ | ✅ |
| Required status checks — `verify` | ✅ | ✅ |
| Block force pushes | ✅ | ✅ |
| Block deletion | ✅ | ✅ |

Apply via GitHub web UI (Settings → Branches → Add rule) or with `gh`:

```bash
REPO="TanKimGwan/linmas"

gh api repos/$REPO/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"checks":[{"context":"verify"}],"strict":true}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{}' \
  --field restrictions=null

gh api repos/$REPO/branches/dev/protection \
  --method PUT \
  --field required_status_checks='{"checks":[{"context":"verify"}],"strict":true}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{}' \
  --field restrictions=null
```

> **Note:** Branch protection via API may require a GitHub plan that supports it. If the API returns an error, configure manually in the GitHub UI.

### Promotion ancestry sync

After a `dev` to `main` promotion is merged, `sync-main-to-dev.yml` checks whether the promotion commit is absent from `dev`. When needed, it creates a main-to-dev ancestry sync PR from a uniquely named automation branch. The workflow never merges the PR itself; normal protection and required checks still apply.

Enable **Allow GitHub Actions to create and approve pull requests** under repository Actions settings so the workflow can create the synchronization PR.

## 4. Secrets

- `NPM_TOKEN` — required only for the release workflow (`npm publish --access public`).
- Do not store secret values in the repository.
- Set manually with:

  ```bash
  gh secret set NPM_TOKEN --repo TanKimGwan/linmas
  ```

## 5. GitHub Actions

- Workflows are included in `.github/workflows/`.
- Enable Actions in the new repo (Settings → Actions → Allow all actions).
- After first push, confirm `ci.yml` runs on push/PR.
- The `verify` status check is required by branch protection — it is the job name in `ci.yml`.
- Confirm a promotion push can create a main-to-dev ancestry sync PR.

## 6. Repo Metadata

Set via GitHub UI or:

```bash
gh repo edit TanKimGwan/linmas \
  --description "First-line defensive security skills for Claude Code and compatible AI coding agents." \
  --homepage "https://www.npmjs.com/package/linmas" \
  --add-topic "security" \
  --add-topic "defensive-security" \
  --add-topic "claude-code" \
  --add-topic "ai-security"
```

## 7. After Setup Checklist

- [ ] Default branch is `main`.
- [ ] `dev` branch exists and is pushed.
- [ ] `main` branch protection is configured (PR required, `verify` check, no force-push).
- [ ] `dev` branch protection is configured (PR required, `verify` check, no force-push).
- [ ] `NPM_TOKEN` secret is set.
- [ ] GitHub Actions are enabled.
- [ ] First CI run passes on `main`.
- [ ] Repo visibility is set correctly (public / private per maintainer decision).
