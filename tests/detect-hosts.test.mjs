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

test('detectHosts with PATH and platform evidence / validation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-path-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-bin-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    // Claude root path exists and is writable.
    // When PATH has /bin, and we detect it, it should get promoted to detected because of validation.
    const results = detectHosts({ env: { PATH: '/bin' }, homedir: home, platform: 'linux' });
    const claude = results.find((item) => item.host === 'claude');
    assert.equal(claude.status, 'detected');
    assert.match(claude.reason, /skills root is missing.*can be created safely/i);
    assert.equal(claude.writable, true);

    const codex = results.find((item) => item.host === 'codex');
    assert.equal(codex.status, 'not_detected');

    // If PATH is empty, codex is not detected
    const resultsEmpty = detectHosts({ env: { PATH: '' }, homedir: home, platform: 'linux' });
    const codexEmpty = resultsEmpty.find((item) => item.host === 'codex');
    assert.equal(codexEmpty.status, 'not_detected');
    assert.match(codexEmpty.reason, /no host directory or binary found/i);

    // If binary exists in PATH, even without directory, it should be detected / probably_detected / detected (if writable)
    // Let's create a fake codex binary in binDir
    fs.writeFileSync(path.join(binDir, 'codex'), 'mock binary');
    const resultsWithBinary = detectHosts({ env: { PATH: binDir }, homedir: home, platform: 'linux' });
    const codexWithBinary = resultsWithBinary.find((item) => item.host === 'codex');
    // Since home/.codex does not exist, but we have binary evidence, we can create it safely
    assert.equal(codexWithBinary.status, 'detected');
    assert.equal(codexWithBinary.writable, true);
    assert.match(codexWithBinary.reason, /can be created safely|writable/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
