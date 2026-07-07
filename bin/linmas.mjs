#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgv } from '../src/cli/parse-args.mjs';
import { listSkills } from '../src/core/list-skills.mjs';
import { detectHosts } from '../src/core/detect-hosts.mjs';
import { readManifest } from '../src/core/manifest.mjs';
import { formatDoctorReport } from '../src/core/doctor.mjs';
import { formatOnboarding } from '../src/core/onboard.mjs';
import { selectSkills, selectTargets, planInstall, formatInstallPreview, formatInstallSummary, applyInstallPlan, promptForInstallChoices, promptForInstallTarget, promptForInstallConfirmation } from '../src/core/install-skills.mjs';
import { createTimestamp } from '../src/core/fs-utils.mjs';
import { planUninstall, formatUninstallPreview, applyUninstallPlan, promptForUninstallChoices, promptForUninstallTarget, promptForUninstallConfirmation } from '../src/core/uninstall-skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const modulePath = fileURLToPath(import.meta.url);

export async function run(argv, io = process) {
  const args = parseArgv(argv);

  if (args.command === 'list') {
    const skills = listSkills(rootDir);
    io.stdout.write('Available Linmas skills:\n');
    for (const skill of skills) {
      io.stdout.write(`- ${skill.name} — ${skill.description}\n`);
    }
    return 0;
  }

  if (args.command === 'detect') {
    const detections = detectHosts();
    for (const detection of detections) {
      io.stdout.write(`${detection.host}: ${detection.status}\n`);
      io.stdout.write(`  reason: ${detection.reason}\n`);
      io.stdout.write(`  target: ${detection.installRoot}\n`);
      io.stdout.write(`  writable: ${detection.writable}\n`);
    }
    return 0;
  }

  if (args.command === 'doctor' || args.command === 'onboard') {
    const detections = detectHosts();
    const manifests = detections.map((item) => readManifest(item.manifestPath, item.host));

    if (args.command === 'doctor') {
      io.stdout.write(formatDoctorReport(detections, manifests));
      return 0;
    }

    const skills = listSkills(rootDir);
    io.stdout.write(formatOnboarding(detections, skills, manifests));
    return 0;
  }

  if (args.command === 'install') {
    try {
      const detections = detectHosts();
      const skills = listSkills(rootDir);
      const manifests = detections.map((item) => readManifest(item.manifestPath, item.host));

      const selectedSkills = selectSkills(skills, args);

      const targetChoice = await promptForInstallTarget(io, detections);
      const selectedTargets = selectTargets(detections, targetChoice);

      const existingPaths = new Set();
      for (const target of selectedTargets) {
        for (const skill of selectedSkills) {
          const dest = path.join(target.installRoot, skill.name);
          if (fs.existsSync(dest)) {
            existingPaths.add(dest);
          }
        }
      }

      const timestamp = createTimestamp();
      const plan = planInstall({
        skills: selectedSkills,
        targets: selectedTargets,
        manifests,
        existingPaths,
        timestamp,
        dryRun: args.dryRun
      });

      io.stdout.write(formatInstallPreview(plan));
      if (args.dryRun) return 0;

      const hasManagedConflicts = plan.some((item) => item.existingState === 'managed');
      const hasUnmanagedConflicts = plan.some((item) => item.existingState === 'unmanaged');

      const { confirm, allowReplaceUnmanaged, allowReplaceManaged } = await promptForInstallConfirmation(
        io,
        { hasManagedConflicts, hasUnmanagedConflicts }
      );

      // Check if we attempted to replace conflict fields without permission
      if (hasManagedConflicts && !allowReplaceManaged) {
        throw new Error('Install aborted due to managed skill conflicts.');
      }
      if (hasUnmanagedConflicts && !allowReplaceUnmanaged) {
        throw new Error('Install aborted due to unmanaged conflicts.');
      }
      if (!confirm) {
        throw new Error('Install cancelled by user.');
      }

      const manifestMap = new Map(manifests.map((manifest) => [manifest.host, manifest]));
      const manifestPathByHost = new Map(detections.map((item) => [item.host, item.manifestPath]));
      applyInstallPlan(plan, manifestMap, manifestPathByHost);
      io.stdout.write(formatInstallSummary(plan));
      return 0;
    } catch (e) {
      io.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
  }

  if (args.command === 'uninstall') {
    try {
      const detections = detectHosts();
      const manifests = detections.map((item) => readManifest(item.manifestPath, item.host));
      const fullPlan = planUninstall({
        manifests,
        detections,
        skillName: args.skillName,
        uninstallAll: args.installAll
      });

      const selectedHosts = await promptForUninstallTarget(io, fullPlan);
      const plan = fullPlan.filter((item) => selectedHosts.includes(item.host));

      io.stdout.write(formatUninstallPreview(plan));
      if (args.dryRun) return 0;

      const confirm = await promptForUninstallConfirmation(io);
      if (!confirm) {
        throw new Error('Uninstall cancelled by user.');
      }

      const manifestMap = new Map(manifests.map((manifest) => [manifest.host, manifest]));
      const manifestPathByHost = new Map(detections.map((item) => [item.host, item.manifestPath]));
      applyUninstallPlan(plan, manifestMap, manifestPathByHost);
      io.stdout.write('Uninstall completed.\n');
      return 0;
    } catch (e) {
      io.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
  }

  io.stderr.write(`Unknown command: ${args.command}\n`);
  return 1;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(modulePath);
  }
}

function createProcessIO(proc) {
  const rl = readline.createInterface({
    input: proc.stdin,
    crlfDelay: Infinity
  });
  const lines = rl[Symbol.asyncIterator]();

  return {
    ...proc,
    async readLine() {
      const { value, done } = await lines.next();
      return done ? '' : value;
    },
    close() {
      rl.close();
    }
  };
}

if (isMainModule()) {
  const io = createProcessIO(process);
  const code = await run(process.argv, io);
  io.close();
  process.exit(code);
}
