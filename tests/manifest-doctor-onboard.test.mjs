// tests/manifest-doctor-onboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readManifest, writeManifest, validateManifest } from '../src/core/manifest.mjs';
import { preflightInstall, applyInstallPlan } from '../src/core/install-skills.mjs';
import { copySkillDirectory } from '../src/core/fs-utils.mjs';
import { formatDoctorReport } from '../src/core/doctor.mjs';
import { formatOnboarding } from '../src/core/onboard.mjs';

test('readManifest returns an empty manifest when none exists', () => {
  const manifestPath = path.join(os.tmpdir(), 'linmas-missing-manifest.json');
  const manifest = readManifest(manifestPath, 'claude');
  assert.equal(manifest.host, 'claude');
  assert.deepEqual(manifest.skills, []);
});

test('readManifest rejects host mismatch with field-specific error', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-manifest-'));
  try {
    const manifestPath = path.join(tempDir, 'mismatched-manifest.json');
    const manifest = {
      tool: 'linmas',
      version: '0.3.0',
      manifestVersion: 1,
      host: 'codex',
      installedAt: '2026-07-14T00:00:00.000Z',
      skills: []
    };
    writeManifest(manifestPath, manifest);
    assert.throws(
      () => readManifest(manifestPath, 'claude'),
      /host mismatch.*claude.*codex|codex.*claude/i
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readManifest rejects malformed JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-manifest-'));
  try {
    const manifestPath = path.join(tempDir, 'bad-manifest.json');
    fs.writeFileSync(manifestPath, '{invalid json}', 'utf8');
    assert.throws(
      () => readManifest(manifestPath, 'claude'),
      /contains invalid JSON/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readManifest accepts manifest with matching host', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-manifest-'));
  try {
    const manifestPath = path.join(tempDir, 'valid-manifest.json');
    const manifest = {
      tool: 'linmas',
      version: '0.3.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-14T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: path.join(tempDir, 'secure-code-reviewer'), backupPath: null }]
    };
    writeManifest(manifestPath, manifest);
    const result = readManifest(manifestPath, 'claude');
    assert.equal(result.host, 'claude');
    assert.equal(result.skills.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test('formatDoctorReport identifies supported legacy and duplicate canonical installs without mutation', () => {
  const report = formatDoctorReport(
    [{ host: 'claude', status: 'detected', reason: 'ok', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', rootPath: '/tmp/.claude', writable: true }],
    [{ tool: 'linmas', version: '0.3.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-18T00:00:00.000Z', skills: [
      { name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null },
      { name: 'linmas-secure-code-reviewer', path: '/tmp/.claude/skills/linmas-secure-code-reviewer', backupPath: null }
    ] }],
    new Set(['/tmp/.claude/skills/secure-code-reviewer', '/tmp/.claude/skills/linmas-secure-code-reviewer'])
  );

  assert.match(report, /legacy installation/i);
  assert.match(report, /duplicate canonical and legacy installations/i);
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

test('validateManifest rejects manifest with no host', () => {
  assert.throws(
    () => validateManifest({ tool: 'linmas', manifestVersion: 1, skills: [] }, 'claude'),
    /Manifest host is required/
  );
});

test('validateManifest rejects manifest with wrong tool', () => {
  assert.throws(
    () => validateManifest({ tool: 'wrong', host: 'claude', manifestVersion: 1, skills: [] }, 'claude'),
    /Manifest tool must be "linmas"/
  );
});

test('validateManifest rejects manifest with invalid manifestVersion', () => {
  assert.throws(
    () => validateManifest({ tool: 'linmas', host: 'claude', manifestVersion: 'abc', skills: [] }, 'claude'),
    /Manifest manifestVersion must be 1/
  );
});

test('validateManifest rejects manifest with non-array skills', () => {
  assert.throws(
    () => validateManifest({ tool: 'linmas', host: 'claude', manifestVersion: 1, skills: 'invalid' }, 'claude'),
    /Manifest skills must be an array/
  );
});

test('preflightInstall rejects a missing manifest path before any write', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-preflight-'));
  try {
    const plan = [{
      host: 'missing-host',
      skill: { name: 'test', description: 'desc', sourceDir: tmp, skillFile: path.join(tmp, 'SKILL.md') },
      destinationDir: path.join(tmp, 'dest'),
      existingState: 'missing',
      backupDir: null,
      willWrite: true
    }];
    const manifests = new Map([['missing-host', { tool: 'linmas', host: 'missing-host', manifestVersion: 1, skills: [] }]]);
    assert.throws(
      () => preflightInstall(plan, manifests, new Map()),
      /No manifest path for host/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('preflightInstall rejects a missing manifest before any write', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-preflight-'));
  try {
    const sourceDir = path.join(tmp, 'source');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# test\n');
    const destinationDir = path.join(tmp, 'host', 'skills', 'test');
    const plan = [{
      host: 'claude',
      skill: { name: 'test', sourceDir, skillFile: path.join(sourceDir, 'SKILL.md') },
      destinationDir,
      backupDir: null
    }];
    assert.throws(
      () => applyInstallPlan(plan, new Map(), new Map([['claude', path.join(tmp, 'host', 'linmas-manifest.json')]])),
      /No manifest for host: claude/
    );
    assert.equal(fs.existsSync(destinationDir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyInstallPlan rolls back filesystem and manifests when second host copy fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-rollback-'));
  try {
    // Setup skill source
    const skillDir = path.join(tmp, 'repo', 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test\n');

    // First host (successful)
    const host1Root = path.join(tmp, 'host1');
    const host1Dest = path.join(host1Root, 'skills', 'test-skill');
    const host1ManifestPath = path.join(host1Root, 'linmas-manifest.json');
    fs.mkdirSync(path.join(host1Root, 'skills'), { recursive: true });

    // Second host fails through an injected copy implementation.
    const host2Root = path.join(tmp, 'host2');
    const host2Dest = path.join(host2Root, 'skills', 'test-skill');
    const host2ManifestPath = path.join(host2Root, 'linmas-manifest.json');
    fs.mkdirSync(path.join(host2Root, 'skills'), { recursive: true });

    const plan = [
      {
        host: 'host1',
        skill: { name: 'test-skill', description: 'desc', sourceDir: skillDir, skillFile: path.join(skillDir, 'SKILL.md') },
        destinationDir: host1Dest,
        existingState: 'missing',
        backupDir: null,
        willWrite: true
      },
      {
        host: 'host2',
        skill: { name: 'test-skill', description: 'desc', sourceDir: skillDir, skillFile: path.join(skillDir, 'SKILL.md') },
        destinationDir: host2Dest,
        existingState: 'managed',
        backupDir: path.join(host2Root, '.linmas-backups', 'test-skill'),
        willWrite: true
      }
    ];

    const manifests = new Map([
      ['host1', { tool: 'linmas', host: 'host1', manifestVersion: 1, skills: [] }],
      ['host2', { tool: 'linmas', host: 'host2', manifestVersion: 1, skills: [] }]
    ]);
    const manifestPathByHost = new Map([
      ['host1', host1ManifestPath],
      ['host2', host2ManifestPath]
    ]);

    let copyCalls = 0;
    assert.throws(() => applyInstallPlan(plan, manifests, manifestPathByHost, {
      copySkillDirectoryImpl(source, destination) {
        copyCalls += 1;
        if (copyCalls === 2) throw new Error('injected second-host copy failure');
        copySkillDirectory(source, destination);
      }
    }), /injected second-host copy failure/);

    assert.equal(fs.existsSync(host1Dest), false, 'host1 skill must be rolled back on failure');
    assert.equal(fs.existsSync(host2Dest), false, 'partial second-host destination must be removed');
    assert.deepEqual(manifests.get('host1').skills, [], 'host1 in-memory manifest must be restored');
    assert.deepEqual(manifests.get('host2').skills, [], 'host2 in-memory manifest must be restored');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyInstallPlan restores an existing destination and removes its operation backup on rollback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-rollback-existing-'));
  try {
    const sourceDir = path.join(tmp, 'source');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# new\n');
    const skillFile = path.join(sourceDir, 'SKILL.md');
    const host1Root = path.join(tmp, 'host1');
    const host1Dest = path.join(host1Root, 'skills', 'test');
    const host1Backup = path.join(host1Root, '.linmas-backups', 'test');
    fs.mkdirSync(host1Dest, { recursive: true });
    fs.writeFileSync(path.join(host1Dest, 'SKILL.md'), '# original\n');
    const host2Root = path.join(tmp, 'host2');
    const host2Dest = path.join(host2Root, 'skills', 'test');
    const plan = [
      { host: 'host1', skill: { name: 'test', sourceDir, skillFile }, destinationDir: host1Dest, backupDir: host1Backup },
      { host: 'host2', skill: { name: 'test', sourceDir, skillFile }, destinationDir: host2Dest, backupDir: null }
    ];
    const manifests = new Map([
      ['host1', { tool: 'linmas', host: 'host1', manifestVersion: 1, skills: [{ name: 'test', path: host1Dest, backupPath: null }] }],
      ['host2', { tool: 'linmas', host: 'host2', manifestVersion: 1, skills: [] }]
    ]);
    const paths = new Map([
      ['host1', path.join(host1Root, 'linmas-manifest.json')],
      ['host2', path.join(host2Root, 'linmas-manifest.json')]
    ]);
    let copyCalls = 0;
    assert.throws(() => applyInstallPlan(plan, manifests, paths, {
      copySkillDirectoryImpl(source, destination) {
        copyCalls += 1;
        if (copyCalls === 2) throw new Error('injected copy failure');
        copySkillDirectory(source, destination);
      }
    }), /injected copy failure/);
    assert.equal(fs.readFileSync(path.join(host1Dest, 'SKILL.md'), 'utf8'), '# original\n');
    assert.equal(fs.existsSync(host1Backup), false, 'operation backup must not remain after rollback');
    assert.equal(fs.existsSync(host2Dest), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyInstallPlan removes new manifests and destinations when a later manifest write fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-rollback-manifest-'));
  try {
    const sourceDir = path.join(tmp, 'source');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# test\n');
    const skillFile = path.join(sourceDir, 'SKILL.md');
    const roots = [path.join(tmp, 'host1'), path.join(tmp, 'host2')];
    const plan = roots.map((root, index) => ({
      host: `host${index + 1}`,
      skill: { name: 'test', sourceDir, skillFile },
      destinationDir: path.join(root, 'skills', 'test'),
      backupDir: null
    }));
    const manifests = new Map(plan.map((item) => [item.host, { tool: 'linmas', host: item.host, manifestVersion: 1, skills: [] }]));
    const paths = new Map(plan.map((item, index) => [item.host, path.join(roots[index], 'linmas-manifest.json')]));
    let writes = 0;
    assert.throws(() => applyInstallPlan(plan, manifests, paths, {
      writeManifestImpl(manifestPath, manifest) {
        writes += 1;
        writeManifest(manifestPath, manifest);
        if (writes === 2) throw new Error('injected manifest write failure');
      }
    }), /injected manifest write failure/);
    for (const item of plan) assert.equal(fs.existsSync(item.destinationDir), false);
    for (const manifestPath of paths.values()) assert.equal(fs.existsSync(manifestPath), false);
    for (const manifest of manifests.values()) assert.deepEqual(manifest.skills, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
