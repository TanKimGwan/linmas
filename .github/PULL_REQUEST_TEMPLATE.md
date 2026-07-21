## Summary

<!-- What changed and why? Link related issues or PRs when applicable. -->

## Scope

<!-- State the files/components in scope and explicitly call out anything excluded. -->

## Change type

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Test or validation
- [ ] Packaging or release
- [ ] Other: <!-- describe -->

## Validation

<!-- List the commands you ran and their PASS/FAIL result. Do not claim checks you did not run. -->

- [ ] `npm test` — <!-- result or N/A with reason -->
- [ ] `npm run validate` — <!-- result or N/A with reason -->
- [ ] `npm run pack:dry-run` — <!-- result or N/A with reason -->
- [ ] Other relevant checks: <!-- command and result -->

## Security and safety review

- [ ] The change remains defensive and limited to authorized use.
- [ ] No secrets, credentials, private keys, or sensitive review/provider data are included.
- [ ] Human review remains required; no output is described as automatic approval or certification.
- [ ] Any outbound transmission or filesystem write remains behind the existing explicit consent boundary.

## Branch and release policy

- [ ] This PR targets `dev`.
- [ ] This is the dedicated `dev` → `main` promotion PR.
- [ ] Release notes, version, or package metadata were updated when the change requires them.

## Checklist

- [ ] Scope is clear and unrelated working-tree changes are excluded.
- [ ] Relevant documentation and tests are updated.
- [ ] Backward compatibility and migration impact are documented, or marked not applicable.
- [ ] Rollback or revert path is understood.
