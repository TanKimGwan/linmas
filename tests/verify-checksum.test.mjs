import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/verify-checksum.mjs');

function createTempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-verify-checksum-'));
  const filePath = path.join(dir, 'artifact.tgz');
  fs.writeFileSync(filePath, contents);
  return { dir, filePath };
}

test('verify-checksum prints sha256 hash for the given file', () => {
  const { dir, filePath } = createTempFile('hello');
  try {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, filePath], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(output.trim(), /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-checksum prints sha256 hash for a directory containing one tgz', () => {
  const { dir } = createTempFile('hello');
  try {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, dir], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(output.trim(), /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-checksum --check fails on mismatched hash', () => {
  const { dir, filePath } = createTempFile('hello');
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT_PATH, '--check', '00000000', filePath], { stdio: 'pipe' });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /expected 00000000, got [a-f0-9]{64}/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-checksum --check succeeds when the hash matches', () => {
  const { dir, filePath } = createTempFile('hello');
  try {
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    const output = execFileSync(process.execPath, [SCRIPT_PATH, '--check', expected, filePath], { encoding: 'utf8', stdio: 'pipe' });
    assert.equal(output.trim(), 'OK');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
