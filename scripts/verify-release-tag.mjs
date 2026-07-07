#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i + 1] !== undefined) {
    args.set(process.argv[i], process.argv[i + 1]);
  }
}

const tag = args.get('--tag') || '';
const versionFile = args.get('--version-file') || 'package.json';
const mainRef = args.get('--main-ref') || 'origin/main';

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('invalid tag format');
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
} catch (e) {
  console.error(`failed to read or parse version file: ${e.message}`);
  process.exit(1);
}

if (typeof pkg?.version !== 'string') {
  console.error('package version must be a string');
  process.exit(1);
}

if (`v${pkg.version}` !== tag) {
  console.error('tag does not match package version');
  process.exit(1);
}

let tagCommit;
try {
  tagCommit = execFileSync('git', ['rev-list', '-n', '1', tag], { encoding: 'utf8' }).trim();
} catch {
  console.error('failed to resolve tag commit');
  process.exit(1);
}

try {
  execFileSync('git', ['merge-base', '--is-ancestor', tagCommit, mainRef], { stdio: 'ignore' });
} catch {
  console.error('tagged commit is not on main');
  process.exit(1);
}
