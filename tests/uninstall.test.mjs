import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planUninstall, formatUninstallPreview, applyUninstallPlan } from '../src/core/uninstall-skills.mjs';

test('planUninstall only includes manifest-managed skill paths', () => {
  const plan = planUninstall({
    manifests: [{ tool: 'linmas', version: '0.1.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-07T00:00:00.000Z', skills: [{ name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null }] }],
    detections: [{ host: 'claude', status: 'detected', reason: 'ok', rootPath: '/tmp/.claude', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', writable: true }],
    skillName: 'secure-code-reviewer',
    uninstallAll: false
  });

  assert.deepEqual(plan, [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/.claude/skills/secure-code-reviewer', installRoot: '/tmp/.claude/skills' }]);
});

test('planUninstall plans all when uninstallAll is true', () => {
  const plan = planUninstall({
    manifests: [{ tool: 'linmas', version: '0.1.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-07T00:00:00.000Z', skills: [{ name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null }, { name: 'other', path: '/tmp/.claude/skills/other', backupPath: null }] }],
    detections: [{ host: 'claude', status: 'detected', reason: 'ok', rootPath: '/tmp/.claude', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', writable: true }],
    skillName: null,
    uninstallAll: true
  });

  assert.deepEqual(plan, [
    { host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/.claude/skills/secure-code-reviewer', installRoot: '/tmp/.claude/skills' },
    { host: 'claude', skillName: 'other', skillPath: '/tmp/.claude/skills/other', installRoot: '/tmp/.claude/skills' }
  ]);
});

test('formatUninstallPreview matches expectations', () => {
  const plan = [
    { host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/.claude/skills/secure-code-reviewer' }
  ];
  const output = formatUninstallPreview(plan);
  assert.equal(output, 'Linmas uninstall preview:\n- claude: remove secure-code-reviewer from /tmp/.claude/skills/secure-code-reviewer\n');
});

test('applyUninstallPlan deletes the files and updates manifest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-'));
  try {
    const installRoot = path.join(tmp, '.claude', 'skills');
    const skillPath = path.join(installRoot, 'secure-code-reviewer');
    const manifestPath = path.join(tmp, '.claude', 'linmas-manifest.json');

    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# skill\n');

    const manifest = {
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const plan = [{
      host: 'claude',
      skillName: 'secure-code-reviewer',
      skillPath,
      installRoot
    }];

    const manifests = new Map([['claude', manifest]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);

    const result = applyUninstallPlan(plan, manifests, manifestPathByHost);
    assert.deepEqual(result.removed, [skillPath]);
    assert.equal(fs.existsSync(skillPath), false);

    const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(updatedManifest.skills, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUninstallPlan throws if outside root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-'));
  try {
    const installRoot = path.join(tmp, '.claude', 'skills');
    const skillPath = path.join(tmp, 'unauthorized', 'secure-code-reviewer');
    const manifestPath = path.join(tmp, '.claude', 'linmas-manifest.json');

    const manifest = {
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };

    const plan = [{
      host: 'claude',
      skillName: 'secure-code-reviewer',
      skillPath,
      installRoot
    }];

    const manifests = new Map([['claude', manifest]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);

    assert.throws(() => {
      applyUninstallPlan(plan, manifests, manifestPathByHost);
    }, /refusing to write outside root/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
