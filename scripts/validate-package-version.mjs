import fs from 'node:fs';
import path from 'node:path';

// Linmas release versions use the strict, tag-compatible x.y.z form. Keep the
// expression free of `g` so repeated validation is deterministic.
export const STRICT_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function isStrictReleaseVersion(value) {
  return typeof value === 'string' && STRICT_RELEASE_VERSION.test(value);
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new Error(`Package version consistency failed: ${label} is missing`, { cause });
    }
    throw new Error(`Package version consistency failed: unable to read ${label}: ${cause.message}`, { cause });
  }

  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected a JSON object');
    }
    return value;
  } catch (cause) {
    if (cause?.message === 'expected a JSON object') {
      throw new Error(`Package version consistency failed: ${label} must be a JSON object`, { cause });
    }
    throw new Error(`Package version consistency failed: ${label} is not valid JSON: ${cause.message}`, { cause });
  }
}

function requireVersion(value, label) {
  if (!isStrictReleaseVersion(value)) {
    throw new Error(`Package version consistency failed: ${label} version must be a strict release SemVer string (x.y.z)`);
  }
  return value;
}

/**
 * Validate every canonical version surface in a source checkout.
 *
 * The plugin mirror is part of the source-checkout contract even though it is
 * intentionally excluded from the npm package. Missing files are therefore a
 * validation error rather than a signal to silently reduce the surface set.
 */
export function validatePackageVersionConsistency(rootDir = process.cwd()) {
  const packageJson = readJson(path.join(rootDir, 'package.json'), 'package.json');
  const lockJson = readJson(path.join(rootDir, 'package-lock.json'), 'package-lock.json');

  const pluginRoot = path.join(rootDir, 'plugins', 'linmas');
  let pluginRootStat;
  try {
    pluginRootStat = fs.lstatSync(pluginRoot);
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new Error('Package version consistency failed: plugins/linmas mirror is missing', { cause });
    }
    throw new Error(`Package version consistency failed: unable to inspect plugins/linmas mirror: ${cause.message}`, { cause });
  }
  if (!pluginRootStat.isDirectory() || pluginRootStat.isSymbolicLink()) {
    throw new Error('Package version consistency failed: plugins/linmas mirror must be a regular directory');
  }

  const pluginPackagePath = path.join(pluginRoot, 'package.json');
  const pluginManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const pluginPackage = readJson(pluginPackagePath, 'plugins/linmas/package.json');
  const pluginManifest = readJson(pluginManifestPath, 'plugins/linmas/.codex-plugin/plugin.json');

  const versions = [
    { label: 'package.json', value: requireVersion(packageJson.version, 'package.json') },
    { label: 'package-lock.json top-level', value: requireVersion(lockJson.version, 'package-lock.json top-level') },
    { label: 'package-lock.json packages[""]', value: requireVersion(lockJson.packages?.['']?.version, 'package-lock.json packages[""]') },
    { label: 'plugins/linmas/package.json', value: requireVersion(pluginPackage.version, 'plugins/linmas/package.json') },
    { label: 'plugins/linmas/.codex-plugin/plugin.json', value: requireVersion(pluginManifest.version, 'plugins/linmas/.codex-plugin/plugin.json') }
  ];

  const expected = versions[0].value;
  const mismatches = versions.filter(({ value }) => value !== expected);
  if (mismatches.length > 0) {
    const details = versions.map(({ label, value }) => `${label}=${JSON.stringify(value)}`).join(', ');
    throw new Error(`Package version consistency failed: all canonical versions must match; ${details}`);
  }

  return Object.freeze({ version: expected, surfaces: Object.freeze(versions) });
}
