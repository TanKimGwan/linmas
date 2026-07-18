#!/usr/bin/env node
/**
 * Bootstrap script for the new TanKimGwan/linmas public repository.
 *
 * SAFETY: This script prints required `gh` commands but does NOT execute
 * any destructive operations automatically. It does not read secret values,
 * set repo visibility, delete repos, or push.
 *
 * Usage:
 *   node scripts/bootstrap-github-repo.mjs
 *
 * Review each command before running it.
 */

const REPO = 'TanKimGwan/linmas';
const REPO_FLAG = `--repo ${REPO}`;
const NEWLINE = '\n';

const steps = [
  {
    title: 'Verify authenticated GitHub identity',
    cmds: ['gh auth status'],
    note: 'Confirm you are logged in as the correct account.',
  },
  {
    title: 'Set repository description and topics',
    cmds: [
      `gh repo edit ${REPO} \\`,
      `  --description "First-line defensive security skills for Claude Code and compatible AI coding agents." \\`,
      `  --add-topic "security" \\`,
      `  --add-topic "defensive-security" \\`,
      `  --add-topic "claude-code"`,
    ],
    note: 'Run after pushing the clean repository.',
  },
  {
    title: 'Set the NPM_TOKEN secret',
    cmds: [
      `echo "Visit https://www.npmjs.com/settings/__token__ to generate an automation token"`,
      `echo "Then run:"`,
      `echo "  gh secret set NPM_TOKEN ${REPO_FLAG}"`,
      `echo "(paste the token when prompted — it will not be echoed or stored in this repo)"`,
    ],
    note: 'Required for the release workflow to publish. Keep the token value out of the repository.',
  },
  {
    title: 'Create the dev branch',
    cmds: [
      `git push -u origin main`,
      `git switch -c dev`,
      `git push -u origin dev`,
      `git switch main`,
    ],
    note: 'Run from the clean public repo clone after adding the origin remote.',
  },
  {
    title: 'Configure branch protection — main',
    cmds: [
      `gh api repos/${REPO}/branches/main/protection \\`,
      `  --method PUT \\`,
      `  --field required_status_checks='{"checks":[{"context":"verify"}],"strict":true}' \\`,
      `  --field enforce_admins=true \\`,
      `  --field required_pull_request_reviews='{}' \\`,
      `  --field restrictions=null`,
    ],
    note: 'Requires a GitHub plan that supports branch protection. May fail on free-tier repos — if so, configure manually in Settings → Branches.',
  },
  {
    title: 'Configure branch protection — dev',
    cmds: [
      `gh api repos/${REPO}/branches/dev/protection \\`,
      `  --method PUT \\`,
      `  --field required_status_checks='{"checks":[{"context":"verify"}],"strict":true}' \\`,
      `  --field enforce_admins=true \\`,
      `  --field required_pull_request_reviews='{}' \\`,
      `  --field restrictions=null`,
    ],
    note: 'Same plan limitation as main. Configure manually if API fails.',
  },
  {
    title: 'Final verification',
    cmds: [
      `echo "=== Branch listing ==="`,
      `git ls-remote origin 'refs/heads/*'`,
      `echo ""`,
      `echo "=== Branch protection (main) ==="`,
      `gh api repos/${REPO}/branches/main/protection --jq '.required_status_checks.contexts'`,
      `echo ""`,
      `echo "=== Branch protection (dev) ==="`,
      `gh api repos/${REPO}/branches/dev/protection --jq '.required_status_checks.contexts'`,
      `echo ""`,
      `echo "=== Secrets ==="`,
      `gh secret list ${REPO_FLAG}`,
    ],
    note: 'Confirm everything is set up correctly.',
  },
];

console.log(`# Linmas GitHub Repository Bootstrap`);
console.log(`# Target: ${REPO}`);
console.log(`#`);
console.log(`# This script prints commands for review.`);
console.log(`# Nothing is executed automatically.`);
console.log(`${NEWLINE}`);

for (const step of steps) {
  console.log(`## ${step.title}`);
  console.log(`> ${step.note}`);
  console.log('');
  for (const cmd of step.cmds) {
    console.log(`  ${cmd}`);
  }
  console.log('');
}

console.log(`## Manual Steps Not Covered`);
console.log(``);
console.log(`1. Rename or delete the old private repo (TanKimGwan/linmas).`);
console.log(`   - This agent does not delete, rename, or change repo visibility.`);
console.log(`2. Create the new empty repo "TanKimGwan/linmas" on GitHub.`);
console.log(`3. Push the clean public tree to the new repo:`);
console.log(`     git remote add origin git@github.com:${REPO}.git`);
console.log(`     git push -u origin main`);
console.log(`     git switch -c dev`);
console.log(`     git push -u origin dev`);
console.log(`     git switch main`);
console.log(`4. Confirm the first CI run passes.`);
console.log(`5. Enable GitHub Actions if disabled.`);
console.log(`6. Make the repo public (or keep private — maintainer decision).`);
console.log(``);
