import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
