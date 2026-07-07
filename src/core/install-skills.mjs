import path from 'node:path';

export function selectSkills(skills, { skillName, installAll }) {
  if (installAll) return skills;
  if (!skillName) throw new Error('install requires a skill name or --all');

  const match = skills.find((skill) => skill.name === skillName);
  if (!match) throw new Error(`unknown skill: ${skillName}`);
  return [match];
}

export function selectTargets(detections, choice) {
  const detected = detections.filter((item) => item.status === 'detected' || item.status === 'probably_detected');
  if (detected.length === 0) {
    throw new Error('No writable target hosts detected. Install aborted.');
  }
  if (choice === 'both') return detected;
  const filtered = detected.filter((item) => item.host === choice);
  if (filtered.length === 0) {
    throw new Error(`Target host ${choice} not detected or not writable.`);
  }
  return filtered;
}

export function planInstall({ skills, targets, manifests, existingPaths = new Set(), timestamp, dryRun }) {
  const managedPaths = new Set(manifests.flatMap((manifest) => manifest.skills.map((skill) => skill.path)));

  return targets.flatMap((target) => skills.map((skill) => {
    const destinationDir = path.join(target.installRoot, skill.name);
    const existingState = existingPaths.has(destinationDir)
      ? (managedPaths.has(destinationDir) ? 'managed' : 'unmanaged')
      : 'missing';

    return {
      host: target.host,
      skill,
      destinationDir,
      existingState,
      backupDir: existingState === 'missing' ? null : path.join(target.rootPath, '.linmas-backups', timestamp, skill.name),
      willWrite: !dryRun
    };
  }));
}

export function formatInstallPreview(plan) {
  const lines = ['Linmas install preview:'];
  for (const item of plan) {
    lines.push(`- ${item.host}: ${item.skill.name} -> ${item.destinationDir}`);
    lines.push(`  existing: ${item.existingState}`);
    lines.push(`  backup: ${item.backupDir ?? 'none'}`);
    lines.push(`  willWrite: ${item.willWrite}`);
  }
  return `${lines.join('\n')}\n`;
}
