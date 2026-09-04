import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planUninstall, formatUninstallPreview, applyUninstallPlan, retryUninstallCleanup } from '../src/core/uninstall-skills.mjs';
import { writeManifest } from '../src/core/manifest.mjs';

const POSIX_DESTRUCTIVE_TEST = {
  skip: process.platform === 'win32'
    ? 'POSIX descriptor-relative destructive implementation; Windows fail-closed behavior has dedicated tests'
    : false
};

function createCommittedCleanupFixture(tmp, { nestedParent = false } = {}) {
  const hostRoot = path.join(tmp, '.claude');
  const installRoot = path.join(hostRoot, 'skills');
  const skillParent = nestedParent ? path.join(installRoot, 'managed') : installRoot;
  const skillPath = path.join(skillParent, 'secure-code-reviewer');
  const manifestPath = path.join(hostRoot, 'linmas-manifest.json');
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# retained backup fixture\n');
  const manifest = {
    tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'claude',
    installedAt: '2026-09-03T00:00:00.000Z',
    skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
  };
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  fs.writeFileSync(manifestPath, manifestBytes);
  const manifests = new Map([['claude', structuredClone(manifest)]]);
  const result = applyUninstallPlan(
    [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }],
    manifests,
    new Map([['claude', manifestPath]]),
    {
      removeBackupImpl() {
        throw Object.assign(new Error('synthetic committed cleanup failure'), { code: 'EBUSY' });
      }
    }
  );
  return {
    hostRoot,
    installRoot,
    skillParent,
    skillPath,
    manifestPath,
    manifestBytes,
    manifests,
    result,
    warning: result.cleanupWarnings[0]
  };
}

