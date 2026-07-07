import fs from 'node:fs';
import path from 'node:path';
import { assertInsideRoot, backupDirectory, copySkillDirectory } from './fs-utils.mjs';
import { upsertManagedSkill, writeManifest } from './manifest.mjs';

export function selectSkills(skills, { skillName, installAll }) {
  if (installAll) return skills;
  if (!skillName) throw new Error('install requires a skill name or --all');

  const match = skills.find((skill) => skill.name === skillName);
  if (!match) throw new Error(`unknown skill: ${skillName}`);
  return [match];
}

export function selectTargets(detections, choice) {
  const detected = detections.filter((item) => item.status === 'detected');
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

export async function promptForInstallChoices(io, detections, skills) {
  void io;
  void skills;

  const detected = detections.filter((item) => item.status === 'detected');
  if (detected.length === 0) {
    throw new Error('No writable target hosts detected. Install aborted.');
  }

  return {
    targetChoice: detected.length > 1 ? 'both' : detected[0].host,
    confirm: false
  };
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

export function applyInstallPlan(plan, manifests, manifestPathByHost) {
  const written = [];
  const backups = [];

  const getManifestPath = (host) => {
    if (typeof manifestPathByHost === 'string') {
      return manifestPathByHost;
    }
    if (manifestPathByHost instanceof Map) {
      return manifestPathByHost.get(host);
    }
    if (manifestPathByHost && typeof manifestPathByHost === 'object') {
      return manifestPathByHost[host];
    }
    throw new Error(`Invalid manifestPathByHost: ${manifestPathByHost}`);
  };

  for (const item of plan) {
    const manifestPath = getManifestPath(item.host);
    const hostRoot = path.dirname(manifestPath);

    assertInsideRoot(hostRoot, item.destinationDir);
    if (item.backupDir) {
      assertInsideRoot(hostRoot, item.backupDir);
    }

    if (item.backupDir && fs.existsSync(item.destinationDir)) {
      backupDirectory(item.destinationDir, item.backupDir);
      backups.push(item.backupDir);
    }

    copySkillDirectory(item.skill.sourceDir, item.destinationDir);
    written.push(item.destinationDir);

    // Update in-memory manifest (written to disk once per host below)
    const manifest = manifests.get(item.host);
    const updated = upsertManagedSkill(manifest, {
      name: item.skill.name,
      skillPath: item.destinationDir,
      backupPath: item.backupDir
    });
    manifests.set(item.host, updated);
  }

  // Write manifests once per host after all files are copied
  const hostWrites = new Set();
  for (const item of plan) {
    if (!hostWrites.has(item.host)) {
      hostWrites.add(item.host);
      const manifestPath = getManifestPath(item.host);
      writeManifest(manifestPath, manifests.get(item.host));
    }
  }

  return { written, backups };
}

