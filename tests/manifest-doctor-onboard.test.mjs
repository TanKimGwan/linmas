// tests/manifest-doctor-onboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readManifest, writeManifest } from '../src/core/manifest.mjs';
import { formatDoctorReport } from '../src/core/doctor.mjs';
import { formatOnboarding } from '../src/core/onboard.mjs';

test('readManifest returns an empty manifest when none exists', () => {
  const manifestPath = path.join(os.tmpdir(), 'linmas-missing-manifest.json');
  const manifest = readManifest(manifestPath, 'claude');
  assert.equal(manifest.host, 'claude');
  assert.deepEqual(manifest.skills, []);
});

test('writeManifest round-trips manifest data through readManifest', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-manifest-'));
  try {
    const manifestPath = path.join(tempDir, 'linmas-manifest.json');
    const manifest = {
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: path.join(tempDir, 'secure-code-reviewer'), backupPath: null }]
    };

    writeManifest(manifestPath, manifest);

    assert.deepEqual(readManifest(manifestPath, 'claude'), manifest);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('formatDoctorReport includes manifest mismatch details', () => {
  const report = formatDoctorReport(
    [{ host: 'claude', status: 'detected', reason: 'ok', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', rootPath: '/tmp/.claude', writable: true }],
    [{ tool: 'linmas', version: '0.1.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-07T00:00:00.000Z', skills: [{ name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null }] }],
    new Set()
  );

  assert.match(report, /secure-code-reviewer/);
  assert.match(report, /missing on disk/i);
  assert.match(report, /mismatch: tracked by manifest but missing on disk/i);
  assert.match(report, /backup directory: missing/i);
  assert.match(report, /target root validity: writable/i);
});

test('formatOnboarding includes required user-facing details', () => {
  const detections = [{ host: 'claude', status: 'detected', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', rootPath: '/tmp/.claude', writable: true }];
  const skills = [{ name: 'secure-code-reviewer', description: 'Review code safely' }];
  const manifests = [{
    tool: 'linmas',
    version: '0.1.0',
    manifestVersion: 1,
    host: 'claude',
    installedAt: '2026-07-07T00:00:00.000Z',
    skills: [{ name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null }]
  }];

  const output = formatOnboarding(detections, skills, manifests);

  assert.match(output, /Installed skills:/);
  assert.match(output, /destination paths:/i);
  assert.match(output, /run `npx linmas doctor`/);
  assert.match(output, /find more docs/i);
});