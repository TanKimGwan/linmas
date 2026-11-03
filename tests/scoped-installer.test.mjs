import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScopedManifest, readScopedManifest, validateScopedManifest } from '../src/core/manifest.mjs';
import {
  applyScopedInstallPlan,
  applyScopedUninstallPlan,
  formatScopedDoctorReport,
  formatScopedInstallPreview,
  planScopedInstall,
  planScopedUninstall
} from '../src/core/scoped-skills.mjs';
import { applyUninstallPlan, planUninstall } from '../src/core/uninstall-skills.mjs';
import { createHostRegistry } from '../src/hosts/registry.mjs';

const POSIX_SAFE_MUTATION = process.platform === 'win32'
  ? 'safe handle-relative mutation is unavailable on Windows'
  : false;

function fixture(scope = 'project') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-scoped-install-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const sourceDir = path.join(base, 'source', 'linmas-secure-code-reviewer');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# test skill\n');
  const scopeRoot = scope === 'project' ? project : home;
  const registry = createHostRegistry({ homedir: home, env: {} });
  const targets = new Map([...registry].map(([host, adapter]) => [host, adapter.resolveTarget({ scope, projectRoot: project })]));
  return {
    base, home, project, scope, scopeRoot, targets,
    skill: { name: 'linmas-secure-code-reviewer', sourceDir },
    manifest: createScopedManifest(scope)
  };
}

function installPlan(data, agents = ['claude', 'codex'], method = 'symlink') {
  return planScopedInstall({
    skills: [data.skill], agents, targets: data.targets, scope: data.scope,
    scopeRoot: data.scopeRoot, manifest: data.manifest, method
  });
}

function validScopedManifest() {
  const id = 'linmas-secure-code-reviewer';
  const sha256 = 'a'.repeat(64);
  return {
    ...createScopedManifest('project'),
    skills: [{
      id,
      canonical: { root: 'agents', path: `skills/${id}`, sourceVersion: '0.9.2', sha256 },
      attachments: [
        { host: 'claude', root: 'claude', path: `skills/${id}`, method: 'symlink', sourceVersion: '0.9.2', sha256 },
        { host: 'codex', root: 'agents', path: `skills/${id}`, method: 'direct', sourceVersion: '0.9.2', sha256 }
      ]
    }]
  };
}

test('scoped manifest rejects unsafe paths, invalid digests, duplicate attachments, and malformed backup metadata', () => {
  const backupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const validBackup = {
    id: backupId, skillId: 'linmas-secure-code-reviewer', host: 'codex', root: 'agents',
    originalPath: 'skills/linmas-secure-code-reviewer', backupPath: `.linmas-backups/${backupId}`,
    state: 'unmanaged', entryKind: 'directory', sha256: 'b'.repeat(64), createdAt: '2026-11-03T00:00:00.000Z'
  };
  const cases = [
    [(manifest) => { manifest.skills[0] = null; }, /Manifest skill entry is invalid/],
    [(manifest) => { manifest.skills[0].canonical = null; manifest.skills[0].attachments = []; }, /Manifest skill entry is invalid/],
    [(manifest) => { manifest.skills.push(structuredClone(manifest.skills[0])); }, /duplicate skill/],
    [(manifest) => { manifest.skills[0].canonical.path = 'skills/../escape'; }, /canonical path is invalid/],
    [(manifest) => { manifest.skills[0].canonical.sha256 = 'not-a-digest'; }, /canonical path is invalid/],
    [(manifest) => { manifest.skills[0].attachments[0].path = 'skills/../escape'; }, /Manifest attachment is invalid/],
    [(manifest) => { manifest.skills[0].attachments[0].sha256 = 'not-a-digest'; }, /Manifest attachment is invalid/],
    [(manifest) => { manifest.skills[0].attachments[0].method = 'direct'; }, /Manifest attachment method is invalid/],
    [(manifest) => { manifest.skills[0].attachments.push({ ...manifest.skills[0].attachments[0] }); }, /duplicate attachment/],
    [(manifest) => { manifest.skills[0].retainedReason = 'unrecognized'; }, /retained reason is invalid/],
    [(manifest) => { manifest.backups = [{ ...validBackup, sha256: 'not-a-digest' }]; }, /Manifest backup entry is invalid/],
    [(manifest) => { manifest.backups = [validBackup, { ...validBackup }]; }, /Manifest backup entry is invalid/],
    [(manifest) => { manifest.backups = [{ ...validBackup, targetRoot: '/unexpected' }]; }, /backup root binding is unexpected/]
  ];

  for (const [mutate, expected] of cases) {
    const manifest = structuredClone(validScopedManifest());
    mutate(manifest);
    assert.throws(() => validateScopedManifest(manifest, 'project'), expected);
  }

  const globalBackupManifest = {
    ...createScopedManifest('global'),
    backups: [{ ...validBackup, host: 'claude', root: 'claude', targetRoot: 'relative-root' }]
  };
  assert.throws(() => validateScopedManifest(globalBackupManifest, 'global'), /Claude backup root binding is invalid/);

  const id = 'linmas-secure-code-reviewer';
  const globalAttachmentManifest = {
    ...createScopedManifest('global'),
    skills: [{
      id, canonical: null,
      attachments: [{ host: 'claude', root: 'claude', path: `skills/${id}`, method: 'copy', sourceVersion: '0.9.2', sha256: 'a'.repeat(64) }]
    }]
  };
  assert.throws(() => validateScopedManifest(globalAttachmentManifest, 'global'), /Claude root binding is invalid/);
});

