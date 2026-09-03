import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertInsideRoot } from './fs-utils.mjs';
import { validateManifest, writeManifest, writeManifestSnapshot } from './manifest.mjs';
import { matchesSkillIdentifier } from './skill-catalog.mjs';

const UNINSTALL_BACKUP_NAME = /^\..+\.linmas-uninstall\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const cleanupCapabilities = new WeakMap();
export const SAFE_FILESYSTEM_OPERATION_UNAVAILABLE = 'SAFE_FILESYSTEM_OPERATION_UNAVAILABLE';

function assertSecureDestructiveFilesystem(platform) {
  if (platform !== 'win32') return;
  const error = new Error(`${SAFE_FILESYSTEM_OPERATION_UNAVAILABLE}: secure destructive filesystem operations are unavailable on Windows without handle-relative mutation support`);
  error.code = SAFE_FILESYSTEM_OPERATION_UNAVAILABLE;
  throw error;
}

export function planUninstall({ manifests, detections, skillName, uninstallAll }) {
  if (!uninstallAll && !skillName) {
    throw new Error('uninstall requires a skill name or --all');
  }

  const installRoots = new Map(
    detections
      .filter((d) => d.status === 'detected' || d.status === 'probably_detected')
      .map((d) => [d.host, d.installRoot])
  );

  return manifests.flatMap((manifest) => {
    const installRoot = installRoots.get(manifest.host);
    if (!installRoot) return [];

    return manifest.skills
      .filter((skill) => uninstallAll || matchesSkillIdentifier(skill.name, skillName))
      .map((skill) => ({
        host: manifest.host,
        skillName: skill.name,
        skillPath: skill.path,
        installRoot
      }));
  });
}

