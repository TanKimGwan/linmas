import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EXPECTED_SKILLS,
  MANIFEST_SOURCE,
  REPOSITORY_ROOT,
  buildPlugin,
  parseArgs,
  resolveSafeTarget
} from '../scripts/build-codex-plugin.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE_JSON = JSON.parse(await fs.readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const DEFAULT_VALIDATE_PLUGIN = path.join(os.homedir(), '.codex', 'skills', '.system', 'plugin-creator', 'scripts', 'validate_plugin.py');

async function runExternalPluginValidatorIfAvailable(pluginPath) {
  const validator = process.env.LINMAS_VALIDATE_PLUGIN ?? DEFAULT_VALIDATE_PLUGIN;
  try {
    await fs.access(validator);
  } catch (cause) {
    if (process.env.LINMAS_VALIDATE_PLUGIN) {
      throw new Error(`LINMAS_VALIDATE_PLUGIN is not accessible: ${validator}`, { cause });
    }
    return;
  }
  const python = process.env.LINMAS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  await execFileAsync(python, [validator, pluginPath]);
}

async function listDirectories(directory) {
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

test('Codex plugin source inventory contains exactly eleven canonical skills', async () => {
  const sourceSkills = await listDirectories(path.join(REPOSITORY_ROOT, 'skills'));
  assert.equal(EXPECTED_SKILLS.length, 11);
  assert.deepEqual(sourceSkills, [...EXPECTED_SKILLS].sort());

  for (const skillName of EXPECTED_SKILLS) {
    const skillPath = path.join(REPOSITORY_ROOT, 'skills', skillName, 'SKILL.md');
    assert.equal((await fs.lstat(skillPath)).isFile(), true);
  }
});

test('built plugin preserves canonical manifest and every skill byte-for-byte', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-codex-plugin-test-'));
  const target = path.join(tempRoot, 'linmas');

  try {
    await buildPlugin(target);
    assert.deepEqual(await listDirectories(path.join(target, 'skills')), [...EXPECTED_SKILLS].sort());
    assert.deepEqual(
      await fs.readdir(target, { withFileTypes: true }).then((entries) => entries.map((entry) => entry.name).sort()),
      ['.codex-plugin', '.mcp.json', 'mcp', 'package.json', 'policies', 'skills', 'src']
    );
    const template = JSON.parse(await fs.readFile(MANIFEST_SOURCE, 'utf8'));
    const builtManifest = JSON.parse(await fs.readFile(path.join(target, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.deepEqual(builtManifest, { ...template, version: PACKAGE_JSON.version });

    for (const skillName of EXPECTED_SKILLS) {
      assert.equal(
        await sha256(path.join(target, 'skills', skillName, 'SKILL.md')),
        await sha256(path.join(REPOSITORY_ROOT, 'skills', skillName, 'SKILL.md'))
      );
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('canonical manifest has the required MCP metadata and explicit capabilities', async () => {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_SOURCE, 'utf8'));

  assert.equal(manifest.name, 'linmas');
  assert.equal(Object.hasOwn(manifest, 'version'), false);
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.interface.category, 'Security');
  assert.deepEqual(manifest.interface.capabilities, ['Interactive', 'Read', 'Write']);
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(Object.hasOwn(manifest, 'apps'), false);
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
});

test('npm packed artifact contains builder inputs and builds a validated plugin without internal files', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-packed-plugin-test-'));
  const packDestination = path.join(tempRoot, 'pack');
  const extractRoot = path.join(tempRoot, 'extract');
  const targetParent = path.join(tempRoot, 'built');
  await fs.mkdir(packDestination);
  await fs.mkdir(extractRoot);
  await fs.mkdir(targetParent);

  try {
    const { stdout } = await execFileAsync(NPM_COMMAND, ['pack', '--json', '--pack-destination', packDestination], { cwd: REPOSITORY_ROOT });
    const packResult = JSON.parse(stdout)[0];
    const archive = path.join(packDestination, packResult.filename);
    const listing = (await execFileAsync('tar', ['-tzf', archive])).stdout.split('\n').filter(Boolean).map((entry) => entry.replace(/^package\//u, ''));
    assert.ok(listing.includes('plugin/manifest.template.json'));
    for (const forbidden of ['tests/', 'docs/', '.serena/', 'AGENTS.md', 'marketplace', 'gstack/']) {
      assert.equal(listing.some((entry) => entry === forbidden || entry.startsWith(forbidden)), false, `packed artifact must exclude ${forbidden}`);
    }

    await execFileAsync('tar', ['-xzf', archive, '-C', extractRoot]);
    const packedRoot = path.join(extractRoot, 'package');
    const packedBuilder = path.join(packedRoot, 'scripts', 'build-codex-plugin.mjs');
    await execFileAsync(process.execPath, [packedBuilder, '--target', path.join(targetParent, 'linmas')], { cwd: packedRoot });

    const builtRoot = path.join(targetParent, 'linmas');
    assert.equal(JSON.parse(await fs.readFile(path.join(builtRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version, PACKAGE_JSON.version);
    assert.equal((await fs.readdir(path.join(builtRoot, 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).length, 11);
    assert.equal((await fs.lstat(path.join(builtRoot, '.mcp.json'))).isFile(), true);
    assert.equal((await fs.lstat(path.join(builtRoot, 'mcp', 'server.mjs'))).isFile(), true);
    await runExternalPluginValidatorIfAvailable(builtRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('builder rejects missing, broad, traversal, wrong-name, and symlink targets', async () => {
  await assert.rejects(() => resolveSafeTarget(undefined), /target is required/);
  await assert.rejects(() => resolveSafeTarget(REPOSITORY_ROOT), /unsafe target/);
  await assert.rejects(() => resolveSafeTarget('/'), /unsafe target/);
  await assert.rejects(() => resolveSafeTarget('/tmp/not-a-linmas-target'), /final path component/);
  await assert.rejects(
    () => resolveSafeTarget(`${path.dirname(REPOSITORY_ROOT)}/../linmas`),
    /traversal segments/
  );

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-codex-plugin-path-test-'));
  try {
    const symlinkParent = path.join(tempRoot, 'linked-parent');
    const symlinkTarget = path.join(symlinkParent, 'linmas');
    await fs.symlink(tempRoot, symlinkParent, 'dir');
    await assert.rejects(() => resolveSafeTarget(symlinkTarget), /symlink path component/);

    const outside = path.join(tempRoot, 'outside');
    const targetSymlink = path.join(tempRoot, 'linmas');
    await fs.mkdir(outside);
    await fs.symlink(outside, targetSymlink, 'dir');
    await assert.rejects(() => resolveSafeTarget(targetSymlink), /target must not be a symlink/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('builder CLI defaults safely and accepts an explicit target', () => {
  assert.deepEqual(parseArgs(['--target', '/tmp/linmas']), { target: '/tmp/linmas' });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.match(parseArgs([]).target, /[\\/]plugins[\\/]linmas$/);
  assert.throws(() => parseArgs(['/tmp/linmas']), /usage:/);
});
