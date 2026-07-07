#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv } from '../src/cli/parse-args.mjs';
import { listSkills } from '../src/core/list-skills.mjs';
import { detectHosts } from '../src/core/detect-hosts.mjs';
import { readManifest } from '../src/core/manifest.mjs';
import { formatDoctorReport } from '../src/core/doctor.mjs';
import { formatOnboarding } from '../src/core/onboard.mjs';
import { selectSkills, selectTargets, planInstall, formatInstallPreview } from '../src/core/install-skills.mjs';

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
    const skills = listSkills(rootDir);

    if (args.command === 'doctor') {
      io.stdout.write(formatDoctorReport(detections, manifests));
      return 0;
    }

    io.stdout.write(formatOnboarding(detections, skills, manifests));
    return 0;
  }

  if (args.command === 'install') {
    if (!args.dryRun) {
      io.stderr.write('Error: actual installs not implemented yet. Use --dry-run for preview.\n');
      return 1;
    }
    try {
      const detections = detectHosts();
      const skills = listSkills(rootDir);
      const manifests = detections.map((item) => readManifest(item.manifestPath, item.host));

      const selectedSkills = selectSkills(skills, args);

      // Determine targets choice:
      // If no host is detected/writable, selectTargets will throw.
      // Default choice logic:
      // If more than 1 detected, use 'both', otherwise find the detected one.
      const detected = detections.filter(d => d.status === 'detected' || d.status === 'probably_detected');
      let targetChoice = 'both';
      if (detected.length === 1) {
        targetChoice = detected[0].host;
      } else if (detected.length === 0) {
        io.stderr.write('Error: No writable target hosts detected. Install aborted.\n');
        return 1;
      }

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

      const plan = planInstall({
        skills: selectedSkills,
        targets: selectedTargets,
        manifests,
        existingPaths,
        timestamp: 'dry-run',
        dryRun: args.dryRun
      });

      io.stdout.write(formatInstallPreview(plan));
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

if (isMainModule()) {
  const code = await run(process.argv, process);
  process.exit(code);
}
