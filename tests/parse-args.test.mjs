import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv } from '../src/cli/parse-args.mjs';

test('parseArgv parses list command by default', () => {
  const result = parseArgv(['node', 'bin/linmas.mjs']);
  assert.equal(result.command, 'list');
  assert.equal(result.skillName, null);
  assert.equal(result.installAll, false);
  assert.equal(result.dryRun, false);
});

test('parseArgv parses command and skill name', () => {
  const result = parseArgv(['node', 'bin/linmas.mjs', 'install', 'security-operations-lead']);
  assert.equal(result.command, 'install');
  assert.equal(result.skillName, 'security-operations-lead');
  assert.equal(result.installAll, false);
  assert.equal(result.dryRun, false);
});

test('parseArgv parses flags', () => {
  const result = parseArgv(['node', 'bin/linmas.mjs', 'install', '--all', '--dry-run']);
  assert.equal(result.command, 'install');
  assert.equal(result.skillName, null);
  assert.equal(result.installAll, true);
  assert.equal(result.dryRun, true);
});

test('parseArgv parses flags and positional skill names independently', () => {
  const result = parseArgv(['node', 'bin/linmas.mjs', 'install', '--dry-run', 'security-operations-lead']);
  assert.equal(result.command, 'install');
  assert.equal(result.skillName, 'security-operations-lead');
  assert.equal(result.installAll, false);
  assert.equal(result.dryRun, true);
});
