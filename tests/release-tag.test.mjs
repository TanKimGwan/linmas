import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/verify-release-tag.mjs');

function createTempGitRepo(pkgJsonContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-test-tag-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJsonContent));

  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['add', 'package.json'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });

  return dir;
}

function createTag(dir, tag) {
  execFileSync('git', ['tag', tag], { cwd: dir });
}

test('verify-release-tag rejects invalid tag format', () => {
  const dir = createTempGitRepo({ version: '0.1.0' });
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [
        SCRIPT_PATH,
        '--tag', '0.1.0',
        '--version-file', path.join(dir, 'package.json'),
        '--main-ref', 'main'
      ], { cwd: dir, stdio: 'pipe' });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /invalid tag format/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-release-tag rejects mismatched version', () => {
  const dir = createTempGitRepo({ version: '0.1.0' });
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [
        SCRIPT_PATH,
        '--tag', 'v0.2.0',
        '--version-file', path.join(dir, 'package.json'),
        '--main-ref', 'main'
      ], { cwd: dir, stdio: 'pipe' });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /tag does not match package version/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-release-tag rejects package json without string version', () => {
  const dir = createTempGitRepo({ name: 'linmas' });
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [
        SCRIPT_PATH,
        '--tag', 'v0.1.0',
        '--version-file', path.join(dir, 'package.json'),
        '--main-ref', 'main'
      ], { cwd: dir, stdio: 'pipe' });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /package version must be a string/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-release-tag rejects commit not on main', () => {
  const dir = createTempGitRepo({ version: '0.1.0' });
  try {
    execFileSync('git', ['checkout', '-b', 'feature-branch'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'hello');
    execFileSync('git', ['add', 'feature.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'feature commit'], { cwd: dir });
    createTag(dir, 'v0.1.0');

    assert.throws(() => {
      execFileSync(process.execPath, [
        SCRIPT_PATH,
        '--tag', 'v0.1.0',
        '--version-file', path.join(dir, 'package.json'),
        '--main-ref', 'main'
      ], { cwd: dir, stdio: 'pipe' });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /tagged commit is not on main/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-release-tag succeeds for valid configuration', () => {
  const dir = createTempGitRepo({ version: '0.1.0' });
  try {
    createTag(dir, 'v0.1.0');
    const result = execFileSync(process.execPath, [
      SCRIPT_PATH,
      '--tag', 'v0.1.0',
      '--version-file', path.join(dir, 'package.json'),
      '--main-ref', 'main'
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
