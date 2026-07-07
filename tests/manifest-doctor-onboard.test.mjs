// tests/manifest-doctor-onboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readManifest, writeManifest } from '../src/core/manifest.mjs';
import { formatDoctorReport } from '../src/core/doctor.mjs';

test('readManifest returns an empty manifest when none exists', () => {
  const manifestPath = path.join(os.tmpdir(), 'linmas-missing-manifest.json');
  const manifest = readManifest(manifestPath, 'claude');
  assert.equal(manifest.host, 'claude');
  assert.deepEqual(manifest.skills, []);
});

test('formatDoctorReport includes manifest mismatch details', () => {
  const report = formatDoctorReport(
    [{ host: 'claude', status: 'detected', reason: 'ok', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', rootPath: '/tmp/.claude', writable: true }],
    [{ tool: 'linmas', version: '0.1.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-07T00:00:00.000Z', skills: [{ name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null }] }],
    new Set()
  );

  assert.match(report, /secure-code-reviewer/);
  assert.match(report, /missing on disk/i);
});