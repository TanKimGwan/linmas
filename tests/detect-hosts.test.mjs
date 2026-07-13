import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHosts } from '../src/core/detect-hosts.mjs';

test('detectHosts accepts an injected registry', () => {
  const registry = new Map([
    ['fake', { detect: () => ({ host: 'fake', status: 'not_detected' }) }]
  ]);

  assert.deepEqual(detectHosts({ registry }), [
    { host: 'fake', status: 'not_detected' }
  ]);
});

test('detectHosts reports Claude and Codex as detected when directories exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });

    assert.deepEqual(detectHosts({ env: {}, homedir: home, platform: 'linux' }), [
      {
        host: 'claude',
        status: 'detected',
        reason: `${path.join(home, '.claude', 'skills')} exists`,
        rootPath: path.join(home, '.claude'),
        installRoot: path.join(home, '.claude', 'skills'),
        manifestPath: path.join(home, '.claude', 'linmas-manifest.json'),
        writable: true
      },
      {
        host: 'codex',
        status: 'detected',
        reason: `${path.join(home, '.codex', 'skills')} exists`,
        rootPath: path.join(home, '.codex'),
        installRoot: path.join(home, '.codex', 'skills'),
        manifestPath: path.join(home, '.codex', 'linmas-manifest.json'),
        writable: true
      }
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectHosts reports probably_detected when root exists but skills does not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

    assert.deepEqual(detectHosts({ env: {}, homedir: home, platform: 'linux' }), [
      {
        host: 'claude',
        status: 'probably_detected',
        reason: `${path.join(home, '.claude')} exists but skills root is missing`,
        rootPath: path.join(home, '.claude'),
        installRoot: path.join(home, '.claude', 'skills'),
        manifestPath: path.join(home, '.claude', 'linmas-manifest.json'),
        writable: true
      },
      {
        host: 'codex',
        status: 'probably_detected',
        reason: `${path.join(home, '.codex')} exists but skills root is missing`,
        rootPath: path.join(home, '.codex'),
        installRoot: path.join(home, '.codex', 'skills'),
        manifestPath: path.join(home, '.codex', 'linmas-manifest.json'),
        writable: true
      }
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectHosts reports not_detected when root does not exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-'));
  try {
    assert.deepEqual(detectHosts({ env: {}, homedir: home, platform: 'linux' }), [
      {
        host: 'claude',
        status: 'not_detected',
        reason: 'no host directory or binary found',
        rootPath: path.join(home, '.claude'),
        installRoot: path.join(home, '.claude', 'skills'),
        manifestPath: path.join(home, '.claude', 'linmas-manifest.json'),
        writable: false
      },
      {
        host: 'codex',
        status: 'not_detected',
        reason: 'no host directory or binary found',
        rootPath: path.join(home, '.codex'),
        installRoot: path.join(home, '.codex', 'skills'),
        manifestPath: path.join(home, '.codex', 'linmas-manifest.json'),
        writable: false
      }
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectHosts with PATH and platform evidence / validation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-detect-path-'));
  const claudeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-claude-bin-'));
  const codexBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-codex-bin-'));
  try {
    const claudeRoot = path.join(home, '.claude');
    const codexRoot = path.join(home, '.codex');
    fs.mkdirSync(claudeRoot, { recursive: true });
    fs.writeFileSync(path.join(claudeBinDir, 'claude'), 'mock binary');

    assert.deepEqual(
      detectHosts({ env: { PATH: claudeBinDir }, homedir: home, platform: 'linux' }),
      [
        {
          host: 'claude',
          status: 'detected',
          reason: `skills root is missing but ${claudeRoot} exists and target root can be created safely`,
          rootPath: claudeRoot,
          installRoot: path.join(claudeRoot, 'skills'),
          manifestPath: path.join(claudeRoot, 'linmas-manifest.json'),
          writable: true
        },
        {
          host: 'codex',
          status: 'not_detected',
          reason: 'no host directory or binary found',
          rootPath: codexRoot,
          installRoot: path.join(codexRoot, 'skills'),
          manifestPath: path.join(codexRoot, 'linmas-manifest.json'),
          writable: false
        }
      ]
    );

    assert.deepEqual(
      detectHosts({ env: { PATH: '' }, homedir: home, platform: 'linux' }),
      [
        {
          host: 'claude',
          status: 'probably_detected',
          reason: `${claudeRoot} exists but skills root is missing`,
          rootPath: claudeRoot,
          installRoot: path.join(claudeRoot, 'skills'),
          manifestPath: path.join(claudeRoot, 'linmas-manifest.json'),
          writable: true
        },
        {
          host: 'codex',
          status: 'not_detected',
          reason: 'no host directory or binary found',
          rootPath: codexRoot,
          installRoot: path.join(codexRoot, 'skills'),
          manifestPath: path.join(codexRoot, 'linmas-manifest.json'),
          writable: false
        }
      ]
    );

    fs.writeFileSync(path.join(codexBinDir, 'codex'), 'mock binary');
    assert.deepEqual(
      detectHosts({ env: { PATH: codexBinDir }, homedir: home, platform: 'linux' }),
      [
        {
          host: 'claude',
          status: 'probably_detected',
          reason: `${claudeRoot} exists but skills root is missing`,
          rootPath: claudeRoot,
          installRoot: path.join(claudeRoot, 'skills'),
          manifestPath: path.join(claudeRoot, 'linmas-manifest.json'),
          writable: true
        },
        {
          host: 'codex',
          status: 'detected',
          reason: `skills root is missing but ${codexRoot} exists and target root can be created safely`,
          rootPath: codexRoot,
          installRoot: path.join(codexRoot, 'skills'),
          manifestPath: path.join(codexRoot, 'linmas-manifest.json'),
          writable: true
        }
      ]
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claudeBinDir, { recursive: true, force: true });
    fs.rmSync(codexBinDir, { recursive: true, force: true });
  }
});
