# Linmas NPM Packaging Plan

## 1. Current Status

Linmas now ships a stdlib-only installer CLI with:
- `npx linmas list`
- `npx linmas detect`
- `npx linmas install <skill>`
- `npx linmas install --all`
- `npx linmas onboard`
- `npx linmas doctor`
- `npx linmas uninstall <skill>`
- `npx linmas uninstall --all`

NPM publishing is not ready yet.

Reasons:

- Skill public safety review is not complete.
- The role of non-first-class security category material is still being decided.
- Existing skills still need deeper standardization and provenance cleanup.

## 2. Packaging Goals

The package should eventually allow users to install Linmas skills into their local Claude Code skill directory safely.

Potential user commands:

```bash
npx linmas list
npx linmas validate
npx linmas install --dry-run
npx linmas install secure-code-reviewer
npx linmas install --all
```

## 3. Package Surface

The npm package should include only:

```txt
skills/
scripts/
docs/
README.md
package.json
LICENSE
NOTICE
TRADEMARK.md
bin/                # after CLI exists
```

Use the `files` field in `package.json` to control the package surface.

Always run:

```bash
npm pack --dry-run
```

before release.

## 4. CLI Design

### 4.1 `linmas list`

Print available skills.

Expected output:

```txt
Available Linmas skills:
- secure-code-reviewer
- cloud-hardening-architect
- incident-triage-lead
- ...
```

### 4.2 `linmas validate`

Run package validation.

Checks:

- package contains expected skills
- each skill has `SKILL.md`
- no forbidden local artifacts
- no symlinks

### 4.3 `linmas install --dry-run`

Show what would be installed without writing anything.

Output should include:

- source skill path
- target install path
- whether target exists
- whether backup would be created

### 4.4 `linmas install <skill>`

Install one skill.

Rules:

- Do not overwrite silently.
- If target exists, create backup or require `--force`.
- Show final installed path.

### 4.5 `linmas install --all`

Install all package skills.

Rules:

- Require confirmation unless `--yes` is provided.
- Never install excluded or non-standard folders.

## 5. Install Path Strategy

Default target:

```txt
~/.claude/skills/<skill-name>/
```

But the CLI should support override:

```bash
npx linmas install secure-code-reviewer --target ~/.claude/skills
npx linmas install secure-code-reviewer --target ./local-skills
```

## 6. Overwrite and Backup Strategy

If target skill exists:

1. Do not overwrite silently.
2. Create timestamped backup by default, or require explicit `--force`.
3. Print what changed.

Potential backup format:

```txt
~/.claude/skills/.backup/linmas-YYYYMMDD-HHMMSS/<skill-name>/
```

## 7. Safety Rules

Installer must not:

- modify `~/.claude/settings.json`
- modify `~/.claude/settings.local.json`
- modify shell startup files
- install secrets
- read `.env` files
- overwrite user files silently
- require network after package is installed

## 8. Package Metadata Checklist

Before npm publish:

- [ ] `name` confirmed
- [ ] `version` correct
- [ ] `description` accurate
- [ ] `license` matches the intended release state
- [ ] `files` whitelist accurate
- [x] `bin` field added after CLI exists
- [x] README install instructions accurate
- [ ] package dry-run reviewed

## 9. Testing Plan

Test locally with:

```bash
npm run validate
npm run pack:dry-run
npm pack
```

Then test package installation in a temp directory:

```bash
mkdir -p <temp-test-dir>
cd <temp-test-dir>
npm init -y
npm install <path-to-linmas-tarball>
npx linmas list
npx linmas install --dry-run
```

## 10. Release Blockers

Do not publish while any of these are true:

- real secret suspected
- package dry-run includes unintended files
- skill safety review incomplete
- overwrite behavior untested
- release metadata is inconsistent with the intended package state
