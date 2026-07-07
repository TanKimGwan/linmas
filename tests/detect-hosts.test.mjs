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
  const claudeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-claude-bin-'));
  const codexBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-codex-bin-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    fs.writeFileSync(path.join(claudeBinDir, 'claude'), 'mock binary');
    const results = detectHosts({ env: { PATH: claudeBinDir }, homedir: home, platform: 'linux' });
    const claude = results.find((item) => item.host === 'claude');
    assert.equal(claude.status, 'detected');
    assert.match(claude.reason, /skills root is missing.*can be created safely/i);
    assert.equal(claude.writable, true);

    const codex = results.find((item) => item.host === 'codex');
    assert.equal(codex.status, 'not_detected');

    const resultsEmpty = detectHosts({ env: { PATH: '' }, homedir: home, platform: 'linux' });
    const codexEmpty = resultsEmpty.find((item) => item.host === 'codex');
    assert.equal(codexEmpty.status, 'not_detected');
    assert.match(codexEmpty.reason, /no host directory or binary found/i);

    fs.writeFileSync(path.join(codexBinDir, 'codex'), 'mock binary');
    const resultsWithBinary = detectHosts({ env: { PATH: codexBinDir }, homedir: home, platform: 'linux' });
    const codexWithBinary = resultsWithBinary.find((item) => item.host === 'codex');
    assert.equal(codexWithBinary.status, 'detected');
    assert.equal(codexWithBinary.writable, true);
    assert.match(codexWithBinary.reason, /can be created safely|writable/i);

    const claudeWithoutBinary = resultsWithBinary.find((item) => item.host === 'claude');
    assert.equal(claudeWithoutBinary.status, 'probably_detected');
    assert.match(claudeWithoutBinary.reason, /skills root is missing/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claudeBinDir, { recursive: true, force: true });
    fs.rmSync(codexBinDir, { recursive: true, force: true });
  }
});
