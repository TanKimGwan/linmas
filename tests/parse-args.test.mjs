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

test('rejects options outside each command schema', () => {
  for (const argv of [
    ['node', 'linmas', 'list', '--provider', 'codex'],
    ['node', 'linmas', 'install', '--providre', 'codex'],
    ['node', 'linmas', 'review', '--providre', 'codex'],
    ['node', 'linmas', 'proof', 'verify', 'bundle', '--bundle', 'other']
  ]) {
    assert.throws(() => parseArgv(argv), /unknown option/i);
  }
});

test('rejects a missing option value', () => {
  assert.throws(
    () => parseArgv(['node', 'linmas', 'review', '--provider']),
    /argument missing|requires a value/i
  );
  assert.throws(
    () => parseArgv(['node', 'linmas', 'review', '--provider=']),
    /provider.*non-empty|non-empty.*provider/i
  );
});

test('rejects duplicate singleton options', () => {
  assert.throws(
    () => parseArgv(['node', 'linmas', 'review', '--provider', 'codex', '--provider', 'claude']),
    /duplicate option.*provider/i
  );
});

test('rejects unexpected positional arguments', () => {
  assert.throws(
    () => parseArgv(['node', 'linmas', 'review', 'compare', 'before.json', 'after.json', 'extra.json']),
    /unexpected.*argument/i
  );
});

test('preserves option terminator semantics for dash-prefixed positionals', () => {
  const args = parseArgv(['node', 'linmas', 'install', '--', '--literal-skill-name']);
  assert.equal(args.skillName, '--literal-skill-name');
  assert.equal(args.installAll, false);
});

test('parses repeated scoped install selections and aliases', () => {
  const args = parseArgv(['node', 'linmas', 'install', '--skill', 'linmas-secure-code-reviewer', '--skill', 'security-domain-router', '-a', 'claude-code', '--agent', 'codex', '--project', '/tmp/project', '--copy', '-y']);
  assert.deepEqual(args.skillNames, ['linmas-secure-code-reviewer', 'security-domain-router']);
  assert.deepEqual(args.agents, ['claude-code', 'codex']);
  assert.equal(args.scope, 'project');
  assert.equal(args.projectPath, '/tmp/project');
  assert.equal(args.method, 'copy');
  assert.equal(args.assumeYes, true);
  assert.equal(args.managedInstall, true);
});

test('bare install selects the interactive managed flow and dry-run accepts incomplete choice flags', () => {
  assert.equal(parseArgv(['node', 'linmas', 'install']).managedInstall, true);
  const dryRun = parseArgv(['node', 'linmas', 'install', '--dry-run']);
  assert.equal(dryRun.managedInstall, true);
  assert.equal(dryRun.dryRun, true);
});

test('project, scope, method and agent conflicts fail at the CLI trust boundary', () => {
  assert.throws(() => parseArgv(['node', 'linmas', 'install', '--scope', 'global', '--project', '/tmp/project']), /cannot be combined/i);
  assert.throws(() => parseArgv(['node', 'linmas', 'install', '--method', 'hardlink']), /invalid --method/i);
  assert.throws(() => parseArgv(['node', 'linmas', 'install', '--scope', 'workspace']), /invalid --scope/i);
  assert.throws(() => parseArgv(['node', 'linmas', 'install', '--skill', 'one', '--all']), /either a skill or --all/i);
});

test('scoped doctor and uninstall flags route to the managed scope', () => {
  assert.equal(parseArgv(['node', 'linmas', 'doctor', '--project', '/tmp/project']).scope, 'project');
  const uninstall = parseArgv(['node', 'linmas', 'uninstall', 'linmas-secure-code-reviewer', '--agent', 'claude', '--scope', 'project', '--yes']);
  assert.equal(uninstall.managedUninstall, true);
  assert.equal(uninstall.scope, 'project');
  assert.deepEqual(uninstall.agents, ['claude']);
});

test('single-skill legacy commands keep v1 routing unless scoped options are supplied', () => {
  assert.equal(parseArgv(['node', 'linmas', 'install', '--skill', 'linmas-secure-code-reviewer']).managedInstall, false);
  assert.equal(parseArgv(['node', 'linmas', 'uninstall', '--skill', 'linmas-secure-code-reviewer']).managedUninstall, false);
  assert.equal(parseArgv(['node', 'linmas', 'install', '--skill', 'linmas-secure-code-reviewer', '--agent', 'codex']).managedInstall, true);
});
