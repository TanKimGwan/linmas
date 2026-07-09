#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const USAGE = 'usage: node scripts/smoke-published-package.mjs [version]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isSemver(value) {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}

function resolveVersion(argv, packageVersion) {
  const [arg] = argv;

  if (!arg) {
    return packageVersion;
  }

  if (arg === '--help' || arg === '-h') {
    return null;
  }

  if (!isSemver(arg)) {
    throw new Error(`expected version in x.y.z form, got: ${arg}`);
  }

  return arg;
}

function buildCommands(version) {
  const pkg = `linmas@${version}`;
  return [
    {
      label: `npx -y ${pkg} --help`,
      command: 'npx',
      args: ['-y', pkg, '--help']
    },
    {
      label: `npm exec --yes --package ${pkg} -- linmas --help`,
      command: 'npm',
      args: ['exec', '--yes', '--package', pkg, '--', 'linmas', '--help']
    }
  ];
}

function runCommand(step, cwd) {
  const result = spawnSync(step.command, step.args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';

  if (result.status === 0) {
    console.log(`PASS ${step.label}`);
    if (stdout) {
      console.log(stdout);
    }
    return;
  }

  console.error(`FAIL ${step.label}`);
  if (stdout) {
    console.error(stdout);
  }
  if (stderr) {
    console.error(stderr);
  }
  process.exit(result.status ?? 1);
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const version = resolveVersion(process.argv.slice(2), packageJson.version);

  if (version === null) {
    console.log(USAGE);
    process.exit(0);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-smoke-published-'));

  try {
    console.log(`Smoke testing published package from neutral directory: ${tempDir}`);
    console.log(`Version: ${version}`);
    for (const step of buildCommands(version)) {
      runCommand(step, tempDir);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.message));
}

export { USAGE, buildCommands, isSemver, resolveVersion };
