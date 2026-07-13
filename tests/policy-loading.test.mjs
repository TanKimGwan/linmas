import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicyPack } from '../src/policy/load-pack.mjs';

const rootDir = path.resolve(import.meta.dirname, '..');

test('loads a named built-in pack', () => {
  assert.equal(loadPolicyPack({ id: 'baseline-appsec', rootDir }).id, 'baseline-appsec');
});

test('requires one source and rejects unknown built-ins', () => {
  assert.throws(() => loadPolicyPack({ rootDir }), /exactly one/);
  assert.throws(() => loadPolicyPack({ id: 'baseline-appsec', filePath: 'pack.json', rootDir }), /exactly one/);
  assert.throws(() => loadPolicyPack({ id: 'missing', rootDir }), /unknown built-in policy/);
});

test('rejects symlinks, oversized files, and malformed packs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-policy-'));
  fs.writeFileSync(path.join(dir, 'target.json'), '{}');
  fs.symlinkSync(path.join(dir, 'target.json'), path.join(dir, 'pack.json'));
  assert.throws(() => loadPolicyPack({ filePath: 'pack.json', cwd: dir, rootDir }), /symlink/);
  fs.unlinkSync(path.join(dir, 'pack.json'));
  fs.writeFileSync(path.join(dir, 'pack.json'), '123456789');
  assert.throws(() => loadPolicyPack({ filePath: 'pack.json', cwd: dir, rootDir, maxBytes: 8 }), /exceeds 8 bytes/);
  fs.writeFileSync(path.join(dir, 'pack.json'), '{');
  assert.throws(() => loadPolicyPack({ filePath: 'pack.json', cwd: dir, rootDir }), /invalid JSON/);
});
