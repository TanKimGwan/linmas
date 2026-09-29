#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createExplicitChildEnvironment } from './child-environment.mjs';

export const ARTIFACT_SCHEMA_VERSION = 1;
export const PACKAGE_NAME = 'linmas';
export const PLUGIN_BUILDER_PATH = 'scripts/build-codex-plugin.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function isSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) return false;
  if (path.posix.isAbsolute(relativePath)) return false;
  return relativePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function assertSafeRelativePath(relativePath, label) {
  if (!isSafeRelativePath(relativePath)) throw new Error(`${label} contains an unsafe relative path: ${relativePath}`);
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(targetPath, label, allowMissingLeaf = false) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && current === absolute && error.code === 'ENOENT') return;
      throw new Error(`${label} is unavailable: ${error.message}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`);
  }
}

export function assertToolOwnedRoot({ repositoryRoot, artifactRoot }) {
  if (typeof artifactRoot !== 'string' || !path.isAbsolute(artifactRoot)) throw new Error('artifactRoot must be an absolute path');
  const repository = path.resolve(repositoryRoot);
  const root = path.resolve(artifactRoot);
  if (isInside(repository, root) || isInside(root, repository)) throw new Error('artifactRoot must be outside the repository checkout');
  assertNoSymlinkComponents(root, 'artifactRoot');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('artifactRoot must be a regular directory');
  return root;
}

export function resolveToolOwnedPath(artifactRoot, relativePath, label) {
  assertSafeRelativePath(relativePath, label);
  const target = path.resolve(artifactRoot, ...relativePath.split('/'));
  if (!isInside(artifactRoot, target) || target === path.resolve(artifactRoot)) throw new Error(`${label} escapes artifactRoot`);
  assertNoSymlinkComponents(target, label, true);
  return target;
}

function readRegularFile(filePath, label) {
  assertNoSymlinkComponents(filePath, label);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return fs.readFileSync(filePath);
}

function readRegularDirectory(directoryPath, label) {
  assertNoSymlinkComponents(directoryPath, label);
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
}

