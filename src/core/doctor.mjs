import fs from 'node:fs';
import path from 'node:path';

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
    for (const skill of manifest.skills) {
      const state = existingPaths.has(skill.path) || fs.existsSync(skill.path) ? 'present on disk' : 'missing on disk';
      lines.push(`  - ${skill.name}: ${state}`);
      if (state === 'missing on disk') {
        lines.push('    mismatch: tracked by manifest but missing on disk');
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
