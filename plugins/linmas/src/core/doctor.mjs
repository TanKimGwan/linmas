import fs from 'node:fs';
import path from 'node:path';
import { resolveSkill } from './skill-catalog.mjs';

export function formatDoctorReport(detections, manifests, existingPaths = new Set()) {
  const lines = ['Linmas doctor report:'];

  for (const detection of detections) {
    lines.push(`- ${detection.host}: ${detection.status} (${detection.reason})`);
    lines.push(`  - target root validity: ${detection.writable ? 'writable' : 'not writable'}`);
  }

  for (const manifest of manifests) {
    lines.push(`- manifest ${manifest.host}: ${manifest.skills.length} tracked skill(s)`);
    const detection = detections.find((d) => d.host === manifest.host);
    const rootPath = detection ? detection.rootPath : null;
    if (rootPath) {
      const backupDir = path.join(rootPath, '.linmas-backups');
      lines.push(`  - backup directory: ${fs.existsSync(backupDir) ? 'present' : 'missing'}`);
    }
    const identities = new Map();
    for (const skill of manifest.skills) {
      const entry = resolveSkill(skill.name);
      if (entry) {
        const names = identities.get(entry.skillId) ?? [];
        names.push(skill.name);
        identities.set(entry.skillId, names);
      }
      const state = existingPaths.has(skill.path) || fs.existsSync(skill.path) ? 'present on disk' : 'missing on disk';
      lines.push(`  - ${skill.name}: ${state}`);
      if (entry && skill.name !== entry.skillId) {
        lines.push(`    legacy installation: supported; reinstall explicitly to use ${entry.skillId}`);
      }
      if (state === 'missing on disk') {
        lines.push('    mismatch: tracked by manifest but missing on disk');
      }
    }
    for (const names of identities.values()) {
      if (names.length > 1) lines.push(`  - duplicate canonical and legacy installations: ${names.join(', ')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
