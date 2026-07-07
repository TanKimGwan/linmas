import fs from 'node:fs';

export function formatDoctorReport(detections, manifests, existingPaths = new Set()) {
  const lines = ['Linmas doctor report:'];

  for (const detection of detections) {
    lines.push(`- ${detection.host}: ${detection.status} (${detection.reason})`);
  }

  for (const manifest of manifests) {
    lines.push(`- manifest ${manifest.host}: ${manifest.skills.length} tracked skill(s)`);
    for (const skill of manifest.skills) {
      const state = existingPaths.has(skill.path) || fs.existsSync(skill.path) ? 'present on disk' : 'missing on disk';
      lines.push(`  - ${skill.name}: ${state}`);
    }
  }

  return `${lines.join('\n')}\n`;
}