// tests/install-apply.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyInstallPlan } from '../src/core/install-skills.mjs';
import { readManifest } from '../src/core/manifest.mjs';

test('applyInstallPlan copies the skill and records it in the manifest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-install-'));
  try {
    const sourceDir = path.join(tmp, 'repo', 'skills', 'secure-code-reviewer');
    const targetRoot = path.join(tmp, '.claude');
    const installRoot = path.join(targetRoot, 'skills');
    const manifestPath = path.join(targetRoot, 'linmas-manifest.json');

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# skill\n');
    fs.mkdirSync(installRoot, { recursive: true });

    const plan = [{
      host: 'claude',
      skill: { name: 'secure-code-reviewer', description: 'desc', sourceDir, skillFile: path.join(sourceDir, 'SKILL.md') },
      destinationDir: path.join(installRoot, 'secure-code-reviewer'),
      existingState: 'missing',
      backupDir: null,
      willWrite: true
    }];

    const manifests = new Map([['claude', readManifest(manifestPath, 'claude')]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);
    applyInstallPlan(plan, manifests, manifestPathByHost);

    assert.equal(fs.existsSync(path.join(installRoot, 'secure-code-reviewer', 'SKILL.md')), true);
    const manifest = readManifest(manifestPath, 'claude');
    assert.equal(manifest.skills[0].name, 'secure-code-reviewer');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyInstallPlan performs backups when necessary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-install-'));
  try {
    const sourceDir = path.join(tmp, 'repo', 'skills', 'secure-code-reviewer');
    const targetRoot = path.join(tmp, '.claude');
    const installRoot = path.join(targetRoot, 'skills');
    const manifestPath = path.join(targetRoot, 'linmas-manifest.json');
    const backupDir = path.join(targetRoot, '.linmas-backups', '20260707-120000', 'secure-code-reviewer');

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# new skill\n');

    // Create existing files at target destination
    const destDir = path.join(installRoot, 'secure-code-reviewer');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), '# old skill\n');

    const plan = [{
      host: 'claude',
      skill: { name: 'secure-code-reviewer', description: 'desc', sourceDir, skillFile: path.join(sourceDir, 'SKILL.md') },
      destinationDir: destDir,
      existingState: 'managed',
      backupDir,
      willWrite: true
    }];

    const manifests = new Map([['claude', readManifest(manifestPath, 'claude')]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);
    const { written, backups } = applyInstallPlan(plan, manifests, manifestPathByHost);

    assert.deepEqual(written, [destDir]);
    assert.deepEqual(backups, [backupDir]);

    // Verify backup file exists and has the old content
    assert.equal(fs.readFileSync(path.join(backupDir, 'SKILL.md'), 'utf8'), '# old skill\n');
    // Verify destination has the new content
    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), '# new skill\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyInstallPlan refuses to write through a symlinked skills root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-install-'));
  try {
    const sourceDir = path.join(tmp, 'repo', 'skills', 'secure-code-reviewer');
    const targetRoot = path.join(tmp, '.claude');
    const installRoot = path.join(targetRoot, 'skills');
    const manifestPath = path.join(targetRoot, 'linmas-manifest.json');

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# skill\n');

    // Attacker plants a symlink: ~/.claude/skills -> /some/dir/outside the host root.
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.symlinkSync(outside, installRoot);

    const plan = [{
      host: 'claude',
      skill: { name: 'secure-code-reviewer', description: 'desc', sourceDir, skillFile: path.join(sourceDir, 'SKILL.md') },
      destinationDir: path.join(installRoot, 'secure-code-reviewer'),
      existingState: 'missing',
      backupDir: null,
      willWrite: true
    }];

    const manifests = new Map([['claude', readManifest(manifestPath, 'claude')]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);

    assert.throws(() => {
      applyInstallPlan(plan, manifests, manifestPathByHost);
    }, /refusing to write outside root/);
    // Nothing should have been written into the symlink target.
    assert.equal(fs.existsSync(path.join(outside, 'secure-code-reviewer')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyInstallPlan throws error when destination is outside host root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-install-'));
  try {
    const sourceDir = path.join(tmp, 'repo', 'skills', 'secure-code-reviewer');
    const targetRoot = path.join(tmp, '.claude');
    const manifestPath = path.join(targetRoot, 'linmas-manifest.json');

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# skill\n');

    const plan = [{
      host: 'claude',
      skill: { name: 'secure-code-reviewer', description: 'desc', sourceDir, skillFile: path.join(sourceDir, 'SKILL.md') },
      destinationDir: path.join(tmp, 'unauthorized-skills-dir', 'secure-code-reviewer'),
      existingState: 'missing',
      backupDir: null,
      willWrite: true
    }];

    const manifests = new Map([['claude', readManifest(manifestPath, 'claude')]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);

    assert.throws(() => {
      applyInstallPlan(plan, manifests, manifestPathByHost);
    }, /refusing to write outside root/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