function parseTarNumber(field, label) {
  const text = field.toString('ascii').replace(/\0.*$/u, '').trim();
  if (!text || !/^[0-7]+$/u.test(text)) throw new Error(`${label} has an invalid tar number`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} has an unsafe tar number`);
  return value;
}

function readTarString(field) {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function validateTarHeaderChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156), 'tar checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index];
  if (actual !== expected) throw new Error('tar header checksum mismatch');
}

function parseTarEntries(archiveBytes) {
  let bytes;
  try {
    bytes = zlib.gunzipSync(archiveBytes);
  } catch (error) {
    throw new Error(`package artifact is not a valid gzip tarball: ${error.message}`);
  }

  const entries = [];
  let offset = 0;
  let sawEnd = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    validateTarHeaderChecksum(header);
    const type = String.fromCharCode(header[156] || 48);
    if (type !== '0') throw new Error(`package archive contains a non-regular entry: ${type}`);
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const archivePath = prefix ? `${prefix}/${name}` : name;
    if (!archivePath.startsWith('package/')) throw new Error(`package archive entry is outside package/: ${archivePath}`);
    const relativePath = archivePath.slice('package/'.length);
    assertSafeRelativePath(relativePath, 'package archive entry');
    const size = parseTarNumber(header.subarray(124, 136), `tar size for ${archivePath}`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error(`package archive entry exceeds archive bounds: ${archivePath}`);
    if (entries.some((entry) => entry.path === relativePath)) throw new Error(`package archive contains a duplicate entry: ${relativePath}`);
    entries.push({
      path: relativePath,
      bytes: size,
      sha256: sha256(bytes.subarray(dataStart, dataEnd)),
      content: bytes.subarray(dataStart, dataEnd)
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (!sawEnd) throw new Error('package archive has no end-of-archive marker');
  for (let index = offset; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) throw new Error('package archive contains data after its end marker');
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function inventoryDigest(kind, entries) {
  return sha256(Buffer.from(canonicalJson({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    inventoryKind: kind,
    entries: entries.map(({ path: entryPath, bytes, sha256: digest }) => ({ path: entryPath, bytes, sha256: digest }))
  })));
}

function collectTree(directoryPath) {
  readRegularDirectory(directoryPath, 'plugin artifact');
  const files = new Map();
  const visit = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      assertSafeRelativePath(childRelative, 'plugin artifact entry');
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`plugin artifact contains a symlink: ${childRelative}`);
      if (entry.isDirectory()) {
        visit(child, childRelative);
      } else if (entry.isFile()) {
        const bytes = readRegularFile(child, `plugin artifact entry ${childRelative}`);
        files.set(childRelative, { path: childRelative, bytes: bytes.byteLength, sha256: sha256(bytes) });
      } else {
        throw new Error(`plugin artifact contains a non-regular entry: ${childRelative}`);
      }
    }
  };
  visit(directoryPath, '');
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function parsePackageJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function collectExpectedPackageFiles(repositoryRoot, packageJson) {
  if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) throw new Error('package.json files allowlist is required');
  const expected = new Set();
  const visit = (absolute, relative) => {
    assertNoSymlinkComponents(absolute, `package source ${relative}`);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`package source contains a symlink: ${relative}`);
    if (stat.isFile()) {
      expected.add(relative);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`package source contains a non-regular entry: ${relative}`);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = path.posix.join(relative, entry.name);
      visit(path.join(absolute, entry.name), childRelative);
    }
  };
  for (const rawEntry of packageJson.files) {
    if (typeof rawEntry !== 'string' || !rawEntry || /[*?[\]]/u.test(rawEntry)) throw new Error(`package.json files entry is not deterministic: ${rawEntry}`);
    const relative = rawEntry.replace(/\/+$/u, '');
    assertSafeRelativePath(relative, 'package.json files entry');
    visit(path.resolve(repositoryRoot, ...relative.split('/')), relative);
  }
  if (!expected.has('package.json')) throw new Error('package.json must be included by the package files allowlist');
  return expected;
}

function assertNoPrivatePackagePath(relativePath) {
  const segments = relativePath.split('/');
  if (segments[0] === 'docs' || segments[0] === 'tests' || segments[0] === 'compatibility' || segments[0] === '.local-agent' || segments[0] === '.serena' || segments[0] === '.git' || segments.some((segment) => segment === '.env' || segment.startsWith('.env.'))) {
    throw new Error(`package archive contains a private or development path: ${relativePath}`);
  }
}

export function measurePackageArtifact({ repositoryRoot, artifactPath, expectedName = PACKAGE_NAME, expectedVersion }) {
  const archiveBytes = readRegularFile(artifactPath, 'package artifact');
  const entries = parseTarEntries(archiveBytes);
  if (entries.length === 0) throw new Error('package archive is empty');
  for (const entry of entries) assertNoPrivatePackagePath(entry.path);

  const packageEntry = entries.find((entry) => entry.path === 'package.json');
  if (!packageEntry) throw new Error('package archive is missing package.json');
  const packageJson = parsePackageJson(packageEntry.content, 'package/package.json');
  if (packageJson.name !== expectedName) throw new Error(`package archive name is not ${expectedName}`);
  if (packageJson.version !== expectedVersion) throw new Error(`package archive version is not ${expectedVersion}`);

  const sourcePackageBytes = readRegularFile(path.join(repositoryRoot, 'package.json'), 'candidate package.json');
  if (!sourcePackageBytes.equals(packageEntry.content)) throw new Error('package archive package.json differs from candidate package.json');
  const expectedFiles = collectExpectedPackageFiles(repositoryRoot, packageJson);
  const actualFiles = new Set(entries.map((entry) => entry.path));
  if (expectedFiles.size !== actualFiles.size || [...expectedFiles].some((entryPath) => !actualFiles.has(entryPath))) {
    const missing = [...expectedFiles].filter((entryPath) => !actualFiles.has(entryPath));
    const extra = [...actualFiles].filter((entryPath) => !expectedFiles.has(entryPath));
    throw new Error(`package archive inventory differs from package.json files allowlist (missing=${missing.join(',')}; extra=${extra.join(',')})`);
  }
  for (const entry of entries) {
    const sourceBytes = readRegularFile(path.join(repositoryRoot, ...entry.path.split('/')), `candidate package input ${entry.path}`);
    if (!sourceBytes.equals(entry.content)) throw new Error(`package archive bytes differ from candidate input: ${entry.path}`);
  }

  const measured = {
    filename: path.basename(artifactPath),
    bytes: archiveBytes.byteLength,
    entryCount: entries.length,
    sha256: sha256(archiveBytes),
    inventorySha256: inventoryDigest('npm-package', entries),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    entries: entries.map(({ path: entryPath, bytes, sha256: digest }) => ({ path: entryPath, bytes, sha256: digest }))
  };
  if (measured.filename !== `${expectedName}-${expectedVersion}.tgz`) throw new Error('package artifact filename does not match package name and version');
  return measured;
}

export function measurePluginParity({ pluginPath, canonicalPath, expectedName = PACKAGE_NAME, expectedVersion }) {
  const actualFiles = collectTree(pluginPath);
  const canonicalFiles = collectTree(canonicalPath);
  const actualMap = new Map(actualFiles.map((entry) => [entry.path, entry]));
  const canonicalMap = new Map(canonicalFiles.map((entry) => [entry.path, entry]));
  const missing = canonicalFiles.filter((entry) => !actualMap.has(entry.path)).map((entry) => entry.path);
  const extra = actualFiles.filter((entry) => !canonicalMap.has(entry.path)).map((entry) => entry.path);
  const changed = canonicalFiles.filter((entry) => actualMap.has(entry.path) && (actualMap.get(entry.path).bytes !== entry.bytes || actualMap.get(entry.path).sha256 !== entry.sha256)).map((entry) => entry.path);
  if (missing.length || extra.length || changed.length) throw new Error(`plugin artifact differs from canonical plugin (missing=${missing.join(',')}; extra=${extra.join(',')}; changed=${changed.join(',')})`);

  const packageJson = parsePackageJson(readRegularFile(path.join(pluginPath, 'package.json'), 'plugin package.json'), 'plugin package.json');
  const manifest = parsePackageJson(readRegularFile(path.join(pluginPath, '.codex-plugin/plugin.json'), 'plugin manifest'), 'plugin manifest');
  if (packageJson.name !== expectedName || manifest.name !== expectedName) throw new Error('plugin name does not match the candidate package name');
  if (packageJson.version !== expectedVersion || manifest.version !== expectedVersion) throw new Error('plugin version does not match the candidate package version');

  return {
    fileCount: actualFiles.length,
    contentDigest: inventoryDigest('codex-plugin-tree', actualFiles),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    files: actualFiles
  };
}

function buildAndMeasurePlugin({ repositoryRoot, pluginPath, expectedVersion }) {
  const childEnvironment = createExplicitChildEnvironment('artifact-plugin-builder');
  const scratchRoot = childEnvironment.env.TMPDIR || os.tmpdir();
  const verifyParent = fs.mkdtempSync(path.join(scratchRoot, 'linmas-plugin-verify-'));
  const verifyTarget = path.join(verifyParent, 'linmas');
  try {
    const builder = path.resolve(repositoryRoot, ...PLUGIN_BUILDER_PATH.split('/'));
    assertNoSymlinkComponents(builder, 'plugin builder');
    execFileSync(process.execPath, [builder, '--target', verifyTarget], {
      cwd: repositoryRoot,
      env: childEnvironment.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const canonicalPath = path.resolve(repositoryRoot, 'plugins/linmas');
    const supplied = measurePluginParity({ pluginPath, canonicalPath, expectedVersion });
    const rebuilt = measurePluginParity({ pluginPath: verifyTarget, canonicalPath, expectedVersion });
    if (supplied.contentDigest !== rebuilt.contentDigest || supplied.fileCount !== rebuilt.fileCount) throw new Error('plugin artifact does not match a fresh isolated builder output');
    return supplied;
  } finally {
    childEnvironment.cleanup();
    fs.rmSync(verifyParent, { recursive: true, force: true });
  }
}

export function measureReleaseArtifacts({ repositoryRoot, artifactRoot, packagePath, pluginPath, expectedVersion }) {
  const safeRoot = assertToolOwnedRoot({ repositoryRoot, artifactRoot });
  const packageAbsolute = resolveToolOwnedPath(safeRoot, packagePath, 'package artifact path');
  const pluginAbsolute = resolveToolOwnedPath(safeRoot, pluginPath, 'plugin artifact path');
  const packageArtifact = measurePackageArtifact({ repositoryRoot, artifactPath: packageAbsolute, expectedVersion });
  const pluginArtifact = buildAndMeasurePlugin({ repositoryRoot, pluginPath: pluginAbsolute, expectedVersion });
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    handoffKind: 'linmas-release-artifact',
    package: {
      path: packagePath,
      ...packageArtifact
    },
    plugin: {
      path: pluginPath,
      ...pluginArtifact
    }
  };
}

function parseArgs(argv) {
  const allowed = new Set(['--root-dir', '--artifact-root', '--package-path', '--plugin-path', '--expected-version', '--output', '--expected-sha256', '--expected-bytes', '--expected-entries', '--expected-inventory-sha256']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || values.has(key)) throw new Error('invalid artifact-integrity arguments');
    values.set(key, value);
  }
  return values;
}

function main(argv) {
  const args = parseArgs(argv);
  const rootDir = path.resolve(args.get('--root-dir') || process.cwd());
  const artifactRoot = args.get('--artifact-root');
  const packagePath = args.get('--package-path');
  const pluginPath = args.get('--plugin-path');
  const expectedVersion = args.get('--expected-version');
  const output = args.get('--output');
  if (!artifactRoot || !packagePath || !pluginPath || !expectedVersion || !output) throw new Error('artifact root, package path, plugin path, expected version, and output are required');
  const result = measureReleaseArtifacts({ repositoryRoot: rootDir, artifactRoot, packagePath, pluginPath, expectedVersion });
  const expected = {
    sha256: args.get('--expected-sha256'),
    bytes: args.get('--expected-bytes') === undefined ? undefined : Number(args.get('--expected-bytes')),
    entryCount: args.get('--expected-entries') === undefined ? undefined : Number(args.get('--expected-entries')),
    inventorySha256: args.get('--expected-inventory-sha256')
  };
  if (expected.sha256 !== undefined && result.package.sha256 !== expected.sha256) throw new Error('measured package SHA-256 does not match the authorized digest');
  if (expected.bytes !== undefined && result.package.bytes !== expected.bytes) throw new Error('measured package size does not match the authorized size');
  if (expected.entryCount !== undefined && result.package.entryCount !== expected.entryCount) throw new Error('measured package entry count does not match the authorized count');
  if (expected.inventorySha256 !== undefined && result.package.inventorySha256 !== expected.inventorySha256) throw new Error('measured package inventory digest does not match the authorized digest');
  const outputPath = resolveToolOwnedPath(assertToolOwnedRoot({ repositoryRoot: rootDir, artifactRoot }), output, 'handoff manifest path');
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`artifact integrity validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
