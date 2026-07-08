#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  let expectedHash = null;
  let targetPath = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      expectedHash = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      fail(`unknown option: ${arg}`);
    }
    targetPath = arg;
  }

  if (!targetPath) {
    fail('usage: node scripts/verify-checksum.mjs [--check <expected-hash>] <file-or-directory>');
  }

  return { expectedHash, targetPath };
}

function resolveFilePath(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return targetPath;
  }
  if (!stat.isDirectory()) {
    fail('target path must be a file or directory');
  }

  const tgzFiles = fs.readdirSync(targetPath)
    .filter((entry) => entry.endsWith('.tgz'))
    .sort();

  if (tgzFiles.length !== 1) {
    fail('directory must contain exactly one .tgz file');
  }

  return path.join(targetPath, tgzFiles[0]);
}

function computeSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

const { expectedHash, targetPath } = parseArgs(process.argv.slice(2));
const filePath = resolveFilePath(targetPath);
const actualHash = computeSha256(filePath);

if (expectedHash === null) {
  console.log(actualHash);
} else if (actualHash === expectedHash) {
  console.log('OK');
} else {
  fail(`expected ${expectedHash}, got ${actualHash}`);
}
