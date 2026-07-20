import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BRAND_ASSETS_SOURCE,
  BRAND_COLOR,
  EXPECTED_SKILLS,
  MANIFEST_SOURCE,
  REPOSITORY_ROOT,
  buildPlugin,
  parseArgs,
  resolveSafeTarget
} from '../scripts/build-codex-plugin.mjs';
import { PUBLIC_PLUGIN_ROOT } from '../scripts/sync-codex-marketplace.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE_JSON = JSON.parse(await fs.readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
const DEFAULT_VALIDATE_PLUGIN = path.join(os.homedir(), '.codex', 'skills', '.system', 'plugin-creator', 'scripts', 'validate_plugin.py');
const MARKETPLACE_FILE = path.join(REPOSITORY_ROOT, '.agents', 'plugins', 'marketplace.json');

async function runNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileAsync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return execFileAsync('npm', args, options);
}

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

async function listRegularFiles(root, relativeRoot = '') {
  const files = [];
  const entries = await fs.readdir(path.join(root, relativeRoot), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isSymbolicLink()) {
      assert.fail(`public plugin artifact must not contain symlinks: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listRegularFiles(root, relativePath));
    } else {
      assert.equal(entry.isFile(), true, `public plugin entry must be a regular file: ${relativePath}`);
      files.push(relativePath.replaceAll('\\', '/'));
    }
  }
  return files;
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
      ['.codex-plugin', '.mcp.json', 'assets', 'mcp', 'package.json', 'policies', 'skills', 'src']
    );
    const template = JSON.parse(await fs.readFile(MANIFEST_SOURCE, 'utf8'));
    const builtManifest = JSON.parse(await fs.readFile(path.join(target, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.deepEqual(builtManifest, { ...template, version: PACKAGE_JSON.version });

    for (const skillName of EXPECTED_SKILLS) {
      assert.equal(
        await sha256(path.join(target, 'skills', skillName, 'SKILL.md')),
        await sha256(path.join(REPOSITORY_ROOT, 'skills', skillName, 'SKILL.md'))
      );
      const agentManifest = await fs.readFile(path.join(target, 'skills', skillName, 'agents', 'openai.yaml'), 'utf8');
      assert.match(agentManifest, /^interface:/m);
      assert.match(agentManifest, /icon_small: "\.\/assets\/icon-small\.png"/);
      assert.match(agentManifest, /icon_large: "\.\/assets\/icon-large\.png"/);
      assert.match(agentManifest, new RegExp(`brand_color: "${BRAND_COLOR}"`));
      assert.equal(
        await sha256(path.join(target, 'skills', skillName, 'assets', 'icon-small.png')),
        await sha256(path.join(BRAND_ASSETS_SOURCE, 'linmas-logo-dark.png'))
      );
      assert.equal(
        await sha256(path.join(target, 'skills', skillName, 'assets', 'icon-large.png')),
        await sha256(path.join(BRAND_ASSETS_SOURCE, 'linmas-logo-dark.png'))
      );
    }

    assert.equal(
      await sha256(path.join(target, 'assets', 'linmas-logo.png')),
      await sha256(path.join(BRAND_ASSETS_SOURCE, 'linmas-logo.png'))
    );
    assert.equal(
      await sha256(path.join(target, 'assets', 'linmas-logo-dark.png')),
      await sha256(path.join(BRAND_ASSETS_SOURCE, 'linmas-logo-dark.png'))
    );
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
  assert.equal(manifest.interface.websiteURL, 'https://github.com/TanKimGwan/linmas');
  assert.equal(manifest.interface.brandColor, BRAND_COLOR);
  assert.equal(manifest.interface.composerIcon, './assets/linmas-logo-dark.png');
  assert.equal(manifest.interface.logo, './assets/linmas-logo.png');
  assert.equal(manifest.interface.logoDark, './assets/linmas-logo-dark.png');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(Object.hasOwn(manifest, 'apps'), false);
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
});

test('public Git marketplace exposes a byte-identical validated Linmas plugin', async () => {
  const marketplace = JSON.parse(await fs.readFile(MARKETPLACE_FILE, 'utf8'));
  assert.deepEqual(marketplace, {
    name: 'linmas',
    interface: { displayName: 'Linmas Security' },
    plugins: [{
      name: 'linmas',
      source: { source: 'local', path: './plugins/linmas' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Security'
    }]
  });

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-public-marketplace-test-'));
  const freshPlugin = path.join(tempRoot, 'linmas');
  try {
    await buildPlugin(freshPlugin);
    const trackedFiles = await listRegularFiles(PUBLIC_PLUGIN_ROOT);
    const freshFiles = await listRegularFiles(freshPlugin);
    assert.deepEqual(trackedFiles, freshFiles);
    for (const relativePath of trackedFiles) {
      assert.equal(
        await sha256(path.join(PUBLIC_PLUGIN_ROOT, relativePath)),
        await sha256(path.join(freshPlugin, relativePath)),
        `tracked public plugin drifted from canonical source: ${relativePath}`
      );
    }

    const manifest = JSON.parse(await fs.readFile(path.join(PUBLIC_PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.version, PACKAGE_JSON.version);
    assert.equal((await listDirectories(path.join(PUBLIC_PLUGIN_ROOT, 'skills'))).length, 11);
    await runExternalPluginValidatorIfAvailable(PUBLIC_PLUGIN_ROOT);

    const readme = await fs.readFile(path.join(REPOSITORY_ROOT, 'README.md'), 'utf8');
    assert.match(readme, /codex plugin marketplace add TanKimGwan\/linmas --ref main/);
    assert.match(readme, /codex plugin add linmas@linmas/);
    assert.match(readme, /restart the Codex desktop\/app-server/i);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
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
    const { stdout } = await runNpm(['pack', '--json', '--pack-destination', packDestination], { cwd: REPOSITORY_ROOT });
    const packResult = JSON.parse(stdout)[0];
    const archive = path.join(packDestination, packResult.filename);
    assert.ok(Array.isArray(packResult.files));
    const listing = packResult.files.map((entry) => entry.path.replaceAll('\\', '/'));
    assert.ok(listing.includes('plugin/manifest.template.json'));
    assert.ok(listing.includes('plugin/assets/linmas-logo.png'));
    assert.ok(listing.includes('plugin/assets/linmas-logo-dark.png'));
    for (const forbidden of ['tests/', 'docs/', '.agents/', 'plugins/', '.serena/', 'AGENTS.md', 'marketplace', 'gstack/']) {
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
