// tests/detect-hosts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHosts } from '../src/core/detect-hosts.mjs';

test('detectHosts reports Claude as detected when ~/.claude/skills exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });

  const results = detectHosts({ env: {}, homedir: home, platform: 'linux' });
  const claude = results.find((item) => item.host === 'claude');

  assert.equal(claude.status, 'detected');
  assert.equal(claude.installRoot, path.join(home, '.claude', 'skills'));
  assert.match(claude.reason, /\.claude/);
});

test('detectHosts reports probably_detected when root exists but skills does not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  const results = detectHosts({ env: {}, homedir: home, platform: 'linux' });
  const claude = results.find((item) => item.host === 'claude');

  assert.equal(claude.status, 'probably_detected');
  assert.equal(claude.installRoot, path.join(home, '.claude', 'skills'));
  assert.match(claude.reason, /skills root is missing/);
});

test('detectHosts reports not_detected when root does not exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));

  const results = detectHosts({ env: {}, homedir: home, platform: 'linux' });
  const claude = results.find((item) => item.host === 'claude');

  assert.equal(claude.status, 'not_detected');
  assert.equal(claude.writable, false);
});