test('scoped manifest reader rejects malformed JSON', () => {
  const data = fixture();
  const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{invalid json\n');
    assert.throws(() => readScopedManifest(manifestPath, 'project'), /contains invalid JSON/);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('scoped install preview names preserved hosts affected by a shared canonical update', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data)).status, 'COMMITTED');
    fs.writeFileSync(path.join(data.skill.sourceDir, 'SKILL.md'), '# updated source\n');
    const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const update = planScopedInstall({
      skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project',
      scopeRoot: data.project, manifest, method: 'symlink'
    });

    assert.deepEqual(update.affected, [{ skill: data.skill.name, hosts: ['codex'] }]);
    assert.match(formatScopedInstallPreview(update), /shared canonical update also affects: codex/);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('global Claude reinstall refuses a different configuration root bound in the manifest', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture('global');
  const alternateRoot = path.join(data.base, 'alternate-claude');
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const manifestPath = path.join(data.home, '.agents', 'linmas-manifest.json');
    const manifest = readScopedManifest(manifestPath, 'global');
    const registry = createHostRegistry({ homedir: data.home, env: { CLAUDE_CONFIG_DIR: alternateRoot } });
    const changedTargets = new Map([...registry].map(([host, adapter]) => [
      host, adapter.resolveTarget({ scope: 'global', projectRoot: data.project })
    ]));

    assert.throws(() => planScopedInstall({
      skills: [data.skill], agents: ['claude'], targets: changedTargets, scope: 'global',
      scopeRoot: data.home, manifest, method: 'copy'
    }), /restore CLAUDE_CONFIG_DIR before installing/);
    assert.equal(fs.existsSync(alternateRoot), false);
    assert.equal(fs.existsSync(path.join(data.home, '.claude', 'skills', data.skill.name)), true);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('project symlink install shares one durable payload and identical reinstall is a no-op', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    const plan = installPlan(data);
    assert.equal(plan.nextManifest.skills[0].canonical.path, 'skills/linmas-secure-code-reviewer');
    assert.deepEqual(plan.nextManifest.skills[0].attachments.map((entry) => [entry.host, entry.method]), [['claude', 'symlink'], ['codex', 'direct']]);
    assert.equal(fs.existsSync(path.join(data.project, '.agents')), false);
    assert.equal(applyScopedInstallPlan(plan).status, 'COMMITTED');

    const canonical = path.join(data.project, '.agents', 'skills', data.skill.name);
    const claude = path.join(data.project, '.claude', 'skills', data.skill.name);
    assert.equal(fs.lstatSync(canonical).isDirectory(), true);
    assert.equal(fs.lstatSync(claude).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(claude), fs.readlinkSync(claude)), canonical);
    assert.equal(fs.readFileSync(path.join(canonical, 'SKILL.md'), 'utf8'), '# test skill\n');

    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifest = readScopedManifest(manifestPath, 'project');
    const next = planScopedInstall({ skills: [data.skill], agents: ['claude', 'codex'], targets: data.targets, scope: 'project', scopeRoot: data.project, manifest, method: 'symlink' });
    assert.equal(next.noOp, true);
    assert.equal(applyScopedInstallPlan(next).status, 'NO_OP');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('project symlink state remains managed and removable after moving the project root', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const movedProject = path.join(data.base, 'moved-project');
  const sentinel = path.join(data.project, 'local-sentinel.txt');
  fs.writeFileSync(sentinel, 'project data survives relocation\n');
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data)).status, 'COMMITTED');
    fs.renameSync(data.project, movedProject);

    const registry = createHostRegistry({ homedir: data.home, env: {} });
    const movedTargets = new Map([...registry].map(([host, adapter]) => [
      host, adapter.resolveTarget({ scope: 'project', projectRoot: movedProject })
    ]));
    const canonical = path.join(movedProject, '.agents', 'skills', data.skill.name);
    const claudeLink = path.join(movedProject, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(movedProject, '.agents', 'linmas-manifest.json');
    assert.equal(path.resolve(path.dirname(claudeLink), fs.readlinkSync(claudeLink)), canonical);
    assert.equal(fs.readFileSync(path.join(claudeLink, 'SKILL.md'), 'utf8'), '# test skill\n');

    const manifest = readScopedManifest(manifestPath, 'project');
    const report = formatScopedDoctorReport({ manifest, targets: movedTargets, scope: 'project', scopeRoot: movedProject });
    assert.match(report, /claude: managed \(symlink\)/);
    assert.match(report, /codex: managed \(direct\)/);

    const uninstall = planScopedUninstall({
      manifest, targets: movedTargets, scope: 'project', scopeRoot: movedProject,
      skillNames: [data.skill.name], agents: ['claude', 'codex']
    });
    assert.equal(applyScopedUninstallPlan(uninstall).status, 'COMMITTED');
    assert.equal(fs.existsSync(canonical), false);
    assert.equal(fs.existsSync(claudeLink), false);
    assert.equal(fs.readFileSync(path.join(movedProject, 'local-sentinel.txt'), 'utf8'), 'project data survives relocation\n');
    assert.equal(fs.existsSync(path.join(data.home, '.agents')), false);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('staged legacy migration archives local edits and extra files before v1 uninstall', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const legacyRoot = path.join(data.home, '.claude');
  const legacyInstallRoot = path.join(legacyRoot, 'skills');
  const legacySkillPath = path.join(legacyInstallRoot, data.skill.name);
  const legacyManifestPath = path.join(legacyRoot, 'linmas-manifest.json');
  const archivePath = path.join(data.base, 'legacy-backup.tar');
  const restoredBackup = path.join(data.base, 'verified-backup');
  try {
    fs.mkdirSync(legacySkillPath, { recursive: true });
    fs.writeFileSync(path.join(legacySkillPath, 'SKILL.md'), '# locally edited legacy skill\n');
    fs.writeFileSync(path.join(legacySkillPath, 'local-only.txt'), 'legacy-only data\n');
    const legacyManifest = {
      tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: data.skill.name, path: legacySkillPath, backupPath: null }]
    };
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    const legacyBytes = fs.readFileSync(legacyManifestPath, 'utf8');

    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const scopedPath = path.join(data.project, '.claude', 'skills', data.skill.name);
    assert.equal(fs.readFileSync(path.join(scopedPath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.readFileSync(legacyManifestPath, 'utf8'), legacyBytes);
    assert.equal(fs.readFileSync(path.join(legacySkillPath, 'SKILL.md'), 'utf8'), '# locally edited legacy skill\n');
    assert.equal(fs.readFileSync(path.join(legacySkillPath, 'local-only.txt'), 'utf8'), 'legacy-only data\n');
    assert.match(formatScopedDoctorReport({
      manifest: readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project'),
      targets: data.targets, scope: 'project', scopeRoot: data.project
    }), /claude: managed \(copy\)/);

    const legacyTargets = [{ host: 'claude', status: 'detected', installRoot: legacyInstallRoot }];
    const legacyPlan = planUninstall({ manifests: [legacyManifest], detections: legacyTargets, skillName: data.skill.name, uninstallAll: false });
    execFileSync('tar', ['-cpf', archivePath, '-C', legacyRoot, `skills/${data.skill.name}`, 'linmas-manifest.json']);
    const archivedEntries = execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(archivedEntries.includes(`skills/${data.skill.name}/SKILL.md`));
    assert.ok(archivedEntries.includes(`skills/${data.skill.name}/local-only.txt`));
    assert.ok(archivedEntries.includes('linmas-manifest.json'));
    fs.mkdirSync(restoredBackup);
    execFileSync('tar', ['-xpf', archivePath, '-C', restoredBackup]);
    const verifiedSkillPath = path.join(restoredBackup, 'skills', data.skill.name);
    assert.equal(fs.readFileSync(path.join(verifiedSkillPath, 'SKILL.md'), 'utf8'), '# locally edited legacy skill\n');
    assert.equal(fs.readFileSync(path.join(verifiedSkillPath, 'local-only.txt'), 'utf8'), 'legacy-only data\n');
    assert.equal(fs.readFileSync(path.join(restoredBackup, 'linmas-manifest.json'), 'utf8'), legacyBytes);

    const removed = applyUninstallPlan(
      legacyPlan,
      new Map([['claude', legacyManifest]]),
      new Map([['claude', legacyManifestPath]])
    );
    assert.deepEqual(removed.removed, [legacySkillPath]);
    assert.equal(fs.existsSync(legacySkillPath), false);
    assert.equal(fs.readFileSync(path.join(verifiedSkillPath, 'SKILL.md'), 'utf8'), '# locally edited legacy skill\n');
    assert.equal(fs.readFileSync(path.join(verifiedSkillPath, 'local-only.txt'), 'utf8'), 'legacy-only data\n');
    assert.equal(fs.readFileSync(path.join(restoredBackup, 'linmas-manifest.json'), 'utf8'), legacyBytes);
    assert.equal(fs.readFileSync(path.join(scopedPath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.existsSync(path.join(scopedPath, 'local-only.txt')), false);
    assert.equal(readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project').skills.length, 1);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('Claude-only copy does not create a shared payload', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    const plan = installPlan(data, ['claude'], 'copy');
    assert.equal(plan.nextManifest.skills[0].canonical, null);
    assert.equal(applyScopedInstallPlan(plan).status, 'COMMITTED');
    assert.equal(fs.lstatSync(path.join(data.project, '.claude', 'skills', data.skill.name)).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(data.project, '.agents', 'skills', data.skill.name)), false);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('copy-mode Claude uninstall preserves the Codex canonical copy', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude', 'codex'], 'copy'));
    const codexPath = path.join(data.project, '.agents', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifest = readScopedManifest(manifestPath, 'project');
    const uninstall = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude'] });

    assert.deepEqual(manifest.skills[0].attachments.map(({ host, method }) => [host, method]), [['claude', 'copy'], ['codex', 'direct']]);
    assert.equal(applyScopedUninstallPlan(uninstall).status, 'COMMITTED');
    assert.equal(fs.readFileSync(path.join(codexPath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.deepEqual(readScopedManifest(manifestPath, 'project').skills[0].attachments.map(({ host }) => host), ['codex']);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('Claude-only copy reinstall preserves the unselected Codex payload', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude', 'codex'], 'copy'));
    const codexPath = path.join(data.project, '.agents', 'skills', data.skill.name);
    fs.writeFileSync(path.join(data.skill.sourceDir, 'SKILL.md'), '# update\n');
    const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const reinstall = planScopedInstall({ skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project', scopeRoot: data.project, manifest, method: 'copy' });

    assert.equal(applyScopedInstallPlan(reinstall).status, 'COMMITTED');
    assert.equal(fs.readFileSync(path.join(codexPath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.readFileSync(path.join(data.project, '.claude', 'skills', data.skill.name, 'SKILL.md'), 'utf8'), '# update\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('copy-mode Codex uninstall leaves its independent Claude copy', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude', 'codex'], 'copy'));
    const claudePath = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifest = readScopedManifest(manifestPath, 'project');
    const uninstall = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['codex'] });

    assert.equal(applyScopedUninstallPlan(uninstall).status, 'COMMITTED');
    assert.equal(fs.existsSync(path.join(data.project, '.agents', 'skills', data.skill.name)), false);
    assert.equal(fs.readFileSync(path.join(claudePath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.deepEqual(readScopedManifest(manifestPath, 'project').skills[0].attachments.map(({ host }) => host), ['claude']);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('modified managed content needs separate approval and is backed up before replacement', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'copy'));
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    fs.writeFileSync(path.join(destination, 'SKILL.md'), '# local edit\n');
    const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const plan = planScopedInstall({ skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project', scopeRoot: data.project, manifest, method: 'symlink' });
    assert.equal(plan.conflicts[0].kind, 'modified');
    assert.throws(() => applyScopedInstallPlan(plan), /modified managed content requires separate approval/i);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# local edit\n');
    const result = applyScopedInstallPlan(plan, { allowReplaceModified: true });
    assert.equal(result.status, 'COMMITTED');
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(destination), fs.readlinkSync(destination)), path.join(data.project, '.agents', 'skills', data.skill.name));
    const updatedManifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const backup = updatedManifest.backups.at(-1);
    const backupPath = path.join(data.project, '.agents', backup.backupPath);
    assert.equal(backup.state, 'modified');
    assert.equal(fs.readFileSync(path.join(backupPath, 'SKILL.md'), 'utf8'), '# local edit\n');
    assert.ok(formatScopedInstallPreview(plan).includes(backupPath));
    assert.deepEqual(fs.readdirSync(path.dirname(destination)).filter((name) => name.includes('.linmas-rollback.')), []);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('approved replacement creates the backup parent and preserves unmanaged files and links', { skip: POSIX_SAFE_MUTATION }, () => {
  for (const kind of ['file', 'symlink']) {
    const data = fixture();
    const installRoot = path.join(data.project, '.claude', 'skills');
    const destination = path.join(installRoot, data.skill.name);
    const external = path.join(data.base, 'foreign-payload');
    try {
      fs.mkdirSync(installRoot, { recursive: true });
      if (kind === 'file') fs.writeFileSync(destination, 'foreign file\n');
      else {
        fs.mkdirSync(external);
        fs.writeFileSync(path.join(external, 'marker'), 'outside\n');
        fs.symlinkSync(external, destination, 'dir');
      }
      const plan = installPlan(data, ['claude'], 'copy');
      assert.equal(plan.conflicts[0].kind, 'unmanaged');
      assert.equal(applyScopedInstallPlan(plan, { allowReplaceUnmanaged: true }).status, 'COMMITTED');
      const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
      const backup = manifest.backups.at(-1);
      const backupPath = path.join(data.project, '.agents', backup.backupPath);
      if (kind === 'file') {
        assert.equal(backup.entryKind, 'file');
        assert.equal(fs.readFileSync(backupPath, 'utf8'), 'foreign file\n');
      } else {
        assert.equal(backup.entryKind, 'symlink');
        assert.equal(fs.lstatSync(backupPath).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(backupPath), external);
        assert.equal(fs.readFileSync(path.join(external, 'marker'), 'utf8'), 'outside\n');
      }
    } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
  }
});

test('approved method change backs up a modified obsolete canonical payload', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'symlink'));
    const claudePath = path.join(data.project, '.claude', 'skills', data.skill.name);
    const canonicalPath = path.join(data.project, '.agents', 'skills', data.skill.name);
    fs.unlinkSync(claudePath);
    fs.writeFileSync(path.join(canonicalPath, 'SKILL.md'), '# local canonical edit\n');
    const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const plan = planScopedInstall({ skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project', scopeRoot: data.project, manifest, method: 'copy' });
    const obsolete = plan.operations.find((entry) => entry.kind === 'remove' && entry.absolutePath === canonicalPath);
    assert.equal(obsolete.state, 'modified');
    assert.ok(obsolete.backupAbsolutePath);

    assert.equal(applyScopedInstallPlan(plan, { allowReplaceModified: true }).status, 'COMMITTED');
    assert.equal(fs.readFileSync(path.join(claudePath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.existsSync(canonicalPath), false);
    assert.equal(fs.readFileSync(path.join(obsolete.backupAbsolutePath, 'SKILL.md'), 'utf8'), '# local canonical edit\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('approved directory backup preserves nested relative, absolute, and dangling symlinks', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
  const external = path.join(data.base, 'external-marker');
  try {
    fs.mkdirSync(destination, { recursive: true });
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(destination, 'original.txt'), 'inside\n');
    fs.writeFileSync(path.join(external, 'marker.txt'), 'outside\n');
    fs.symlinkSync('original.txt', path.join(destination, 'relative-link'));
    fs.symlinkSync(path.join(external, 'marker.txt'), path.join(destination, 'absolute-link'));
    fs.symlinkSync('missing-target.txt', path.join(destination, 'dangling-link'));

    const plan = installPlan(data, ['claude'], 'copy');
    const backupReference = plan.operations.find((entry) => entry.absolutePath === destination).backupReference;
    const backupPath = path.join(data.project, '.agents', backupReference.backupPath);
    assert.equal(applyScopedInstallPlan(plan, { allowReplaceUnmanaged: true }).status, 'COMMITTED');
    assert.equal(fs.readlinkSync(path.join(backupPath, 'relative-link')), 'original.txt');
    assert.equal(fs.readlinkSync(path.join(backupPath, 'absolute-link')), path.join(external, 'marker.txt'));
    assert.equal(fs.readlinkSync(path.join(backupPath, 'dangling-link')), 'missing-target.txt');
    assert.equal(fs.readFileSync(path.join(external, 'marker.txt'), 'utf8'), 'outside\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('managed content edited after preview is preserved by install and uninstall', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'copy'));
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');

    fs.writeFileSync(path.join(data.skill.sourceDir, 'SKILL.md'), '# updated source\n');
    let manifest = readScopedManifest(manifestPath, 'project');
    const install = planScopedInstall({ skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project', scopeRoot: data.project, manifest, method: 'copy' });
    fs.writeFileSync(path.join(destination, 'SKILL.md'), '# edit after preview\n');
    assert.throws(() => applyScopedInstallPlan(install), /managed content changed after preview/i);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# edit after preview\n');

    fs.writeFileSync(path.join(destination, 'SKILL.md'), '# test skill\n');
    manifest = readScopedManifest(manifestPath, 'project');
    const uninstall = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude'] });
    fs.writeFileSync(path.join(destination, 'SKILL.md'), '# edit before uninstall\n');
    assert.throws(() => applyScopedUninstallPlan(uninstall), /target content changed after preview/i);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# edit before uninstall\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('uninstalling Claude leaves Codex payload; final Codex removal deletes it', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data));
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const claudePath = path.join(data.project, '.claude', 'skills', data.skill.name);
    const codexPath = path.join(data.project, '.agents', 'skills', data.skill.name);
    let manifest = readScopedManifest(manifestPath, 'project');
    let plan = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude'] });
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.nextManifest.skills[0].attachments.map((entry) => entry.host), ['codex']);
    assert.equal(applyScopedUninstallPlan(plan).status, 'COMMITTED');
    assert.equal(fs.existsSync(claudePath), false);
    assert.equal(fs.existsSync(codexPath), true);
    assert.match(formatScopedDoctorReport({ manifest: readScopedManifest(manifestPath, 'project'), targets: data.targets, scope: 'project', scopeRoot: data.project }), /codex: managed/);

    manifest = readScopedManifest(manifestPath, 'project');
    plan = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['codex'] });
    assert.equal(applyScopedUninstallPlan(plan).status, 'COMMITTED');
    assert.equal(fs.existsSync(codexPath), false);
    assert.deepEqual(readScopedManifest(manifestPath, 'project').skills, []);
    assert.deepEqual(fs.readdirSync(path.dirname(codexPath)).filter((name) => name.includes('.linmas-rollback.')), []);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('one uninstall transaction removes both host symlinks and canonical payload', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data));
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const claudePath = path.join(data.project, '.claude', 'skills', data.skill.name);
    const canonicalPath = path.join(data.project, '.agents', 'skills', data.skill.name);
    const plan = planScopedUninstall({
      manifest: readScopedManifest(manifestPath, 'project'), targets: data.targets, scope: 'project',
      scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude', 'codex']
    });

    assert.equal(applyScopedUninstallPlan(plan).status, 'COMMITTED');
    assert.equal(fs.existsSync(claudePath), false);
    assert.equal(fs.existsSync(canonicalPath), false);
    assert.deepEqual(readScopedManifest(manifestPath, 'project').skills, []);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('symlink-to-copy method change ignores only its own transaction rollback link', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'symlink'));
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const plan = planScopedInstall({
      skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project',
      scopeRoot: data.project, manifest: readScopedManifest(manifestPath, 'project'), method: 'copy'
    });

    assert.equal(applyScopedInstallPlan(plan).status, 'COMMITTED');
    assert.equal(fs.lstatSync(path.join(data.project, '.claude', 'skills', data.skill.name)).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(data.project, '.agents', 'skills', data.skill.name)), false);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('last Codex removal retains canonical payload referenced by an unmanaged Claude link', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['codex'], 'copy'));
    const canonical = path.join(data.project, '.agents', 'skills', data.skill.name);
    const foreignRoot = path.join(data.project, '.claude', 'skills');
    const foreignLink = path.join(foreignRoot, 'external-alias');
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.symlinkSync(path.relative(foreignRoot, canonical), foreignLink, 'dir');

    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifest = readScopedManifest(manifestPath, 'project');
    const uninstall = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['codex'] });
    assert.equal(uninstall.operations.some((entry) => entry.absolutePath === canonical), false);
    assert.equal(applyScopedUninstallPlan(uninstall).status, 'COMMITTED');
    const retained = readScopedManifest(manifestPath, 'project').skills[0];
    assert.deepEqual(retained.attachments, []);
    assert.equal(retained.retainedReason, 'foreign-reference');
    assert.equal(fs.readFileSync(path.join(canonical, 'SKILL.md'), 'utf8'), '# test skill\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('last canonical removal rechecks foreign links created after preview', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['codex'], 'copy'));
    const canonical = path.join(data.project, '.agents', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const manifest = readScopedManifest(manifestPath, 'project');
    const uninstall = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['codex'] });
    const foreignRoot = path.join(data.project, '.claude', 'skills');
    const foreignLink = path.join(foreignRoot, 'external-alias');
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.symlinkSync(path.relative(foreignRoot, canonical), foreignLink, 'dir');

    assert.throws(() => applyScopedUninstallPlan(uninstall), /acquired a reference after preview/i);
    assert.equal(fs.readFileSync(path.join(canonical, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.existsSync(foreignLink), true);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('global Claude uninstall refuses to follow a changed CLAUDE_CONFIG_DIR', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture('global');
  const foreignRoot = path.join(data.base, 'other-claude');
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'copy'));
    const original = path.join(data.home, '.claude', 'skills', data.skill.name);
    fs.mkdirSync(path.join(foreignRoot, 'skills'), { recursive: true });
    fs.cpSync(original, path.join(foreignRoot, 'skills', data.skill.name), { recursive: true });
    const changedRegistry = createHostRegistry({ homedir: data.home, env: { CLAUDE_CONFIG_DIR: foreignRoot } });
    const changedTargets = new Map([...changedRegistry].map(([host, adapter]) => [host, adapter.resolveTarget({ scope: 'global', projectRoot: data.project })]));
    const manifestPath = path.join(data.home, '.agents', 'linmas-manifest.json');
    const manifest = readScopedManifest(manifestPath, 'global');
    const uninstall = planScopedUninstall({ manifest, targets: changedTargets, scope: 'global', scopeRoot: data.home, skillNames: [data.skill.name], agents: ['claude'] });

    assert.equal(uninstall.operations.length, 0);
    assert.match(uninstall.skipped[0].reason, /configuration root mismatch/);
    assert.equal(applyScopedUninstallPlan(uninstall).status, 'NO_OP');
    assert.equal(fs.existsSync(path.join(foreignRoot, 'skills', data.skill.name)), true);
    assert.equal(fs.existsSync(original), true);
    const doctor = formatScopedDoctorReport({ manifest, targets: changedTargets, scope: 'global', scopeRoot: data.home });
    assert.match(doctor, /configuration root mismatch/);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('doctor reports a Claude link as broken when its canonical directory is missing', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'symlink'));
    const canonical = path.join(data.project, '.agents', 'skills', data.skill.name);
    fs.renameSync(canonical, path.join(data.base, 'canonical-displaced'));
    const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const doctor = formatScopedDoctorReport({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project });
    assert.match(doctor, /canonical: missing/);
    assert.match(doctor, /claude: broken-link/);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('uninstall preserves user-edited copies and reports them as modified', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'copy'));
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    fs.writeFileSync(path.join(destination, 'SKILL.md'), '# local edit\n');
    const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const plan = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude'] });
    assert.equal(plan.skipped[0].reason, 'modified');
    assert.equal(applyScopedUninstallPlan(plan).status, 'NO_OP');
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# local edit\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('manifest write failure restores installation paths and keeps the manifest absent', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    assert.throws(() => applyScopedInstallPlan(installPlan(data), { writeManifest(anchor, name, contents) {
      fs.writeFileSync(path.join(anchor.parentPath, name), contents);
      throw new Error('injected manifest failure');
    } }), /injected manifest failure/);
    assert.equal(fs.existsSync(path.join(data.project, '.agents', 'skills', data.skill.name)), false);
    assert.equal(fs.existsSync(path.join(data.project, '.claude', 'skills', data.skill.name)), false);
    assert.equal(fs.existsSync(path.join(data.project, '.agents', 'linmas-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(data.project, '.agents', '.linmas-install.lock')), false);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('install preserves externally changed manifest bytes while restoring the old payload', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const foreignManifest = 'externally owned manifest bytes\n';
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    fs.writeFileSync(path.join(data.skill.sourceDir, 'SKILL.md'), '# updated source\n');
    const update = planScopedInstall({
      skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project',
      scopeRoot: data.project, manifest: readScopedManifest(manifestPath, 'project'), method: 'copy'
    });

    let caught;
    try {
      applyScopedInstallPlan(update, { writeManifest() {
        fs.writeFileSync(manifestPath, foreignManifest);
        throw new Error('injected external manifest replacement');
      } });
    } catch (error) { caught = error; }

    assert.match(caught.message, /injected external manifest replacement/);
    assert.match(caught.rollbackErrors?.map((error) => error.message).join('\n') ?? '', /manifest changed during rollback/);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), foreignManifest);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# test skill\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('post-write install failure restores prior files and reports lock cleanup failure', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    fs.writeFileSync(path.join(data.skill.sourceDir, 'SKILL.md'), '# updated source\n');
    const update = planScopedInstall({
      skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project',
      scopeRoot: data.project, manifest: readScopedManifest(manifestPath, 'project'), method: 'copy'
    });
    const originalRenameSync = fs.renameSync;
    let lockCleanupInjected = false;
    fs.renameSync = (from, to) => {
      if (path.basename(from) === '.linmas-install.lock') {
        lockCleanupInjected = true;
        throw new Error('injected lock cleanup failure');
      }
      return originalRenameSync(from, to);
    };

    let caught;
    try {
      applyScopedInstallPlan(update, { writeManifest(anchor, name, contents) {
        fs.writeFileSync(path.join(anchor.parentPath, name), contents);
        throw new Error('injected post-write manifest failure');
      } });
    } catch (error) { caught = error; }
    finally { fs.renameSync = originalRenameSync; }

    assert.match(caught.message, /injected post-write manifest failure/);
    assert.equal(lockCleanupInjected, true);
    assert.match(caught.cleanupErrors?.[0]?.message ?? '', /injected lock cleanup failure/);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(path.join(data.project, '.agents', '.linmas-install.lock')), true);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('install reports lock cleanup failure after committing managed files', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
  const lockPath = path.join(data.project, '.agents', '.linmas-install.lock');
  const originalRenameSync = fs.renameSync;
  let lockCleanupInjected = false;
  try {
    fs.renameSync = (from, to) => {
      if (path.basename(from) === '.linmas-install.lock') {
        lockCleanupInjected = true;
        throw new Error('injected lock cleanup failure');
      }
      return originalRenameSync(from, to);
    };
    const result = applyScopedInstallPlan(installPlan(data, ['claude'], 'copy'));
    fs.renameSync = originalRenameSync;

    assert.equal(lockCleanupInjected, true);
    assert.equal(result.status, 'COMMITTED_WITH_CLEANUP_WARNING');
    assert.match(result.cleanupWarnings[0].message, /injected lock cleanup failure/);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(data.base, { recursive: true, force: true });
  }
});

test('rollback collision preserves foreign destination and reports original recovery path', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'copy'));
    fs.writeFileSync(path.join(data.skill.sourceDir, 'SKILL.md'), '# updated source\n');
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const plan = planScopedInstall({ skills: [data.skill], agents: ['claude'], targets: data.targets, scope: 'project', scopeRoot: data.project, manifest: readScopedManifest(manifestPath, 'project'), method: 'copy' });
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const foreign = path.join(data.base, 'foreign-after-failure');
    let caught;
    try {
      applyScopedInstallPlan(plan, {
        writeManifest() {
          fs.renameSync(destination, foreign);
          fs.mkdirSync(destination);
          fs.writeFileSync(path.join(destination, 'SKILL.md'), '# foreign replacement\n');
          throw new Error('injected manifest failure');
        }
      });
    } catch (error) { caught = error; }
    assert.match(caught.message, /injected manifest failure/);
    assert.ok(caught.rollbackErrors?.length);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# foreign replacement\n');
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore);
    const recoveryPath = caught.rollbackErrors.find((error) => error.recoveryPath)?.recoveryPath;
    assert.ok(recoveryPath);
    assert.equal(fs.readFileSync(path.join(recoveryPath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.ok(caught.recoveryPaths.includes(recoveryPath));
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('uninstall rollback failure reports the retained recovery path without losing the skill', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const uninstall = planScopedUninstall({
      manifest: readScopedManifest(manifestPath, 'project'), targets: data.targets, scope: 'project',
      scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude']
    });
    const originalRenameSync = fs.renameSync;
    let moveInjected = false;
    let restoreInjected = false;
    fs.renameSync = (from, to) => {
      const fromName = path.basename(from);
      const toName = path.basename(to);
      if (toName === path.basename(destination) && fromName.includes('.linmas-rollback.')) {
        restoreInjected = true;
        throw new Error('injected uninstall rollback failure');
      }
      const result = originalRenameSync(from, to);
      if (!moveInjected && fromName === path.basename(destination) && toName.includes('.linmas-rollback.')) {
        moveInjected = true;
        throw new Error('injected failure after uninstall move');
      }
      return result;
    };

    let caught;
    try { applyScopedUninstallPlan(uninstall); }
    catch (error) { caught = error; }
    finally { fs.renameSync = originalRenameSync; }

    assert.match(caught.message, /injected failure after uninstall move/);
    assert.equal(moveInjected, true);
    assert.equal(restoreInjected, true);
    assert.ok(caught.rollbackErrors?.length);
    const recoveryPath = caught.recoveryPaths?.find((entry) => entry.includes('.linmas-rollback.'));
    assert.ok(recoveryPath);
    assert.equal(fs.readFileSync(path.join(recoveryPath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('post-write uninstall failure restores the managed entry and original manifest', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const uninstall = planScopedUninstall({
      manifest: readScopedManifest(manifestPath, 'project'), targets: data.targets, scope: 'project',
      scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude']
    });

    assert.throws(() => applyScopedUninstallPlan(uninstall, { writeManifest(anchor, name, contents) {
      fs.writeFileSync(path.join(anchor.parentPath, name), contents);
      throw new Error('injected post-write uninstall manifest failure');
    } }), /injected post-write uninstall manifest failure/);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('uninstall preserves externally changed manifest bytes and restores removed content', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const foreignManifest = 'externally owned manifest bytes\n';
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const uninstall = planScopedUninstall({
      manifest: readScopedManifest(manifestPath, 'project'), targets: data.targets, scope: 'project',
      scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude']
    });

    let caught;
    try {
      applyScopedUninstallPlan(uninstall, { writeManifest() {
        fs.writeFileSync(manifestPath, foreignManifest);
        throw new Error('injected external manifest replacement');
      } });
    } catch (error) { caught = error; }

    assert.match(caught.message, /injected external manifest replacement/);
    assert.match(caught.rollbackErrors?.map((error) => error.message).join('\n') ?? '', /manifest changed during rollback/);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), foreignManifest);
    assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# test skill\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('uninstall reports committed status when rollback cleanup fails and preserves the recovery copy', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  try {
    assert.equal(applyScopedInstallPlan(installPlan(data, ['claude'], 'copy')).status, 'COMMITTED');
    const destination = path.join(data.project, '.claude', 'skills', data.skill.name);
    const manifestPath = path.join(data.project, '.agents', 'linmas-manifest.json');
    const uninstall = planScopedUninstall({
      manifest: readScopedManifest(manifestPath, 'project'), targets: data.targets, scope: 'project',
      scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude']
    });
    const originalRmSync = fs.rmSync;
    const originalRenameSync = fs.renameSync;
    let cleanupInjected = false;
    let lockCleanupInjected = false;
    fs.rmSync = (target, ...args) => {
      if (!cleanupInjected && path.basename(target).startsWith('.linmas-remove.')) {
        cleanupInjected = true;
        throw new Error('injected rollback cleanup failure');
      }
      return originalRmSync(target, ...args);
    };
    fs.renameSync = (from, to) => {
      if (path.basename(from) === '.linmas-install.lock') {
        lockCleanupInjected = true;
        throw new Error('injected lock cleanup failure');
      }
      return originalRenameSync(from, to);
    };

    let result;
    try { result = applyScopedUninstallPlan(uninstall); }
    finally {
      fs.rmSync = originalRmSync;
      fs.renameSync = originalRenameSync;
    }

    assert.equal(cleanupInjected, true);
    assert.equal(lockCleanupInjected, true);
    assert.equal(result.status, 'COMMITTED_WITH_CLEANUP_WARNING');
    assert.equal(result.cleanupWarnings.length, 2);
    const recoveryPath = result.cleanupWarnings.find((warning) => warning.path.includes('.linmas-rollback.'))?.path;
    assert.ok(recoveryPath.includes('.linmas-rollback.'));
    assert.equal(fs.readFileSync(path.join(recoveryPath, 'SKILL.md'), 'utf8'), '# test skill\n');
    assert.equal(result.cleanupWarnings.some((warning) => warning.path.endsWith('.linmas-install.lock')), true);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(readScopedManifest(manifestPath, 'project').skills, []);
    assert.equal(fs.existsSync(path.join(data.project, '.agents', '.linmas-install.lock')), true);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('project ancestor symlink is rejected before outside content changes', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const outside = path.join(data.base, 'outside');
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(data.project, '.agents'), 'dir');
    const plan = installPlan(data, ['codex'], 'copy');
    assert.throws(() => applyScopedInstallPlan(plan), /unsafe directory|symlink|stable directory handles/i);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});

test('project uninstall refuses a symlinked Claude root before outside content changes', { skip: POSIX_SAFE_MUTATION }, () => {
  const data = fixture();
  const outside = path.join(data.base, 'outside');
  try {
    applyScopedInstallPlan(installPlan(data, ['claude'], 'copy'));
    const installed = path.join(data.project, '.claude', 'skills', data.skill.name);
    fs.mkdirSync(path.join(outside, 'skills'), { recursive: true });
    fs.cpSync(installed, path.join(outside, 'skills', data.skill.name), { recursive: true });
    fs.renameSync(path.join(data.project, '.claude'), path.join(data.base, 'claude-original'));
    fs.symlinkSync(outside, path.join(data.project, '.claude'), 'dir');

    const manifest = readScopedManifest(path.join(data.project, '.agents', 'linmas-manifest.json'), 'project');
    const plan = planScopedUninstall({ manifest, targets: data.targets, scope: 'project', scopeRoot: data.project, skillNames: [data.skill.name], agents: ['claude'] });
    assert.throws(() => applyScopedUninstallPlan(plan), /changed|safe directory/i);
    assert.equal(fs.readFileSync(path.join(outside, 'skills', data.skill.name, 'SKILL.md'), 'utf8'), '# test skill\n');
  } finally { fs.rmSync(data.base, { recursive: true, force: true }); }
});
