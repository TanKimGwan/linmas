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
