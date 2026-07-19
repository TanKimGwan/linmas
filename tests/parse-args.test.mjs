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

test('parses explicit review file and provider options', () => {
  assert.deepEqual(parseArgv([
    'node', 'linmas', 'review', '--skill', 'secure-code-reviewer',
    '--input', 'patch.diff', '--provider', 'claude', '--model', 'model-id',
    '--output', 'json', '--capsule', 'review-capsule.json', '--yes'
  ]), {
    command: 'review', skillName: 'secure-code-reviewer', installAll: false,
    dryRun: false, inputPath: 'patch.diff', useStdin: false,
    provider: 'claude', model: 'model-id', output: 'json', assumeYes: true,
    policyId: null, policyFile: null, capsulePath: 'review-capsule.json'
  });
});

test('parses exactly one policy source', () => {
  const args = parseArgv(['node', 'linmas', 'review', '--policy', 'baseline-appsec']);
  assert.equal(args.policyId, 'baseline-appsec');
  assert.equal(args.policyFile, null);
});

test('parses review stdin without treating flag values as positional skills', () => {
  const args = parseArgv(['node', 'linmas', 'review', '--stdin', '--skill', 'cloud-hardening-architect']);
  assert.equal(args.useStdin, true);
  assert.equal(args.skillName, 'cloud-hardening-architect');
  assert.equal(args.provider, null);
});

test('parses offline review capsule comparison', () => {
  const args = parseArgv(['node', 'linmas', 'review', 'compare', 'before.json', 'after.json', '--output', 'json']);
  assert.equal(args.reviewAction, 'compare');
  assert.equal(args.compareBefore, 'before.json');
  assert.equal(args.compareAfter, 'after.json');
  assert.equal(args.output, 'json');
  assert.equal(args.provider, null);
});

test('parses proof create and verify subcommands without changing legacy review shape', () => {
  assert.deepEqual(parseArgv(['node', 'linmas', 'proof', 'create', 'capsule.json', '--bundle', 'proof', '--signing-key', 'key']), {
    command: 'proof', proofAction: 'create', proofSource: 'capsule.json', proofBundle: 'proof', signingKey: 'key', allowedSigners: null, proofErrors: [],
    skillName: null, installAll: false, dryRun: false, inputPath: null, useStdin: false,
    provider: null, model: null, output: 'text', assumeYes: false, policyId: null, policyFile: null, capsulePath: null
  });
  const verify = parseArgv(['node', 'linmas', 'proof', 'verify', 'proof', '--output', 'json', '--allowed-signers', 'allowed']);
  assert.equal(verify.proofAction, 'verify');
  assert.equal(verify.proofSource, 'proof');
  assert.equal(verify.output, 'json');
  assert.equal(verify.allowedSigners, 'allowed');
});
