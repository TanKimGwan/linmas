// tests/detect-hosts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHosts } from '../src/core/detect-hosts.mjs';

test('detectHosts reports Claude and Codex as detected when directories exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });

    const results = detectHosts({ env: {}, homedir: home, platform: 'linux' });
    const claude = results.find((item) => item.host === 'claude');
    const codex = results.find((item) => item.host === 'codex');

    assert.equal(claude.status, 'detected');
    assert.equal(claude.installRoot, path.join(home, '.claude', 'skills'));
    assert.match(claude.reason, /\.claude/);

    assert.equal(codex.status, 'detected');
    assert.equal(codex.installRoot, path.join(home, '.codex', 'skills'));
    assert.match(codex.reason, /\.codex/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectHosts reports probably_detected when root exists but skills does not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

    const results = detectHosts({ env: {}, homedir: home, platform: 'linux' });
    const claude = results.find((item) => item.host === 'claude');
    const codex = results.find((item) => item.host === 'codex');

    assert.equal(claude.status, 'probably_detected');
    assert.equal(claude.installRoot, path.join(home, '.claude', 'skills'));
    assert.match(claude.reason, /skills root is missing/);

    assert.equal(codex.status, 'probably_detected');
    assert.equal(codex.installRoot, path.join(home, '.codex', 'skills'));
    assert.match(codex.reason, /skills root is missing/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectHosts reports not_detected when root does not exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  try {
    const results = detectHosts({ env: {}, homedir: home, platform: 'linux' });
    const claude = results.find((item) => item.host === 'claude');
    const codex = results.find((item) => item.host === 'codex');

    assert.equal(claude.status, 'not_detected');
    assert.equal(claude.writable, false);

    assert.equal(codex.status, 'not_detected');
    assert.equal(codex.writable, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