export function formatUninstallPreview(plan) {
  const lines = ['Linmas uninstall preview:'];
  for (const item of plan) {
    lines.push(`- ${item.host}: remove ${item.skillName} from ${item.skillPath}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function promptForUninstallTarget(io, plan) {
  const hosts = [...new Set(plan.map((item) => item.host))];
  let selectedHosts = [];

  if (io && typeof io.readLine === 'function' && hosts.length > 1) {
    while (true) {
      io.stdout.write('Choose uninstall target: claude, codex, or both\n');
      const line = await io.readLine();
      if (line === null) break;
      const ans = line.trim().toLowerCase();
      if (ans === 'claude') {
        selectedHosts = ['claude'];
        break;
      }
      if (ans === 'codex') {
        selectedHosts = ['codex'];
        break;
      }
      if (ans === 'both') {
        selectedHosts = [...hosts];
        break;
      }
      if (ans) io.stdout.write('Invalid uninstall target.\n');
    }
  } else {
    selectedHosts = [...hosts];
  }

  return selectedHosts;
}

export async function promptForUninstallConfirmation(io) {
  let confirm = false;
  if (io && typeof io.readLine === 'function') {
    io.stdout.write('Confirm uninstallation? [yes/no]\n');
    const line = await io.readLine();
    if (line !== null) {
      const ans = line.trim().toLowerCase();
      if (ans === 'yes' || ans === 'y') confirm = true;
    }
  }
  return confirm;
}

export async function promptForUninstallChoices(io, plan, options = {}) {
  const selectedHosts = await promptForUninstallTarget(io, plan);
  const confirm = await promptForUninstallConfirmation(io);
  return { selectedHosts, confirm };
}

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// ponytail: Node lacks openat bindings; fail closed without a descriptor path until native relative filesystem APIs exist.
function descriptorPath(fd) {
  const identity = fs.fstatSync(fd, { bigint: true });
  for (const candidate of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) {
    try {
      if (sameDirectory(identity, fs.statSync(candidate, { bigint: true }))) return candidate;
    } catch { /* try the next platform descriptor path */ }
  }
  throw new Error('Stable directory handles are unavailable; refusing destructive uninstall');
}

function openDirectoryNoFollow(targetPath) {
  if (fs.constants.O_DIRECTORY === undefined || fs.constants.O_NOFOLLOW === undefined) {
    throw new Error('Stable directory handles are unavailable; refusing destructive uninstall');
  }
  const fd = fs.openSync(targetPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    return { fd, path: descriptorPath(fd), identity: fs.fstatSync(fd, { bigint: true }) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function openCanonicalDirectory(targetPath) {
  const parsed = path.parse(targetPath);
  let anchor = openDirectoryNoFollow(parsed.root);
  try {
    for (const component of path.relative(parsed.root, targetPath).split(path.sep).filter(Boolean)) {
      const next = openDirectoryNoFollow(path.join(anchor.path, component));
      fs.closeSync(anchor.fd);
      anchor = next;
    }
    return anchor;
  } catch (error) {
    fs.closeSync(anchor.fd);
    throw error;
  }
}

function openMutationAnchors(installRoot, parentPath) {
  const rootPath = fs.realpathSync(installRoot);
  const expectedRoot = fs.statSync(rootPath, { bigint: true });
  const root = openCanonicalDirectory(rootPath);
  try {
    if (!sameDirectory(expectedRoot, root.identity)) throw new Error('Install root changed during uninstall');

    const canonicalParent = fs.realpathSync(parentPath);
    const relative = path.relative(rootPath, canonicalParent);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`refusing to write outside root: ${parentPath}`);
    if (!relative) return { root, parent: root };

    let parent = null;
    let base = root.path;
    try {
      for (const component of relative.split(path.sep)) {
        const next = openDirectoryNoFollow(path.join(base, component));
        if (parent) fs.closeSync(parent.fd);
        parent = next;
        base = parent.path;
      }
      return { root, parent };
    } catch (error) {
      if (parent) fs.closeSync(parent.fd);
      throw error;
    }
  } catch (error) {
    fs.closeSync(root.fd);
    throw error;
  }
}

function assertAnchorCurrent(anchor, targetPath, label) {
  let current;
  try { current = fs.statSync(targetPath, { bigint: true }); }
  catch { throw new Error(`${label} changed during uninstall`); }
  if (!sameDirectory(anchor.identity, current)) throw new Error(`${label} changed during uninstall`);
}

function closeMutationAnchors(operations) {
  const closed = new Set();
  for (const item of operations) {
    for (const anchor of [item.parentAnchor, item.rootAnchor]) {
      if (!anchor || closed.has(anchor.fd)) continue;
      closed.add(anchor.fd);
      try { fs.closeSync(anchor.fd); } catch { /* operation outcome remains authoritative */ }
    }
  }
}

function cleanupRelativePath(installRoot, backupPath) {
  assertInsideRoot(installRoot, backupPath);
  const relative = path.relative(installRoot, backupPath);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Uninstall cleanup backup path is invalid');
  }
  const backupName = path.basename(relative);
  if (!UNINSTALL_BACKUP_NAME.test(backupName)) throw new Error('Uninstall cleanup backup name is invalid');
  return { relative, backupName };
}

function identityRecord(identity) {
  return Object.freeze({
    device: identity.dev.toString(),
    inode: identity.ino.toString()
  });
}

function createCleanupReference(item) {
  const { relative, backupName } = cleanupRelativePath(item.installRoot, item.backupPath);
  const anchoredBackupPath = path.join(item.parentAnchor.path, backupName);
  const currentBackupIdentity = fs.lstatSync(anchoredBackupPath, { bigint: true });
  if (!item.backupIdentity
    || !currentBackupIdentity.isDirectory()
    || currentBackupIdentity.isSymbolicLink()
    || !sameDirectory(item.backupIdentity, currentBackupIdentity)) {
    throw new Error('Uninstall cleanup backup is not a managed directory');
  }

  const reference = Object.freeze({
    version: 1,
    installRoot: item.installRoot,
    installRootIdentity: identityRecord(item.rootAnchor.identity),
    backupRelativePath: relative
  });
  cleanupCapabilities.set(reference, Object.freeze({
    installRoot: item.installRoot,
    backupRelativePath: relative,
    backupName,
    rootIdentity: item.rootAnchor.identity,
    parentIdentity: item.parentAnchor.identity,
    backupIdentity: item.backupIdentity
  }));
  return reference;
}

function cleanupCapability(value) {
  const reference = value?.cleanupReference;
  const capability = reference && cleanupCapabilities.get(reference);
  if (!capability) throw new Error('Uninstall cleanup reference is invalid, unknown, or expired');
  return capability;
}

function statWithoutFollowing(targetPath) {
  try {
    return fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function restoreCleanupCandidate(quarantinePath, backupPath, cause) {
  try {
    if (pathExists(quarantinePath) && !pathExists(backupPath)) fs.renameSync(quarantinePath, backupPath);
  } catch (rollbackCause) {
    cause.rollbackErrors = [...(cause.rollbackErrors ?? []), rollbackCause];
  }
}

function removeIdentityBoundBackup({ parentAnchor, backupName, backupIdentity, removeBackupImpl }) {
  const backupPath = path.join(parentAnchor.path, backupName);
  const currentIdentity = statWithoutFollowing(backupPath);
  if (!currentIdentity) throw new Error('Uninstall cleanup backup is missing');

  const quarantineName = `.${backupName}.linmas-cleanup.${process.pid}.${randomUUID()}.tmp`;
  const quarantinePath = path.join(parentAnchor.path, quarantineName);
  if (pathExists(quarantinePath)) throw new Error('Uninstall cleanup quarantine already exists');
  fs.renameSync(backupPath, quarantinePath);
  try {
    const candidateIdentity = statWithoutFollowing(quarantinePath);
    if (!candidateIdentity
      || candidateIdentity.isSymbolicLink()
      || !candidateIdentity.isDirectory()
      || !sameDirectory(backupIdentity, candidateIdentity)) {
      throw new Error('Uninstall cleanup backup identity changed after commit');
    }
    removeBackupImpl(quarantinePath, { recursive: true, force: true });
    if (statWithoutFollowing(quarantinePath)) throw new Error('Uninstall cleanup did not remove the managed backup');
  } catch (cause) {
    restoreCleanupCandidate(quarantinePath, backupPath, cause);
    throw cause;
  }
}

export function retryUninstallCleanup(cleanupWarning, {
  removeBackupImpl = fs.rmSync,
  platform = process.platform
} = {}) {
  assertSecureDestructiveFilesystem(platform);
  const capability = cleanupCapability(cleanupWarning);
  const backupPath = path.resolve(capability.installRoot, capability.backupRelativePath);
  const { backupName } = cleanupRelativePath(capability.installRoot, backupPath);
  const backupParent = path.dirname(backupPath);
  const anchors = openMutationAnchors(capability.installRoot, backupParent);
  try {
    if (!sameDirectory(capability.rootIdentity, anchors.root.identity)) {
      throw new Error('Install root identity changed after uninstall commit');
    }
    if (!sameDirectory(capability.parentIdentity, anchors.parent.identity)) {
      throw new Error('Backup parent identity changed after uninstall commit');
    }
    assertAnchorCurrent(anchors.root, capability.installRoot, 'Install root');
    assertAnchorCurrent(anchors.parent, backupParent, 'Backup parent');

    const anchoredBackupPath = path.join(anchors.parent.path, backupName);
    if (!statWithoutFollowing(anchoredBackupPath)) return { status: 'ALREADY_CLEAN', backupPath };
    removeIdentityBoundBackup({
      parentAnchor: anchors.parent,
      backupName,
      backupIdentity: capability.backupIdentity,
      removeBackupImpl
    });
    return { status: 'CLEANED', backupPath };
  } finally {
    closeMutationAnchors([{ rootAnchor: anchors.root, parentAnchor: anchors.parent }]);
  }
}

function rollbackUninstall(journal, previousManifestFiles) {
  const errors = [];
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    try {
      if (entry.type === 'manifestWrite') {
        const previous = previousManifestFiles.get(entry.host);
        if (previous.exists) writeManifestSnapshot(entry.manifestPath, previous.contents);
        else fs.rmSync(entry.manifestPath, { force: true });
      } else if (entry.type === 'rename') {
        if (pathExists(entry.skillPath)) throw new Error(`Uninstall rollback target already exists: ${entry.skillPath}`);
        fs.renameSync(entry.backupPath, entry.skillPath);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function applyUninstallPlan(plan, manifests, manifestPathByHost, {
  writeManifestImpl = writeManifest,
  removeBackupImpl = fs.rmSync,
  beforeFirstRename,
  platform = process.platform
} = {}) {
  const removed = [];
  const cleanupWarnings = [];
  const journal = [];
  const operations = [];
  const previousManifestFiles = new Map();
  const previousManifestValues = new Map();

  if (!Array.isArray(plan)) throw new Error('Uninstall plan must be an array');
  if (!(manifests instanceof Map)) throw new Error('Uninstall manifests must be a Map');
  if (!(manifestPathByHost instanceof Map)) throw new Error('Uninstall manifest paths must be a Map');

  try {
    for (const item of plan) {
      if (!item?.host || !item.skillName || !item.skillPath || !item.installRoot) {
        throw new Error('Uninstall plan item is invalid');
      }
      if (!manifests.has(item.host)) throw new Error(`No manifest for host: ${item.host}`);
      validateManifest(manifests.get(item.host), item.host);
      const manifestPath = manifestPathByHost.get(item.host);
      if (typeof manifestPath !== 'string' || !manifestPath) throw new Error(`No manifest path for host: ${item.host}`);
      assertInsideRoot(item.installRoot, item.skillPath);
      assertSecureDestructiveFilesystem(platform);

      if (!previousManifestValues.has(item.host)) {
        previousManifestValues.set(item.host, structuredClone(manifests.get(item.host)));
        try {
          previousManifestFiles.set(item.host, { exists: true, contents: fs.readFileSync(manifestPath, 'utf8') });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          previousManifestFiles.set(item.host, { exists: false, contents: null });
        }
      }

      let backupPath = null;
      let rootAnchor = null;
      let parentAnchor = null;
      if (pathExists(item.skillPath)) {
        backupPath = path.join(path.dirname(item.skillPath), `.${path.basename(item.skillPath)}.linmas-uninstall.${process.pid}.${randomUUID()}.tmp`);
        assertInsideRoot(item.installRoot, backupPath);
        if (pathExists(backupPath)) throw new Error(`Uninstall backup already exists: ${backupPath}`);
        ({ root: rootAnchor, parent: parentAnchor } = openMutationAnchors(item.installRoot, path.dirname(item.skillPath)));
      }
      operations.push({ ...item, manifestPath, backupPath, rootAnchor, parentAnchor });
    }

    if (beforeFirstRename !== undefined) {
      if (typeof beforeFirstRename !== 'function') throw new Error('beforeFirstRename must be a function');
      beforeFirstRename();
    }

    try {
      for (const item of operations) {
        if (item.backupPath) {
          assertAnchorCurrent(item.rootAnchor, item.installRoot, 'Install root');
          assertAnchorCurrent(item.parentAnchor, path.dirname(item.skillPath), 'Skill parent');
          const skillPath = path.join(item.parentAnchor.path, path.basename(item.skillPath));
          const backupPath = path.join(item.parentAnchor.path, path.basename(item.backupPath));
          fs.renameSync(skillPath, backupPath);
          journal.push({ type: 'rename', skillPath, backupPath });
          item.backupIdentity = fs.lstatSync(backupPath, { bigint: true });
          if (!item.backupIdentity.isDirectory() || item.backupIdentity.isSymbolicLink()) {
            throw new Error('Uninstall backup is not a managed directory');
          }
        }
        removed.push(item.skillPath);

        const manifest = manifests.get(item.host);
        const updated = {
          ...manifest,
          skills: manifest.skills.filter((skill) => skill.name !== item.skillName)
        };
        manifests.set(item.host, updated);
      }

      const writtenHosts = new Set();
      for (const item of operations) {
        if (writtenHosts.has(item.host)) continue;
        writtenHosts.add(item.host);
        journal.push({ type: 'manifestWrite', host: item.host, manifestPath: item.manifestPath });
        writeManifestImpl(item.manifestPath, manifests.get(item.host));
      }
    } catch (cause) {
      const rollbackErrors = rollbackUninstall(journal, previousManifestFiles);
      for (const [host, manifest] of previousManifestValues) manifests.set(host, manifest);
      if (rollbackErrors.length > 0) cause.rollbackErrors = rollbackErrors;
      throw cause;
    }

    for (const item of operations) {
      if (!item.backupPath) continue;
      try {
        removeIdentityBoundBackup({
          parentAnchor: item.parentAnchor,
          backupName: path.basename(item.backupPath),
          backupIdentity: item.backupIdentity,
          removeBackupImpl
        });
      } catch (cause) {
        let cleanupReference = null;
        try {
          cleanupReference = createCleanupReference(item);
        } catch { /* committed state remains authoritative; retry will fail closed without a reference */ }
        cleanupWarnings.push(Object.freeze({
          host: item.host,
          installRoot: item.installRoot,
          backupPath: item.backupPath,
          cleanupReference,
          code: typeof cause?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(cause.code) ? cause.code : 'CLEANUP_FAILED',
          message: cleanupReference
            ? 'Uninstall committed but backup cleanup failed; retry using the bounded cleanup reference.'
            : 'Uninstall committed but backup cleanup failed; no safe retry reference is available.'
        }));
      }
    }

    return {
      status: cleanupWarnings.length > 0 ? 'COMMITTED_WITH_CLEANUP_WARNING' : 'COMMITTED',
      removed,
      cleanupWarnings
    };
  } finally {
    closeMutationAnchors(operations);
  }
}
