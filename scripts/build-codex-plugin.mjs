#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const PACKAGE_SOURCE = path.join(REPOSITORY_ROOT, 'package.json');
export const MANIFEST_SOURCE = path.join(REPOSITORY_ROOT, 'plugin', 'manifest.template.json');
export const MCP_MANIFEST_SOURCE = path.join(REPOSITORY_ROOT, '.mcp.json');
export const MCP_SOURCE = path.join(REPOSITORY_ROOT, 'mcp');
export const RUNTIME_SOURCE = path.join(REPOSITORY_ROOT, 'src');
export const POLICIES_SOURCE = path.join(REPOSITORY_ROOT, 'policies');
export const SKILLS_SOURCE = path.join(REPOSITORY_ROOT, 'skills');
export const BRAND_ASSETS_SOURCE = path.join(REPOSITORY_ROOT, 'plugin', 'assets');
export const BRAND_COLOR = '#F87818';
export const BRAND_ASSETS = Object.freeze([
  'linmas-logo-dark.png',
  'linmas-logo.png'
]);
export const EXPECTED_SKILLS = Object.freeze([
  'linmas-cloud-hardening-architect',
  'linmas-controls-compliance-reviewer',
  'linmas-detection-rules-engineer',
  'linmas-exploit-validation-specialist',
  'linmas-incident-triage-lead',
  'linmas-secure-code-reviewer',
  'linmas-secure-systems-architect',
  'linmas-security-domain-router',
  'linmas-security-operations-lead',
  'linmas-smart-contract-reviewer',
  'linmas-threat-research-analyst'
]);

const TARGET_NAME = 'linmas';
const DEFAULT_TARGET = path.join(os.homedir(), 'plugins', TARGET_NAME);
const USAGE = `usage: node scripts/build-codex-plugin.mjs [--target /absolute/path/to/${TARGET_NAME}]`;
const FORBIDDEN_MANIFEST_KEYS = new Set(['apps', 'hooks']);

function fail(message) {
  throw new Error(message);
}

async function lstatIfExists(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function hasTraversalSegment(rawTarget) {
  return rawTarget.split(/[\\/]/u).some((segment) => segment === '..');
}

async function assertNoSymlinkAncestors(targetPath) {
  const ancestors = [];
  let current = targetPath;

  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const ancestor of ancestors.reverse()) {
    const stat = await lstatIfExists(ancestor);
    if (stat?.isSymbolicLink()) {
      fail(`unsafe target: symlink path component is not allowed: ${ancestor}`);
    }
  }
}

export async function resolveSafeTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0) {
    fail('target is required and must be an absolute path');
  }
  if (rawTarget.includes('\0')) {
    fail('unsafe target: NUL bytes are not allowed');
  }
  if (!path.isAbsolute(rawTarget)) {
    fail('unsafe target: target must be an absolute path');
  }
  if (hasTraversalSegment(rawTarget)) {
    fail('unsafe target: traversal segments are not allowed');
  }

  const targetPath = path.resolve(rawTarget);
  if (targetPath === path.parse(targetPath).root) {
    fail('unsafe target: filesystem root is not a plugin target');
  }
  if (path.basename(targetPath) !== TARGET_NAME) {
    fail(`unsafe target: final path component must be '${TARGET_NAME}'`);
  }
  if (targetPath === REPOSITORY_ROOT) {
    fail('unsafe target: repository root is not a plugin target');
  }

  const targetStat = await lstatIfExists(targetPath);
  if (targetStat?.isSymbolicLink()) {
    fail('unsafe target: target must not be a symlink');
  }
  if (targetStat && !targetStat.isDirectory()) {
    fail('unsafe target: existing target must be a directory');
  }

  await assertNoSymlinkAncestors(targetPath);

  const parentPath = path.dirname(targetPath);
  const parentStat = await lstatIfExists(parentPath);
  if (!parentStat?.isDirectory()) {
    fail(`unsafe target: target parent must be an existing directory: ${parentPath}`);
  }

  return targetPath;
}

