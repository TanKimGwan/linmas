# Linmas Project Context

## 1. What Linmas Is

Linmas is an open-source repository for defensive security skills for Claude Code and compatible AI coding agents.

It is maintained as:

1. A versioned public repository.
2. A validated skill collection.
3. A future npm-installable package with a safe installer CLI.

## 2. Current Baseline

The repository currently contains 11 first-class skill folders:

```txt
skills/security-operations-lead/SKILL.md
skills/smart-contract-reviewer/SKILL.md
skills/exploit-validation-specialist/SKILL.md
skills/threat-research-analyst/SKILL.md
skills/detection-rules-engineer/SKILL.md
skills/incident-triage-lead/SKILL.md
skills/controls-compliance-reviewer/SKILL.md
skills/cloud-hardening-architect/SKILL.md
skills/secure-systems-architect/SKILL.md
skills/secure-code-reviewer/SKILL.md
skills/security-domain-router/SKILL.md
```

Directories without `SKILL.md` are not treated as first-class installable skills unless intentionally normalized.

## 3. Development Priorities

Priority order:

1. Safety and authorized-use boundary.
2. No secrets or local artifacts.
3. Consistent skill structure.
4. Validator correctness.
5. NPM package surface correctness.
6. Installer safety.
7. Public release readiness.

## 4. Important Constraints

Agents must not:

- modify global Claude config
- modify `~/.claude/skills` unless explicitly requested
- publish to npm without explicit approval
- commit or push without explicit approval
- include secrets
- add harmful security content

## 5. Current Known Note

`skills/secure-code-reviewer/SKILL.md:105` previously triggered a documentation-style secret-pattern candidate. It should be reviewed and normalized before public npm release.

## 6. Recommended Next Work

1. Run the substantive skill safety review across all 11 first-class skills.
2. Review and classify the `secure-code-reviewer` candidate line.
3. Reconcile the documented skill standard with the current Linmas house style.
4. Decide the long-term role of non-first-class `security` material and `security-domain-router`.
5. Extend the validator to enforce structure and safety expectations.
