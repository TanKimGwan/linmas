import fs from 'node:fs';
import path from 'node:path';
import { assertInsideRoot, backupDirectory, copySkillDirectory } from './fs-utils.mjs';
import { upsertManagedSkill, writeManifest, writeManifestSnapshot, validateManifest } from './manifest.mjs';

export function selectSkills(skills, { skillName, installAll }) {
  if (installAll) return skills;
  if (!skillName) throw new Error('install requires a skill name or --all');

  const match = skills.find((skill) => skill.name === skillName || skill.legacyAliases?.includes(skillName));
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

export async function promptForInstallTarget(io, detections) {
  const detected = detections.filter((item) => item.status === 'detected');
  if (detected.length === 0) {
    throw new Error('No writable target hosts detected. Install aborted.');
  }

  let targetChoice = detected.length > 1 ? 'both' : detected[0].host;

  if (io && typeof io.readLine === 'function' && detected.length > 1) {
    io.stdout.write('Choose target host: [1] Claude [2] Codex [3] Both\n');
    const line = await io.readLine();
    if (line !== null) {
      const ans = line.trim();
      if (ans === '1') targetChoice = 'claude';
      else if (ans === '2') targetChoice = 'codex';
      else targetChoice = 'both';
    }
  }

  return targetChoice;
}

export async function promptForInstallConfirmation(io, options = {}) {
  let confirm = false;
  let allowReplaceUnmanaged = false;
  let allowReplaceManaged = false;

  if (io && typeof io.readLine === 'function') {
    if (options.hasManagedConflicts) {
      io.stdout.write('Replace managed skills? [replace/cancel]\n');
      const line = await io.readLine();
      if (line !== null && line.trim() === 'replace') {
        allowReplaceManaged = true;
      } else {
        return {
          confirm,
          allowReplaceUnmanaged,
          allowReplaceManaged
        };
      }
    }
    if (options.hasUnmanagedConflicts) {
      io.stdout.write('Replace unmanaged files? [replace/cancel]\n');
      const line = await io.readLine();
      if (line !== null && line.trim() === 'replace') {
        allowReplaceUnmanaged = true;
      } else {
        return {
          confirm,
          allowReplaceUnmanaged,
          allowReplaceManaged
        };
      }
    }

    io.stdout.write('Confirm installation? [yes/no]\n');
    const line = await io.readLine();
    if (line !== null) {
      const ans = line.trim();
      if (ans === 'yes' || ans === 'y') confirm = true;
    }
  }

  return {
    confirm,
    allowReplaceUnmanaged,
    allowReplaceManaged
  };
}

export async function promptForInstallChoices(io, detections, skills, options = {}) {
  const targetChoice = await promptForInstallTarget(io, detections);
  const confirmation = await promptForInstallConfirmation(io, options);
  return {
    targetChoice,
    ...confirmation
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

export function formatInstallSummary(plan) {
  const lines = ['Install completed.'];
  const written = plan.filter((item) => item.willWrite);
  if (written.length > 0) {
    lines.push('Installed skills:');
    for (const item of written) {
      lines.push(`- ${item.skill.name} on host ${item.host} (${item.skill.description})`);
      lines.push(`  destination: ${item.destinationDir}`);
      lines.push(`  Installed: ${item.skill.name}`);
    }
    lines.push(
      '',
      'Next steps:',
      '- verify the installation on each target host',
      '- run `npx linmas doctor` to diagnose installation integrity',
      '- run `npx linmas uninstall <skill>` to remove any installed skill'
    );
  }
  return `${lines.join('\n')}\n`;
}

function resolveManifestPath(host, manifestPathByHost) {
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
}

export function preflightInstall(plan, manifests, manifestPathByHost) {
  if (!Array.isArray(plan)) throw new Error('Install plan must be an array');
  if (!(manifests instanceof Map)) throw new Error('Install manifests must be a Map');

  for (const item of plan) {
    if (!item || typeof item !== 'object' || !item.host) throw new Error('Install plan item must include a host');
    if (!manifests.has(item.host)) throw new Error(`No manifest for host: ${item.host}`);
    validateManifest(manifests.get(item.host), item.host);

    const manifestPath = resolveManifestPath(item.host, manifestPathByHost);
    if (typeof manifestPath !== 'string' || !manifestPath) throw new Error(`No manifest path for host: ${item.host}`);
    const hostRoot = path.dirname(manifestPath);

    assertInsideRoot(hostRoot, item.destinationDir);
    if (item.backupDir) {
      assertInsideRoot(hostRoot, item.backupDir);
      if (fs.existsSync(item.backupDir)) throw new Error(`Backup destination already exists: ${item.backupDir}`);
    } else if (fs.existsSync(item.destinationDir)) {
      throw new Error(`Existing destination requires a backup path: ${item.destinationDir}`);
    }

    if (!item.skill || typeof item.skill !== 'object') throw new Error(`Skill is required for host: ${item.host}`);
    if (!fs.existsSync(item.skill.sourceDir) || !fs.statSync(item.skill.sourceDir).isDirectory()) throw new Error(`Skill source directory missing: ${item.skill.sourceDir}`);
    if (!fs.existsSync(item.skill.skillFile) || !fs.statSync(item.skill.skillFile).isFile()) throw new Error(`Skill file missing: ${item.skill.skillFile}`);
  }
}

function rollbackInstall(journal, manifestPathByHost, previousManifestFiles) {
  const errors = [];
  for (let i = journal.length - 1; i >= 0; i--) {
    const entry = journal[i];
    try {
      switch (entry.type) {
        case 'manifestWrite': {
          const previous = previousManifestFiles.get(entry.host);
          const manifestPath = resolveManifestPath(entry.host, manifestPathByHost);
          if (previous?.exists) writeManifestSnapshot(manifestPath, previous.contents);
          else fs.rmSync(manifestPath, { force: true });
          break;
        }
        case 'copy': {
          if (entry.created) {
            fs.rmSync(entry.dest, { recursive: true, force: true });
          }
          break;
        }
        case 'backup': {
          // Restore backup to original destination
          fs.rmSync(entry.dest, { recursive: true, force: true });
          fs.cpSync(entry.backup, entry.dest, { recursive: true, force: true });
          fs.rmSync(entry.backup, { recursive: true, force: true });
          break;
        }
      }
    } catch (error) { errors.push(error); }
  }
  return errors;
}

export function applyInstallPlan(plan, manifests, manifestPathByHost, {
  backupDirectoryImpl = backupDirectory,
  copySkillDirectoryImpl = copySkillDirectory,
  writeManifestImpl = writeManifest
} = {}) {
  const written = [];
  const backups = [];
  const journal = [];
  const previousManifestFiles = new Map();
  const previousManifestValues = new Map();

  // Preflight: validate everything before any mutation
  preflightInstall(plan, manifests, manifestPathByHost);
  for (const item of plan) {
    if (!previousManifestValues.has(item.host)) previousManifestValues.set(item.host, structuredClone(manifests.get(item.host)));
  }

  // Phase 1: execute operations with journaling
  try {
    for (const item of plan) {
      // Backup existing state before mutation
      if (item.backupDir && fs.existsSync(item.destinationDir)) {
        try {
          backupDirectoryImpl(item.destinationDir, item.backupDir);
        } catch (cause) {
          try { fs.rmSync(item.backupDir, { recursive: true, force: true }); } catch { /* preserve backup error */ }
          throw cause;
        }
        journal.push({ type: 'backup', dest: item.destinationDir, backup: item.backupDir });
        backups.push(item.backupDir);
      }

      const destCreated = !fs.existsSync(item.destinationDir);
      journal.push({ type: 'copy', dest: item.destinationDir, created: destCreated });
      copySkillDirectoryImpl(item.skill.sourceDir, item.destinationDir);
      written.push(item.destinationDir);

      // Update in-memory manifest
      const manifest = manifests.get(item.host);
      const updated = upsertManagedSkill(manifest, {
        name: item.skill.name,
        skillPath: item.destinationDir,
        backupPath: item.backupDir
      });
      manifests.set(item.host, updated);
    }

    // Phase 2: write manifests atomically (once per host)
    const hostWrites = new Set();
    for (const item of plan) {
      if (!hostWrites.has(item.host)) {
        hostWrites.add(item.host);
        const host = item.host;
        const manifestPath = resolveManifestPath(host, manifestPathByHost);
        if (!previousManifestFiles.has(host)) {
          try {
            const prev = fs.readFileSync(manifestPath, 'utf8');
            previousManifestFiles.set(host, { exists: true, contents: prev });
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            previousManifestFiles.set(host, { exists: false, contents: null });
          }
        }
        journal.push({ type: 'manifestWrite', host, manifestPath });
        writeManifestImpl(manifestPath, manifests.get(host));
      }
    }
  } catch (cause) {
    const rollbackErrors = rollbackInstall(journal, manifestPathByHost, previousManifestFiles);
    for (const [host, manifest] of previousManifestValues) manifests.set(host, manifest);
    if (rollbackErrors.length > 0) cause.rollbackErrors = rollbackErrors;
    throw cause;
  }

  return { written, backups };
}
