import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LINMAS_VERSION } from './version.mjs';

export function createEmptyManifest(host, version = '0.1.0') {
  return {
    tool: 'linmas',
    version,
    manifestVersion: 1,
    host,
    installedAt: new Date().toISOString(),
    skills: []
  };
}

export function validateManifest(manifest, expectedHost) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Manifest must be an object`);
  }
  if (!manifest.tool) {
    throw new Error(`Manifest tool is required`);
  }
  if (manifest.tool !== 'linmas') {
    throw new Error(`Manifest tool must be "linmas", got "${manifest.tool}"`);
  }
  if (!manifest.host) {
    throw new Error(`Manifest host is required`);
  }
  if (manifest.host !== expectedHost) {
    throw new Error(`Manifest host mismatch: expected "${expectedHost}", got "${manifest.host}"`);
  }
  if (manifest.manifestVersion !== 1) {
    throw new Error(`Manifest manifestVersion must be 1`);
  }
  if (!Array.isArray(manifest.skills)) {
    throw new Error(`Manifest skills must be an array`);
  }
  for (const skill of manifest.skills) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      throw new Error(`Manifest skill entry must be an object`);
    }
    if (typeof skill.name !== 'string' || !skill.name.trim()) {
      throw new Error(`Manifest skill entry must have a name`);
    }
    if (typeof skill.path !== 'string' || !skill.path.trim()) {
      throw new Error(`Manifest skill entry must have a path`);
    }
    if (skill.backupPath !== null && skill.backupPath !== undefined && typeof skill.backupPath !== 'string') {
      throw new Error(`Manifest skill entry backupPath must be a string or null`);
    }
  }
  return manifest;
}

export function readManifest(manifestPath, host, version = '0.1.0') {
  if (!fs.existsSync(manifestPath)) {
    return createEmptyManifest(host, version);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Manifest at ${manifestPath} contains invalid JSON`);
  }

  return validateManifest(manifest, host);
}

export function writeManifest(manifestPath, manifest) {
  validateManifest(manifest, manifest.host);
  writeManifestSnapshot(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function writeManifestSnapshot(manifestPath, contents) {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.renameSync(tmp, manifestPath);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* preserve the primary write error */ }
  }
}

export function upsertManagedSkill(manifest, { name, skillPath, backupPath = null }) {
  const otherSkills = manifest.skills.filter((skill) => skill.name !== name);
  return {
    ...manifest,
    skills: [...otherSkills, { name, path: skillPath, backupPath }]
  };
}

export function createScopedManifest(scope, version = LINMAS_VERSION) {
  if (!['project', 'global'].includes(scope)) throw new Error(`Invalid manifest scope: ${scope}`);
  return {
    tool: 'linmas', version, manifestVersion: 2, scope,
    installedAt: new Date().toISOString(), skills: []
  };
}

function validateManifestPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function validateScopedManifest(manifest, expectedScope) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Manifest must be an object');
  if (manifest.tool !== 'linmas') throw new Error('Manifest tool must be "linmas"');
  if (manifest.manifestVersion !== 2) throw new Error('Manifest manifestVersion must be 2');
  if (!['project', 'global'].includes(manifest.scope) || manifest.scope !== expectedScope) throw new Error('Manifest scope mismatch');
  if (typeof manifest.version !== 'string' || !manifest.version || !Array.isArray(manifest.skills)) throw new Error('Manifest version and skills are required');

  if (manifest.backups !== undefined) {
    if (!Array.isArray(manifest.backups)) throw new Error('Manifest backups must be an array');
    const backupIds = new Set();
    for (const backup of manifest.backups) {
      if (!backup || typeof backup !== 'object' || Array.isArray(backup)
        || typeof backup.id !== 'string' || !/^[a-f0-9-]{36}$/.test(backup.id)
        || backupIds.has(backup.id)
        || typeof backup.skillId !== 'string' || !/^linmas-[a-z0-9-]+$/.test(backup.skillId)
        || !['claude', 'codex'].includes(backup.host)
        || backup.root !== (backup.host === 'codex' ? 'agents' : 'claude')
        || backup.originalPath !== `skills/${backup.skillId}`
        || backup.backupPath !== `.linmas-backups/${backup.id}`
        || !['unmanaged', 'modified'].includes(backup.state)
        || !['file', 'directory', 'symlink'].includes(backup.entryKind)
        || typeof backup.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(backup.sha256)
        || typeof backup.createdAt !== 'string' || !Number.isFinite(Date.parse(backup.createdAt))) {
        throw new Error('Manifest backup entry is invalid');
      }
      if (expectedScope === 'global' && backup.host === 'claude'
        && (typeof backup.targetRoot !== 'string' || !path.isAbsolute(backup.targetRoot)
          || backup.targetRoot.includes('\0') || path.resolve(backup.targetRoot) !== backup.targetRoot)) {
        throw new Error('Manifest Claude backup root binding is invalid');
      }
      if (!(expectedScope === 'global' && backup.host === 'claude') && backup.targetRoot !== undefined) {
        throw new Error('Manifest backup root binding is unexpected');
      }
      backupIds.add(backup.id);
    }
  }

  const ids = new Set();
  for (const skill of manifest.skills) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)
      || typeof skill.id !== 'string' || !/^linmas-[a-z0-9-]+$/.test(skill.id)
      || !Array.isArray(skill.attachments)) {
      throw new Error('Manifest skill entry is invalid');
    }
      if (skill.retainedReason !== undefined && !['foreign-reference', 'reference-root-unavailable', 'modified'].includes(skill.retainedReason)) {
        throw new Error(`Manifest retained reason is invalid: ${skill.id}`);
      }
      if (skill.attachments.length === 0 && (!skill.canonical || !skill.retainedReason)) {
        throw new Error('Manifest skill entry is invalid');
      }
    if (ids.has(skill.id)) throw new Error(`Manifest has duplicate skill: ${skill.id}`);
    ids.add(skill.id);

    if (skill.canonical !== null) {
      if (!skill.canonical || skill.canonical.root !== 'agents' || !validateManifestPath(skill.canonical.path)
        || skill.canonical.path !== `skills/${skill.id}`
        || typeof skill.canonical.sourceVersion !== 'string' || !skill.canonical.sourceVersion
        || typeof skill.canonical.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(skill.canonical.sha256)) {
        throw new Error(`Manifest canonical path is invalid: ${skill.id}`);
      }
    }

    const hosts = new Set();
    const paths = new Set();
    for (const attachment of skill.attachments) {
      if (!attachment || !['claude', 'codex'].includes(attachment.host)
        || attachment.root !== (attachment.host === 'codex' ? 'agents' : 'claude')
        || !validateManifestPath(attachment.path) || attachment.path !== `skills/${skill.id}`
        || !['copy', 'symlink', 'direct'].includes(attachment.method)
        || typeof attachment.sourceVersion !== 'string' || !attachment.sourceVersion
        || typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(attachment.sha256)) {
        throw new Error(`Manifest attachment is invalid: ${skill.id}`);
      }
      if (expectedScope === 'global' && attachment.host === 'claude'
        && (typeof attachment.targetRoot !== 'string' || !path.isAbsolute(attachment.targetRoot)
          || attachment.targetRoot.includes('\0') || path.resolve(attachment.targetRoot) !== attachment.targetRoot)) {
        throw new Error(`Manifest Claude root binding is invalid: ${skill.id}`);
      }
      if ((attachment.method === 'symlink' && (attachment.host !== 'claude' || !skill.canonical))
        || (attachment.method === 'direct' && (attachment.host !== 'codex' || !skill.canonical))) {
        throw new Error(`Manifest attachment method is invalid: ${skill.id}`);
      }
      const key = `${attachment.root}/${attachment.path}`;
      if (hosts.has(attachment.host) || paths.has(key)) throw new Error(`Manifest has duplicate attachment: ${skill.id}`);
      hosts.add(attachment.host);
      paths.add(key);
    }
  }
  return manifest;
}

export function readScopedManifest(manifestPath, scope, version = LINMAS_VERSION) {
  let stat;
  try { stat = fs.lstatSync(manifestPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return createScopedManifest(scope, version);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Manifest at ${manifestPath} must be a regular file`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { throw new Error(`Manifest at ${manifestPath} contains invalid JSON`); }
  return validateScopedManifest(manifest, scope);
}

export function writeScopedManifest(manifestPath, manifest) {
  validateScopedManifest(manifest, manifest.scope);
  writeManifestSnapshot(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
