import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('contributing guide gates new installation hosts on evidence and parity', () => {
  const text = readFileSync(path.join(rootDir, 'CONTRIBUTING.md'), 'utf8');
  for (const phrase of ['host ID', 'user-demand evidence', 'installation root', 'manifest', 'conflict semantics', 'doctor', 'onboarding', 'uninstall', 'credentials', 'maintenance owner', 'fake home']) {
    assert.match(text, new RegExp(phrase, 'i'));
  }
});

test('host adapters contain no speculative third host', () => {
  const hostsDir = path.join(rootDir, 'src', 'hosts');
  const adapters = readdirSync(hostsDir)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => /export function create\w+Adapter/.test(readFileSync(path.join(hostsDir, name), 'utf8')))
    .map((name) => path.basename(name, '.mjs'))
    .sort();

  assert.deepEqual(adapters, ['claude', 'codex']);
});
