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

- npm publishing uses npm trusted publishing with GitHub Actions OIDC; no long-lived npm token is required.
- `CODEX_API_KEY` is required only by the advisory live-evaluation workflow. Local Linmas users continue to authenticate through Codex.
- Set the live model as repository variable `LINMAS_EVAL_MODEL`.
- Never store secret values in the repository. Configure the CI credential and model with:

  ```bash
  gh secret set CODEX_API_KEY --repo TanKimGwan/linmas
  gh variable set LINMAS_EVAL_MODEL --repo TanKimGwan/linmas --body "<account-visible-model>"
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
  --description "Proof-carrying defensive security reviews for AI-assisted software, with deterministic policy, portable evidence, and human review required." \
  --homepage "https://www.npmjs.com/package/linmas" \
  --add-topic "security" \
  --add-topic "defensive-security" \
  --add-topic "codex" \
  --add-topic "openai" \
  --add-topic "ai-security"
```

## 7. After Setup Checklist

- [ ] Default branch is `main`.
- [ ] `dev` branch exists and is pushed.
- [ ] `main` branch protection is configured (PR required, `verify` check, no force-push).
- [ ] `dev` branch protection is configured (PR required, `verify` check, no force-push).
- [ ] npm trusted publishing is connected to the release workflow.
- [ ] `CODEX_API_KEY` secret and `LINMAS_EVAL_MODEL` variable are set for live evaluation.
- [ ] GitHub Actions are enabled.
- [ ] First CI run passes on `main`.
- [ ] Repo visibility is set correctly (public / private per maintainer decision).