test('planUninstall only includes manifest-managed skill paths', () => {
  const plan = planUninstall({
    manifests: [{ tool: 'linmas', version: '0.1.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-07T00:00:00.000Z', skills: [{ name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null }] }],
    detections: [{ host: 'claude', status: 'detected', reason: 'ok', rootPath: '/tmp/.claude', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', writable: true }],
    skillName: 'secure-code-reviewer',
    uninstallAll: false
  });

  assert.deepEqual(plan, [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/.claude/skills/secure-code-reviewer', installRoot: '/tmp/.claude/skills' }]);
});

test('canonical name can uninstall a legacy manifest entry without changing its recorded path', () => {
  const plan = planUninstall({
    manifests: [{ tool: 'linmas', version: '0.1.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-07T00:00:00.000Z', skills: [{ name: 'secure-code-reviewer', path: '/tmp/.claude/skills/secure-code-reviewer', backupPath: null }] }],
    detections: [{ host: 'claude', status: 'detected', reason: 'ok', rootPath: '/tmp/.claude', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', writable: true }],
    skillName: 'linmas-secure-code-reviewer',
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

test('planUninstall requires a skill name or --all', () => {
  assert.throws(() => planUninstall({
    manifests: [],
    detections: [],
    skillName: null,
    uninstallAll: false
  }), /uninstall requires a skill name or --all/);
});

test('formatUninstallPreview matches expectations', () => {
  const plan = [
    { host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/.claude/skills/secure-code-reviewer' }
  ];
  const output = formatUninstallPreview(plan);
  assert.equal(output, 'Linmas uninstall preview:\n- claude: remove secure-code-reviewer from /tmp/.claude/skills/secure-code-reviewer\n');
});

test('applyUninstallPlan deletes the files and updates manifest', POSIX_DESTRUCTIVE_TEST, () => {
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

test('applyUninstallPlan rolls back every host when any manifest write fails', POSIX_DESTRUCTIVE_TEST, () => {
  for (const failAt of [1, 2]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `linmas-uninstall-rollback-${failAt}-`));
    try {
      const plan = [];
      const manifests = new Map();
      const manifestPathByHost = new Map();
      const originalManifests = new Map();
      const originalManifestFiles = new Map();

      for (const host of ['host1', 'host2']) {
        const root = path.join(tmp, host);
        const installRoot = path.join(root, 'skills');
        const skillPath = path.join(installRoot, 'test-skill');
        const manifestPath = path.join(root, 'linmas-manifest.json');
        const manifest = {
          tool: 'linmas', version: '0.7.0', manifestVersion: 1, host,
          installedAt: '2026-09-03T00:00:00.000Z',
          skills: [{ name: 'test-skill', path: skillPath, backupPath: null }]
        };
        const manifestFile = `${JSON.stringify(manifest)}\n`;

        fs.mkdirSync(skillPath, { recursive: true });
        fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `# original ${host}\n`);
        fs.writeFileSync(manifestPath, manifestFile);
        plan.push({ host, skillName: 'test-skill', skillPath, installRoot });
        manifests.set(host, manifest);
        manifestPathByHost.set(host, manifestPath);
        originalManifests.set(host, structuredClone(manifest));
        originalManifestFiles.set(host, manifestFile);
      }

      let writes = 0;
      assert.throws(() => applyUninstallPlan(plan, manifests, manifestPathByHost, {
        writeManifestImpl(manifestPath, manifest) {
          writeManifest(manifestPath, manifest);
          writes += 1;
          if (writes === failAt) throw new Error(`injected manifest failure ${failAt}`);
        }
      }), new RegExp(`injected manifest failure ${failAt}`));

      assert.equal(writes, failAt);
      for (const item of plan) {
        assert.equal(fs.readFileSync(path.join(item.skillPath, 'SKILL.md'), 'utf8'), `# original ${item.host}\n`);
        assert.equal(fs.readFileSync(manifestPathByHost.get(item.host), 'utf8'), originalManifestFiles.get(item.host));
        assert.deepEqual(manifests.get(item.host), originalManifests.get(item.host));
        assert.deepEqual(fs.readdirSync(item.installRoot), ['test-skill']);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('F-007 cleanup failure reports a committed uninstall with retry diagnostics', POSIX_DESTRUCTIVE_TEST, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-cleanup-warning-'));
  try {
    const installRoot = path.join(tmp, '.claude', 'skills');
    const skillPath = path.join(installRoot, 'secure-code-reviewer');
    const manifestPath = path.join(tmp, '.claude', 'linmas-manifest.json');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# retained backup fixture\n');
    const manifest = {
      tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'claude',
      installedAt: '2026-09-03T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const manifests = new Map([['claude', structuredClone(manifest)]]);
    let cleanupCalls = 0;

    const result = applyUninstallPlan(
      [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }],
      manifests,
      new Map([['claude', manifestPath]]),
      {
        removeBackupImpl() {
          cleanupCalls += 1;
          throw Object.assign(new Error('synthetic committed cleanup failure'), { code: 'EBUSY' });
        }
      }
    );

    assert.equal(result.status, 'COMMITTED_WITH_CLEANUP_WARNING');
    assert.deepEqual(result.removed, [skillPath]);
    assert.equal(cleanupCalls, 1);
    assert.equal(fs.existsSync(skillPath), false);
    assert.deepEqual(manifests.get('claude').skills, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).skills, []);
    assert.equal(result.cleanupWarnings.length, 1);
    const warning = result.cleanupWarnings[0];
    assert.equal(warning.host, 'claude');
    assert.equal(warning.installRoot, installRoot);
    assert.equal(warning.code, 'EBUSY');
    assert.match(warning.message, /committed.*cleanup failed/i);
    assert.equal(path.dirname(warning.backupPath), installRoot);
    assert.equal(fs.readFileSync(path.join(warning.backupPath, 'SKILL.md'), 'utf8'), '# retained backup fixture\n');

    assert.equal(typeof retryUninstallCleanup, 'function');
    assert.deepEqual(retryUninstallCleanup(warning), {
      status: 'CLEANED',
      backupPath: warning.backupPath
    });
    assert.equal(fs.existsSync(warning.backupPath), false);
    assert.deepEqual(retryUninstallCleanup(warning), {
      status: 'ALREADY_CLEAN',
      backupPath: warning.backupPath
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-001 cleanup retry rejects install-root substitution without external mutation', POSIX_DESTRUCTIVE_TEST, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-retry-root-swap-'));
  try {
    const fixture = createCommittedCleanupFixture(tmp);
    const { installRoot, skillPath, manifestPath, manifests, warning } = fixture;
    const committedManifestBytes = fs.readFileSync(manifestPath, 'utf8');
    const displacedInstallRoot = path.join(fixture.hostRoot, 'skills-before-swap');
    const externalRoot = path.join(tmp, 'external-root');
    const backupName = path.basename(warning.backupPath);
    const externalVictim = path.join(externalRoot, backupName);
    const externalBytes = '# external victim must remain byte-identical\n';

    fs.renameSync(installRoot, displacedInstallRoot);
    fs.mkdirSync(externalVictim, { recursive: true });
    fs.writeFileSync(path.join(externalVictim, 'SKILL.md'), externalBytes);
    fs.symlinkSync(externalRoot, installRoot, 'dir');

    assert.throws(() => retryUninstallCleanup(warning), /identity|changed|invalid/i);
    assert.equal(fs.readFileSync(path.join(externalVictim, 'SKILL.md'), 'utf8'), externalBytes);
    assert.deepEqual(fs.readdirSync(externalRoot), [backupName]);
    const originalBackup = path.join(displacedInstallRoot, backupName);
    assert.equal(fs.readFileSync(path.join(originalBackup, 'SKILL.md'), 'utf8'), '# retained backup fixture\n');
    assert.equal(fs.existsSync(path.join(displacedInstallRoot, path.basename(skillPath))), false);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), committedManifestBytes);
    assert.deepEqual(manifests.get('claude').skills, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-007 cleanup retry rejects forged paths and valid-looking foreign backups', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-retry-forged-'));
  try {
    const installRoot = path.join(tmp, 'skills');
    const externalRoot = path.join(tmp, 'external');
    fs.mkdirSync(installRoot, { recursive: true });
    fs.mkdirSync(externalRoot, { recursive: true });
    const validLookingName = '.foreign.linmas-uninstall.999.12345678-1234-4123-8123-123456789abc.tmp';
    const foreignBackup = path.join(installRoot, validLookingName);
    fs.mkdirSync(foreignBackup);
    fs.writeFileSync(path.join(foreignBackup, 'sentinel.txt'), 'foreign bytes\n');
    const externalVictim = path.join(externalRoot, validLookingName);
    fs.mkdirSync(externalVictim);
    fs.writeFileSync(path.join(externalVictim, 'sentinel.txt'), 'external bytes\n');

    for (const forged of [
      { installRoot, backupPath: path.join(installRoot, '..', 'victim') },
      { installRoot, backupPath: externalVictim },
      { installRoot, backupPath: path.join(installRoot, 'wrong-name') },
      { installRoot, backupPath: foreignBackup },
      {
        installRoot,
        backupPath: foreignBackup,
        cleanupReference: {
          version: 1,
          installRoot,
          installRootIdentity: { device: '0', inode: '0' },
          backupRelativePath: validLookingName
        }
      }
    ]) {
      assert.throws(() => retryUninstallCleanup(forged));
    }
    assert.equal(fs.readFileSync(path.join(foreignBackup, 'sentinel.txt'), 'utf8'), 'foreign bytes\n');
    assert.equal(fs.readFileSync(path.join(externalVictim, 'sentinel.txt'), 'utf8'), 'external bytes\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-007 cleanup reference is bounded, opaque, and bound to the original backup identity', POSIX_DESTRUCTIVE_TEST, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-retry-identity-'));
  try {
    const { warning } = createCommittedCleanupFixture(tmp);
    assert.ok(warning.cleanupReference);
    assert.equal(warning.cleanupReference.version, 1);
    assert.equal(path.isAbsolute(warning.cleanupReference.backupRelativePath), false);
    assert.equal(warning.cleanupReference.backupRelativePath, path.basename(warning.backupPath));
    assert.match(warning.cleanupReference.installRootIdentity.device, /^\d+$/);
    assert.match(warning.cleanupReference.installRootIdentity.inode, /^\d+$/);
    assert.equal(Object.isFrozen(warning.cleanupReference), true);
    assert.equal(Object.isFrozen(warning.cleanupReference.installRootIdentity), true);

    const forgedClone = {
      ...warning,
      cleanupReference: structuredClone(warning.cleanupReference)
    };
    assert.throws(() => retryUninstallCleanup(forgedClone), /invalid|unknown|expired/i);

    const originalBackup = `${warning.backupPath}.original`;
    const externalTarget = path.join(tmp, 'external-target');
    fs.renameSync(warning.backupPath, originalBackup);
    fs.mkdirSync(externalTarget);
    fs.writeFileSync(path.join(externalTarget, 'sentinel.txt'), 'external target bytes\n');
    fs.symlinkSync(externalTarget, warning.backupPath, 'dir');

    assert.throws(() => retryUninstallCleanup(warning), /identity|symbolic|changed|invalid/i);
    assert.equal(fs.readFileSync(path.join(externalTarget, 'sentinel.txt'), 'utf8'), 'external target bytes\n');
    assert.equal(fs.lstatSync(warning.backupPath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(originalBackup, 'SKILL.md'), 'utf8'), '# retained backup fixture\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-007 cleanup retry refuses a replacement directory with the original valid backup name', POSIX_DESTRUCTIVE_TEST, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-retry-replaced-backup-'));
  try {
    const { warning } = createCommittedCleanupFixture(tmp);
    const originalBackup = `${warning.backupPath}.original`;
    fs.renameSync(warning.backupPath, originalBackup);
    fs.mkdirSync(warning.backupPath);
    fs.writeFileSync(path.join(warning.backupPath, 'sentinel.txt'), 'replacement bytes\n');

    assert.throws(() => retryUninstallCleanup(warning), /identity.*changed/i);
    assert.equal(fs.readFileSync(path.join(warning.backupPath, 'sentinel.txt'), 'utf8'), 'replacement bytes\n');
    assert.equal(fs.readFileSync(path.join(originalBackup, 'SKILL.md'), 'utf8'), '# retained backup fixture\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-001 post-commit parent substitution cannot redirect descriptor-anchored cleanup', POSIX_DESTRUCTIVE_TEST, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-post-commit-parent-swap-'));
  try {
    const hostRoot = path.join(tmp, '.claude');
    const installRoot = path.join(hostRoot, 'skills');
    const skillParent = path.join(installRoot, 'managed');
    const displacedParent = path.join(installRoot, 'managed-before-cleanup-swap');
    const skillPath = path.join(skillParent, 'secure-code-reviewer');
    const externalParent = path.join(tmp, 'external-parent');
    const manifestPath = path.join(hostRoot, 'linmas-manifest.json');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.mkdirSync(externalParent, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# managed bytes\n');
    const manifest = {
      tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'claude',
      installedAt: '2026-09-03T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const manifests = new Map([['claude', structuredClone(manifest)]]);
    let externalVictim;

    const result = applyUninstallPlan(
      [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }],
      manifests,
      new Map([['claude', manifestPath]]),
      {
        removeBackupImpl(descriptorBackupPath, options) {
          const backupName = path.basename(descriptorBackupPath);
          externalVictim = path.join(externalParent, backupName);
          fs.mkdirSync(externalVictim);
          fs.writeFileSync(path.join(externalVictim, 'SKILL.md'), '# external bytes\n');
          fs.renameSync(skillParent, displacedParent);
          fs.symlinkSync(externalParent, skillParent, 'dir');
          fs.rmSync(descriptorBackupPath, options);
        }
      }
    );

    assert.equal(result.status, 'COMMITTED');
    assert.deepEqual(result.cleanupWarnings, []);
    assert.equal(fs.readFileSync(path.join(externalVictim, 'SKILL.md'), 'utf8'), '# external bytes\n');
    assert.deepEqual(fs.readdirSync(externalParent), [path.basename(externalVictim)]);
    assert.deepEqual(fs.readdirSync(displacedParent), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).skills, []);
    assert.deepEqual(manifests.get('claude').skills, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-007 post-commit cleanup does not adopt a replacement backup identity', POSIX_DESTRUCTIVE_TEST, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-post-commit-backup-swap-'));
  try {
    const hostRoot = path.join(tmp, '.claude');
    const installRoot = path.join(hostRoot, 'skills');
    const skillPath = path.join(installRoot, 'secure-code-reviewer');
    const manifestPath = path.join(hostRoot, 'linmas-manifest.json');
    const displacedBackupRoot = path.join(tmp, 'displaced-backup');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.mkdirSync(displacedBackupRoot);
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# original managed bytes\n');
    const manifest = {
      tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'claude',
      installedAt: '2026-09-03T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const manifests = new Map([['claude', structuredClone(manifest)]]);
    let backupPath;
    let displacedBackup;

    const result = applyUninstallPlan(
      [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }],
      manifests,
      new Map([['claude', manifestPath]]),
      {
        writeManifestImpl(target, updated) {
          writeManifest(target, updated);
          const backupName = fs.readdirSync(installRoot).find((name) => name.includes('.linmas-uninstall.'));
          backupPath = path.join(installRoot, backupName);
          displacedBackup = path.join(displacedBackupRoot, backupName);
          fs.renameSync(backupPath, displacedBackup);
          fs.mkdirSync(backupPath);
          fs.writeFileSync(path.join(backupPath, 'sentinel.txt'), 'replacement backup bytes\n');
        }
      }
    );

    assert.equal(result.status, 'COMMITTED_WITH_CLEANUP_WARNING');
    assert.equal(result.cleanupWarnings.length, 1);
    assert.equal(result.cleanupWarnings[0].cleanupReference, null);
    assert.equal(fs.readFileSync(path.join(backupPath, 'sentinel.txt'), 'utf8'), 'replacement backup bytes\n');
    assert.equal(fs.readFileSync(path.join(displacedBackup, 'SKILL.md'), 'utf8'), '# original managed bytes\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).skills, []);
    assert.deepEqual(manifests.get('claude').skills, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-001/F-007 descriptor anchors close across successful and rejected cleanup retries', (t) => {
  if (!fs.existsSync('/proc/self/fd')) {
    t.skip('descriptor inventory is unavailable on this platform');
    return;
  }
  const before = fs.readdirSync('/proc/self/fd').length;

  for (let index = 0; index < 20; index += 1) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-fd-success-'));
    try {
      const { warning } = createCommittedCleanupFixture(tmp);
      assert.equal(retryUninstallCleanup(warning).status, 'CLEANED');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  for (let index = 0; index < 20; index += 1) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-fd-reject-'));
    try {
      const fixture = createCommittedCleanupFixture(tmp);
      const displaced = path.join(fixture.hostRoot, 'skills-before-swap');
      const external = path.join(tmp, 'external');
      const backupName = path.basename(fixture.warning.backupPath);
      fs.renameSync(fixture.installRoot, displaced);
      fs.mkdirSync(path.join(external, backupName), { recursive: true });
      fs.symlinkSync(external, fixture.installRoot, 'dir');
      assert.throws(() => retryUninstallCleanup(fixture.warning), /identity|changed/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  assert.equal(fs.readdirSync('/proc/self/fd').length, before);
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

test('applyUninstallPlan refuses to delete through a symlink escaping the install root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-'));
  try {
    const installRoot = path.join(tmp, '.claude', 'skills');
    const manifestPath = path.join(tmp, '.claude', 'linmas-manifest.json');
    fs.mkdirSync(installRoot, { recursive: true });

    // Sensitive data outside the install root that a tampered manifest tries to
    // reach via a symlink placed inside the install root.
    const outside = path.join(tmp, 'precious');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'data.txt'), 'keep me\n');

    const skillPath = path.join(installRoot, 'secure-code-reviewer');
    fs.symlinkSync(outside, skillPath);

    const manifest = {
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };

    const plan = [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }];
    const manifests = new Map([['claude', manifest]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);

    assert.throws(() => {
      applyUninstallPlan(plan, manifests, manifestPathByHost);
    }, /refusing to write outside root/);
    assert.equal(fs.existsSync(path.join(outside, 'data.txt')), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-001 inherited fix blocks an intermediate symlink escape before mutation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-intermediate-link-'));
  try {
    const installRoot = path.join(tmp, '.claude', 'skills');
    const outside = path.join(tmp, 'outside');
    const outsideSkill = path.join(outside, 'secure-code-reviewer');
    const manifestPath = path.join(tmp, '.claude', 'linmas-manifest.json');
    fs.mkdirSync(outsideSkill, { recursive: true });
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(path.join(outsideSkill, 'SKILL.md'), '# byte-identical fixture\n');
    fs.symlinkSync(outside, path.join(installRoot, 'linked-parent'), 'dir');

    const skillPath = path.join(installRoot, 'linked-parent', 'secure-code-reviewer');
    const manifest = {
      tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'claude',
      installedAt: '2026-09-03T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const manifests = new Map([['claude', manifest]]);

    assert.throws(() => applyUninstallPlan(
      [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }],
      manifests,
      new Map([['claude', manifestPath]])
    ), /refusing to write outside root/);
    assert.equal(fs.readFileSync(path.join(outsideSkill, 'SKILL.md'), 'utf8'), '# byte-identical fixture\n');
    assert.deepEqual(manifests.get('claude'), manifest);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F-001 parent substitution after preflight cannot mutate an external skill', POSIX_DESTRUCTIVE_TEST, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-parent-swap-'));
  try {
    const hostRoot = path.join(tmp, '.claude');
    const installRoot = path.join(hostRoot, 'skills');
    const skillParent = path.join(installRoot, 'managed');
    const displacedParent = path.join(installRoot, 'managed-before-swap');
    const skillPath = path.join(skillParent, 'secure-code-reviewer');
    const externalRoot = path.join(tmp, 'external-skills');
    const externalSkill = path.join(externalRoot, 'secure-code-reviewer');
    const manifestPath = path.join(hostRoot, 'linmas-manifest.json');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.mkdirSync(externalSkill, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# managed fixture\n');
    fs.writeFileSync(path.join(externalSkill, 'SKILL.md'), '# external bytes must survive\n');

    const manifest = {
      tool: 'linmas', version: '0.7.0', manifestVersion: 1, host: 'claude',
      installedAt: '2026-09-03T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    };
    const manifestBytes = `${JSON.stringify(manifest)}\n`;
    fs.writeFileSync(manifestPath, manifestBytes);
    const manifests = new Map([['claude', structuredClone(manifest)]]);
    let hookCalled = false;

    assert.throws(() => applyUninstallPlan(
      [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }],
      manifests,
      new Map([['claude', manifestPath]]),
      {
        beforeFirstRename() {
          hookCalled = true;
          fs.renameSync(skillParent, displacedParent);
          fs.symlinkSync(externalRoot, skillParent, 'dir');
        }
      }
    ), /skill parent changed during uninstall/i);

    assert.equal(hookCalled, true);
    assert.equal(fs.readFileSync(path.join(externalSkill, 'SKILL.md'), 'utf8'), '# external bytes must survive\n');
    assert.deepEqual(fs.readdirSync(externalRoot), ['secure-code-reviewer']);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBytes);
    assert.deepEqual(manifests.get('claude'), manifest);
    assert.equal(fs.readFileSync(path.join(displacedParent, 'secure-code-reviewer', 'SKILL.md'), 'utf8'), '# managed fixture\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUninstallPlan throws if skill path is the install root itself', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-uninstall-'));
  try {
    const installRoot = path.join(tmp, '.claude', 'skills');
    const manifestPath = path.join(tmp, '.claude', 'linmas-manifest.json');
    fs.mkdirSync(installRoot, { recursive: true });

    const manifest = {
      tool: 'linmas',
      version: '0.1.0',
      manifestVersion: 1,
      host: 'claude',
      installedAt: '2026-07-07T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: installRoot, backupPath: null }]
    };

    const plan = [{
      host: 'claude',
      skillName: 'secure-code-reviewer',
      skillPath: installRoot,
      installRoot
    }];

    const manifests = new Map([['claude', manifest]]);
    const manifestPathByHost = new Map([['claude', manifestPath]]);

    assert.throws(() => {
      applyUninstallPlan(plan, manifests, manifestPathByHost);
    }, /refusing to operate on root path/);
    assert.equal(fs.existsSync(installRoot), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function createPromptIO(inputs) {
  let stdoutData = '';
  let stderrData = '';
  const queue = [...inputs];
  return {
    stdout: {
      write(chunk) {
        stdoutData += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk) {
        stderrData += chunk;
        return true;
      }
    },
    getStdout() {
      return stdoutData;
    },
    getStderr() {
      return stderrData;
    },
    async readLine() {
      const value = queue.shift();
      return value === undefined ? null : value;
    }
  };
}

test('promptForUninstallChoices handles interactive host selection and confirmation', async () => {
  const io = createPromptIO(['claude', 'yes']);
  const plan = [
    { host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/claude/skills/secure-code-reviewer' },
    { host: 'codex', skillName: 'secure-code-reviewer', skillPath: '/tmp/codex/skills/secure-code-reviewer' }
  ];
  const { promptForUninstallChoices } = await import('../src/core/uninstall-skills.mjs');
  const result = await promptForUninstallChoices(io, plan);
  assert.deepEqual(result, { selectedHosts: ['claude'], confirm: true });
});

test('promptForUninstallTarget and promptForUninstallConfirmation work independently', async () => {
  const { promptForUninstallTarget, promptForUninstallConfirmation } = await import('../src/core/uninstall-skills.mjs');
  const plan = [
    { host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/claude/skills/secure-code-reviewer' },
    { host: 'codex', skillName: 'secure-code-reviewer', skillPath: '/tmp/codex/skills/secure-code-reviewer' }
  ];

  const io1 = createPromptIO(['codex']);
  const target = await promptForUninstallTarget(io1, plan);
  assert.deepEqual(target, ['codex']);

  const io2 = createPromptIO(['yes']);
  const confirm = await promptForUninstallConfirmation(io2);
  assert.equal(confirm, true);
});

test('promptForUninstallTarget returns empty selection on EOF', async () => {
  const { promptForUninstallTarget } = await import('../src/core/uninstall-skills.mjs');
  const io = createPromptIO([]);
  const plan = [
    { host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/claude/skills/secure-code-reviewer' },
    { host: 'codex', skillName: 'secure-code-reviewer', skillPath: '/tmp/codex/skills/secure-code-reviewer' }
  ];
  const selectedHosts = await promptForUninstallTarget(io, plan);
  assert.deepEqual(selectedHosts, []);
  assert.doesNotMatch(io.getStdout(), /Invalid/);
});

test('promptForUninstallConfirmation returns false on EOF', async () => {
  const { promptForUninstallConfirmation } = await import('../src/core/uninstall-skills.mjs');
  const io = createPromptIO([]);
  const confirm = await promptForUninstallConfirmation(io);
  assert.equal(confirm, false);
});

test('promptForUninstallTarget reprompts on invalid input instead of defaulting to both', async () => {
  const { promptForUninstallTarget } = await import('../src/core/uninstall-skills.mjs');
  const io = createPromptIO(['wrong', 'claude']);
  const plan = [
    { host: 'claude', skillName: 'secure-code-reviewer', skillPath: '/tmp/claude/skills/secure-code-reviewer' },
    { host: 'codex', skillName: 'secure-code-reviewer', skillPath: '/tmp/codex/skills/secure-code-reviewer' }
  ];

  const selectedHosts = await promptForUninstallTarget(io, plan);
  assert.deepEqual(selectedHosts, ['claude']);
  assert.match(io.getStdout(), /Invalid uninstall target\./);
});
