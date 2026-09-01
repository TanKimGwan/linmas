#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveThroughSymlinks } from '../src/core/fs-utils.mjs';

const DOCS = [
  'docs/NPM_PACKAGING_PLAN.md'
];

const mode = process.argv[2];
// Resolve through symlinks so the containment check below compares real paths on
// both sides. process.cwd() is already realpathed by the OS, so a backup path
// that reaches the repo via a symlinked ancestor (e.g. /var -> /private/var on
// macOS) must be resolved the same way or the guard is trivially bypassable.
const repoRoot = resolveThroughSymlinks(process.cwd());

if (!['backup', 'restore'].includes(mode)) {
  console.error('usage: node scripts/sync-local-docs.mjs <backup|restore>');
  process.exit(1);
}

if (!fs.existsSync(path.join(repoRoot, 'package.json'))) {
  console.error('must be run from the repository root');
  process.exit(1);
}

const backupRoot = resolveThroughSymlinks(
  process.env.LINMAS_DOCS_BACKUP_DIR || path.join(os.homedir(), '.claude', 'linmas-docs-backup')
);

const relativeToRepo = path.relative(repoRoot, backupRoot);
// Treat backupRoot as inside the repo when it is the repo itself or a descendant.
// A leading `..` segment (rel === '..' or '..'+sep) means it escapes the repo; a
// name that merely *starts* with dots (e.g. '..backup') is still a descendant.
const escapesRepo = relativeToRepo === '..' || relativeToRepo.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRepo);
const backupInsideRepo = relativeToRepo === '' || !escapesRepo;
if (backupInsideRepo) {
  console.error('unsafe backup path configuration');
  process.exit(1);
}

for (const rel of DOCS) {
  const from = path.join(mode === 'backup' ? repoRoot : backupRoot, rel);
  const to = path.join(mode === 'backup' ? backupRoot : repoRoot, rel);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
