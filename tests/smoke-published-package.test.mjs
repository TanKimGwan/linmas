import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { USAGE, buildCommands, resolveVersion } from '../scripts/smoke-published-package.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(rootDir, 'scripts/smoke-published-package.mjs');

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
}

test('smoke-published-package script exists', () => {
  assert.equal(fs.existsSync(scriptPath), true);
});

test('smoke-published-package --help prints usage', () => {
  const output = execFileSync(process.execPath, [scriptPath, '--help'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  assert.equal(output.trim(), USAGE);
});

test('resolveVersion defaults to package version and validates explicit versions', () => {
  const pkg = readPackage();
  assert.equal(resolveVersion([], pkg.version), pkg.version);
  assert.equal(resolveVersion(['0.1.6'], pkg.version), '0.1.6');
  assert.equal(resolveVersion(['--help'], pkg.version), null);
  assert.throws(() => resolveVersion(['latest'], pkg.version), /expected version in x\.y\.z form/);
});

test('buildCommands produces safe published-package smoke commands', () => {
  const commands = buildCommands('0.1.6');
  assert.deepEqual(commands, [
    {
      label: 'npx -y linmas@0.1.6 --help',
      command: 'npx',
      args: ['-y', 'linmas@0.1.6', '--help']
    },
    {
      label: 'npm exec --yes --package linmas@0.1.6 -- linmas --help',
      command: 'npm',
      args: ['exec', '--yes', '--package', 'linmas@0.1.6', '--', 'linmas', '--help']
    }
  ]);
});
