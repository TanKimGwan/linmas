#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DOCS = [
  'docs/NPM_PACKAGING_PLAN.md'
];

const mode = process.argv[2];
const repoRoot = path.resolve(process.cwd());

if (!['backup', 'restore'].includes(mode)) {
  console.error('usage: node scripts/sync-local-docs.mjs <backup|restore>');
  process.exit(1);
}

if (!fs.existsSync(path.join(repoRoot, 'package.json'))) {
  console.error('must be run from the repository root');
  process.exit(1);
}

const backupRoot = path.resolve(
  process.env.LINMAS_DOCS_BACKUP_DIR || path.join(os.homedir(), '.claude', 'linmas-docs-backup')
);

if (backupRoot.startsWith(repoRoot + path.sep) || backupRoot === repoRoot) {
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