async function assertCanonicalManifest() {
  const manifestText = await fs.readFile(MANIFEST_SOURCE, 'utf8');
  const packageText = await fs.readFile(PACKAGE_SOURCE, 'utf8');
  let manifest;
  let packageJson;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`canonical manifest is not valid JSON: ${error.message}`);
  }
  try {
    packageJson = JSON.parse(packageText);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error.message}`);
  }

  if (manifest.name !== TARGET_NAME || typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    fail('canonical manifest must define linmas and package.json must define a version');
  }
  if (Object.hasOwn(manifest, 'version')) {
    fail('canonical manifest template must not duplicate the package.json version');
  }
  if (manifest.skills !== './skills/') {
    fail("canonical manifest must use skills path './skills/'");
  }
  if (manifest.mcpServers !== './.mcp.json') {
    fail("canonical manifest must use MCP companion path './.mcp.json'");
  }
  if (manifest.interface?.category !== 'Security') {
    fail("canonical manifest must use interface category 'Security'");
  }
  if (JSON.stringify(manifest.interface?.capabilities) !== JSON.stringify(['Interactive', 'Read', 'Write'])) {
    fail("canonical manifest capabilities must be ['Interactive', 'Read', 'Write']");
  }
  if (manifest.interface?.websiteURL !== 'https://github.com/TanKimGwan/linmas') {
    fail('canonical manifest must link to the Linmas repository');
  }
  if (manifest.interface?.brandColor !== BRAND_COLOR) {
    fail(`canonical manifest must use brand color '${BRAND_COLOR}'`);
  }
  if (manifest.interface?.composerIcon !== './assets/linmas-logo-dark.png'
    || manifest.interface?.logo !== './assets/linmas-logo.png'
    || manifest.interface?.logoDark !== './assets/linmas-logo-dark.png') {
    fail('canonical manifest must use the canonical Linmas interface assets');
  }
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (Object.hasOwn(manifest, key)) {
      fail(`canonical manifest must not declare ${key}`);
    }
  }

  return `${JSON.stringify({ ...manifest, version: packageJson.version }, null, 2)}\n`;
}

async function assertRegularSourceTree(root, label) {
  const rootStat = await lstatIfExists(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail(`unsafe ${label}: source directory is missing or symbolic`);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`unsafe ${label}: symlink is not allowed: ${target}`);
    if (entry.isDirectory()) await assertRegularSourceTree(target, label);
    else if (!entry.isFile()) fail(`unsafe ${label}: non-regular entry is not allowed: ${target}`);
  }
}

async function assertMcpManifest() {
  const manifestText = await fs.readFile(MCP_MANIFEST_SOURCE, 'utf8');
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch (error) { throw new Error(`MCP manifest is not valid JSON: ${error.message}`); }
  if (!manifest?.mcpServers?.linmas || manifest.mcpServers.linmas.command !== 'node') {
    fail('MCP manifest must define the local linmas node stdio server');
  }
  if (JSON.stringify(manifest.mcpServers.linmas.args) !== JSON.stringify(['./mcp/server.mjs', '--stdio'])) {
    fail('MCP manifest must use the canonical local stdio server arguments');
  }
  await assertRegularSourceTree(MCP_SOURCE, 'MCP source');
  await assertRegularSourceTree(RUNTIME_SOURCE, 'Linmas runtime source');
  await assertRegularSourceTree(POLICIES_SOURCE, 'policy source');
  return manifestText;
}

async function assertCanonicalSkills() {
  const entries = await fs.readdir(SKILLS_SOURCE, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(directories) !== JSON.stringify([...EXPECTED_SKILLS].sort())) {
    fail(`source skill inventory must contain exactly 11 canonical skills; found: ${directories.join(', ')}`);
  }

  for (const skillName of EXPECTED_SKILLS) {
    const skillRoot = path.join(SKILLS_SOURCE, skillName);
    const skillRootStat = await fs.lstat(skillRoot);
    if (skillRootStat.isSymbolicLink() || !skillRootStat.isDirectory()) {
      fail(`unsafe source skill: ${skillName} must be a real directory`);
    }

    const skillEntries = await fs.readdir(skillRoot, { withFileTypes: true });
    for (const entry of skillEntries) {
      if (entry.name !== 'SKILL.md') {
        fail(`source skill contains an unapproved file: skills/${skillName}/${entry.name}`);
      }
      if (entry.isSymbolicLink() || !entry.isFile()) {
        fail(`unsafe source skill file: skills/${skillName}/${entry.name}`);
      }
    }

    const skillFile = path.join(skillRoot, 'SKILL.md');
    const skillFileStat = await lstatIfExists(skillFile);
    if (!skillFileStat?.isFile() || skillFileStat.isSymbolicLink()) {
      fail(`missing or unsafe source skill file: skills/${skillName}/SKILL.md`);
    }
  }
}

async function assertBrandAssets() {
  const assetsStat = await lstatIfExists(BRAND_ASSETS_SOURCE);
  if (!assetsStat?.isDirectory() || assetsStat.isSymbolicLink()) {
    fail('unsafe brand assets: plugin/assets must be a real directory');
  }

  const entries = await fs.readdir(BRAND_ASSETS_SOURCE, { withFileTypes: true });
  const files = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(files) !== JSON.stringify([...BRAND_ASSETS].sort())) {
    fail(`brand asset inventory must contain exactly: ${BRAND_ASSETS.join(', ')}`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail(`unsafe brand asset: plugin/assets/${entry.name} must be a regular file`);
    }
  }
}

function parseSkillInterfaceMetadata(skillText, skillName) {
  const description = skillText.match(/^description:\s*(.+)$/mu)?.[1]?.trim();
  const heading = skillText.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  if (!description || !heading) {
    fail(`skill metadata is incomplete: skills/${skillName}/SKILL.md`);
  }
  return { description, displayName: `Linmas ${heading}` };
}

function renderSkillAgentManifest({ description, displayName }) {
  return [
    'interface:',
    `  display_name: ${JSON.stringify(displayName)}`,
    `  short_description: ${JSON.stringify(description)}`,
    '  icon_small: "./assets/icon-small.png"',
    '  icon_large: "./assets/icon-large.png"',
    `  brand_color: "${BRAND_COLOR}"`,
    ''
  ].join('\n');
}

async function copySourceTree(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copySourceTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    } else {
      fail(`unsafe source entry is not a regular file or directory: ${sourcePath}`);
    }
  }
}

async function createStagingOutput(parentPath, manifestText, mcpManifestText) {
  const stagingPath = await fs.mkdtemp(path.join(parentPath, `.${TARGET_NAME}.staging-`));
  try {
    await fs.mkdir(path.join(stagingPath, '.codex-plugin'));
    await fs.mkdir(path.join(stagingPath, 'skills'));
    await fs.writeFile(path.join(stagingPath, '.codex-plugin', 'plugin.json'), manifestText, 'utf8');
    await fs.copyFile(PACKAGE_SOURCE, path.join(stagingPath, 'package.json'), fs.constants.COPYFILE_EXCL);
    await fs.writeFile(path.join(stagingPath, '.mcp.json'), mcpManifestText, 'utf8');
    await copySourceTree(MCP_SOURCE, path.join(stagingPath, 'mcp'));
    await copySourceTree(RUNTIME_SOURCE, path.join(stagingPath, 'src'));
    await copySourceTree(POLICIES_SOURCE, path.join(stagingPath, 'policies'));
    await copySourceTree(BRAND_ASSETS_SOURCE, path.join(stagingPath, 'assets'));

    for (const skillName of EXPECTED_SKILLS) {
      const destinationRoot = path.join(stagingPath, 'skills', skillName);
      await fs.mkdir(destinationRoot);
      const skillText = await fs.readFile(path.join(SKILLS_SOURCE, skillName, 'SKILL.md'), 'utf8');
      await fs.copyFile(
        path.join(SKILLS_SOURCE, skillName, 'SKILL.md'),
        path.join(destinationRoot, 'SKILL.md'),
        fs.constants.COPYFILE_EXCL
      );
      await fs.mkdir(path.join(destinationRoot, 'agents'));
      await fs.writeFile(
        path.join(destinationRoot, 'agents', 'openai.yaml'),
        renderSkillAgentManifest(parseSkillInterfaceMetadata(skillText, skillName)),
        'utf8'
      );
      await fs.mkdir(path.join(destinationRoot, 'assets'));
      await fs.copyFile(
        path.join(BRAND_ASSETS_SOURCE, 'linmas-logo-dark.png'),
        path.join(destinationRoot, 'assets', 'icon-small.png'),
        fs.constants.COPYFILE_EXCL
      );
      await fs.copyFile(
        path.join(BRAND_ASSETS_SOURCE, 'linmas-logo-dark.png'),
        path.join(destinationRoot, 'assets', 'icon-large.png'),
        fs.constants.COPYFILE_EXCL
      );
    }
    return stagingPath;
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function replaceTarget(stagingPath, targetPath) {
  const parentPath = path.dirname(targetPath);
  const targetStat = await lstatIfExists(targetPath);
  const backupPath = path.join(parentPath, `.${TARGET_NAME}.backup-${randomUUID()}`);
  let targetMoved = false;
  let stagingMoved = false;

  try {
    if (targetStat) {
      await fs.rename(targetPath, backupPath);
      targetMoved = true;
    }
    await fs.rename(stagingPath, targetPath);
    stagingMoved = true;
    if (targetMoved) {
      await fs.rm(backupPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (stagingMoved) {
      await fs.rm(targetPath, { recursive: true, force: true });
    } else {
      await fs.rm(stagingPath, { recursive: true, force: true });
    }
    if (targetMoved) {
      await fs.rename(backupPath, targetPath);
    }
    throw error;
  }
}

export async function buildPlugin(rawTarget) {
  const targetPath = await resolveSafeTarget(rawTarget);
  const manifestText = await assertCanonicalManifest();
  const mcpManifestText = await assertMcpManifest();
  await assertCanonicalSkills();
  await assertBrandAssets();

  const stagingPath = await createStagingOutput(path.dirname(targetPath), manifestText, mcpManifestText);
  try {
    await replaceTarget(stagingPath, targetPath);
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw error;
  }

  return targetPath;
}

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv.length === 0) return { target: DEFAULT_TARGET };
  if (argv.length !== 2 || argv[0] !== '--target') {
    fail(USAGE);
  }
  return { target: argv[1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const targetPath = await buildPlugin(args.target);
  console.log(`Built Linmas Codex plugin: ${targetPath}`);
  console.log(`Skills copied: ${EXPECTED_SKILLS.length}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
