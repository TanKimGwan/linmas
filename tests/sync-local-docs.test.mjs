import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/sync-local-docs.mjs');
const DOCS = [
  'docs/NPM_PACKAGING_PLAN.md'
];

function withTempDirs(fn) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-docsync-repo-'));
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-docsync-backup-'));
  try {
    return fn({ repo, backup });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

function writeDocs(root, values) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  for (const rel of DOCS) {
    fs.writeFileSync(path.join(root, rel), values[rel]);
  }
}

function runSync(mode, { cwd, backupDir, env = {} }) {
  const childEnv = { ...process.env, ...env };
  if (backupDir !== undefined) {
    childEnv.LINMAS_DOCS_BACKUP_DIR = backupDir;
  } else {
    delete childEnv.LINMAS_DOCS_BACKUP_DIR;
  }
  return execFileSync(process.execPath, [SCRIPT, mode], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('backup copies the local-only docs into the backup root', () => {
  withTempDirs(({ repo, backup }) => {
    writeDocs(repo, {
      [DOCS[0]]: 'npm plan'
    });
    runSync('backup', { cwd: repo, backupDir: backup });
    assert.equal(fs.readFileSync(path.join(backup, DOCS[0]), 'utf8'), 'npm plan');
  });
});

test('backup defaults to ~/.claude/linmas-docs-backup when env is unset', () => {
  withTempDirs(({ repo }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-docsync-home-'));
    try {
      writeDocs(repo, {
        [DOCS[0]]: 'npm plan'
      });
      runSync('backup', { cwd: repo, env: { HOME: home } });
      const backupRoot = path.join(home, '.claude', 'linmas-docs-backup');
      assert.equal(fs.readFileSync(path.join(backupRoot, DOCS[0]), 'utf8'), 'npm plan');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test('restore recreates missing docs in repo root', () => {
  withTempDirs(({ repo, backup }) => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    writeDocs(backup, {
      [DOCS[0]]: 'restored npm plan'
    });
    runSync('restore', { cwd: repo, backupDir: backup });
    assert.equal(fs.readFileSync(path.join(repo, DOCS[0]), 'utf8'), 'restored npm plan');
  });
});

test('invalid mode exits non-zero', () => {
  withTempDirs(({ repo, backup }) => {
    assert.throws(() => {
      runSync('bad-mode', { cwd: repo, backupDir: backup });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /usage: node scripts\/sync-local-docs\.mjs <backup|restore>/);
      return true;
    });
  });
});

test('helper ignores docs outside the fixed allowlist', () => {
  withTempDirs(({ repo, backup }) => {
    writeDocs(repo, {
      [DOCS[0]]: 'npm plan',
      [DOCS[1]]: 'release checklist',
      [DOCS[2]]: 'quality gates'
    });
    fs.writeFileSync(path.join(repo, 'docs', 'EXTRA.md'), 'should stay local');
    runSync('backup', { cwd: repo, backupDir: backup });
    assert.equal(fs.existsSync(path.join(backup, 'docs', 'EXTRA.md')), false);
  });
});

test('unsafe backup path configuration exits non-zero', () => {
  withTempDirs(({ repo }) => {
    writeDocs(repo, {
      [DOCS[0]]: 'npm plan'
    });
    assert.throws(() => {
      runSync('backup', { cwd: repo, backupDir: path.join(repo, '.backup') });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /unsafe backup path/i);
      return true;
    });
  });
});

test('unsafe backup path inside repo root with dotdot prefix exits non-zero', () => {
  withTempDirs(({ repo }) => {
    writeDocs(repo, {
      [DOCS[0]]: 'npm plan'
    });
    assert.throws(() => {
      runSync('backup', { cwd: repo, backupDir: path.join(repo, '..backup') });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /unsafe backup path/i);
      return true;
    });
  });
});

test('running outside a repo root exits non-zero', () => {
  withTempDirs(({ repo }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-docsync-tmp-'));
    try {
      assert.throws(() => {
        runSync('backup', { cwd: tmp });
      }, (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /must be run from the repository root/i);
        return true;
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
