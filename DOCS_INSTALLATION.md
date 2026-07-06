# Installing These Linmas Project Docs

## Target

Copy these files into the root of the Linmas repository:

```txt
<path-to-linmas-repo>/
```

## Recommended Copy

From extracted folder:

```bash
cp AGENTS.md CLAUDE.md <path-to-linmas-repo>/
cp -R docs/* <path-to-linmas-repo>/docs/
```

## Important

If the repository already has `AGENTS.md` or `CLAUDE.md`, review before overwriting.

Safer approach:

```bash
cp AGENTS.md <path-to-linmas-repo>/AGENTS.md.new
cp CLAUDE.md <path-to-linmas-repo>/CLAUDE.md.new
```

Then merge manually.

## Validate After Copy

```bash
cd <path-to-linmas-repo>
npm run validate
npm run pack:dry-run
git status --short --untracked-files=all
```

## Suggested Commit Message

```bash
git commit -m "docs: add linmas project planning and agent guide"
```

Stage exact files only. Do not use `git add .`.
