import fs from 'node:fs';
import path from 'node:path';

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

export function readManifest(manifestPath, host, version = '0.1.0') {
  if (!fs.existsSync(manifestPath)) {
    return createEmptyManifest(host, version);
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return createEmptyManifest(host, version);
  }
}

export function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function upsertManagedSkill(manifest, { name, skillPath, backupPath = null }) {
  const otherSkills = manifest.skills.filter((skill) => skill.name !== name);
  return {
    ...manifest,
    skills: [...otherSkills, { name, path: skillPath, backupPath }]
  };
}

