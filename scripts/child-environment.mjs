import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CHILD_ENVIRONMENT_POLICY = 'explicit-allowlist-v1';

function discoveryEnvironment(env, platform) {
  const inheritedPath = env.PATH ?? env.Path;
  if (typeof inheritedPath !== 'string' || inheritedPath.trim() === '') {
    throw new Error('trusted Git executable PATH is unavailable');
  }
  const result = { PATH: inheritedPath };
  if (platform === 'win32') {
    for (const name of ['PATHEXT', 'SystemRoot']) {
      if (typeof env[name] === 'string' && env[name] !== '') result[name] = env[name];
    }
  } else {
    result.LANG = 'C';
  }
  return result;
}

function pathEntries(searchEnv, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const entries = searchEnv.PATH.split(pathApi.delimiter);
  if (entries.some((entry) => entry === '' || !pathApi.isAbsolute(entry))) {
    throw new Error('trusted Git executable PATH contains an invalid entry');
  }
  return { pathApi, entries };
}

function executableNames(searchEnv, platform) {
  if (platform !== 'win32') return ['git'];
  const pathExt = searchEnv.PATHEXT;
  if (typeof pathExt !== 'string' || pathExt.trim() === '') {
    throw new Error('trusted Git executable PATHEXT is unavailable');
  }
  const extensions = [...new Set(pathExt.split(';').map((extension) => extension.trim().toLowerCase()).filter(Boolean))];
  if (extensions.length === 0 || extensions.some((extension) => !/^\.[a-z0-9]+$/u.test(extension))) {
    throw new Error('trusted Git executable PATHEXT is invalid');
  }
  return extensions.map((extension) => `git${extension}`);
}

function candidateExists(candidate, fsImpl) {
  try {
    fsImpl.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw new Error('trusted Git executable candidate could not be inspected');
  }
}

function assertGitFile(candidate, { platform, pathApi, fsImpl }) {
  if (!pathApi.isAbsolute(candidate)) throw new Error('trusted Git executable resolution returned a non-absolute path');
  let item;
  let resolved;
  try {
    item = fsImpl.lstatSync(candidate);
    if (!item.isFile() || item.isSymbolicLink()) throw new Error('invalid file type');
    resolved = fsImpl.realpathSync(candidate);
    const resolvedItem = fsImpl.lstatSync(resolved);
    if (!resolvedItem.isFile() || resolvedItem.isSymbolicLink()) throw new Error('invalid resolved file type');
    if (platform === 'win32') {
      if (pathApi.extname(resolved).toLowerCase() !== '.exe') throw new Error('unsupported Windows executable type');
    } else if ((resolvedItem.mode & 0o111) === 0 || (resolvedItem.mode & 0o022) !== 0) {
      throw new Error('unsafe POSIX executable mode');
    }
  } catch {
    throw new Error('trusted Git executable resolution returned an invalid file');
  }
  return resolved;
}

export function resolveTrustedGitPath({
  platform = process.platform,
  env = process.env,
  run = execFileSync,
  fsImpl = fs
} = {}) {
  const searchEnv = discoveryEnvironment(env, platform);
  const { pathApi, entries } = pathEntries(searchEnv, platform);
  const names = executableNames(searchEnv, platform);
  const candidates = entries.flatMap((entry) => names.map((name) => pathApi.join(entry, name)))
    .filter((candidate) => candidateExists(candidate, fsImpl));
  if (candidates.length === 0) throw new Error('trusted Git executable was not found on PATH');

  const resolvedByIdentity = new Map();
  for (const candidate of candidates) {
    const resolved = assertGitFile(candidate, { platform, pathApi, fsImpl });
    const identity = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!resolvedByIdentity.has(identity)) resolvedByIdentity.set(identity, resolved);
  }
  const resolved = [...resolvedByIdentity.values()];
  if (resolved.length !== 1) throw new Error('trusted Git executable resolution is ambiguous');
  let version;
  try {
    version = run(resolved[0], ['--version'], {
      encoding: 'utf8',
      env: searchEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    throw new Error('resolved trusted Git executable failed validation');
  }
  if (Buffer.isBuffer(version)) version = version.toString('utf8');
  if (typeof version !== 'string' || !/^git version \d+(?:\.\d+)+/u.test(version.trim())) {
    throw new Error('resolved trusted Git executable failed validation');
  }
  return resolved[0];
}

function safeLabel(label) {
  if (typeof label !== 'string' || !/^[a-z0-9-]+$/u.test(label)) throw new Error('child environment label is invalid');
  return label;
}

export function createExplicitChildEnvironment(label = 'child') {
  const normalizedLabel = safeLabel(label);
  const trustedGitPath = assertTrustedGitAvailable();
  const systemRoot = process.platform === 'win32' ? (process.env.SystemRoot ?? process.env.SYSTEMROOT) : undefined;
  if (process.platform === 'win32' && (typeof systemRoot !== 'string' || systemRoot === '')) {
    throw new Error('Windows system root is unavailable');
  }
  const platformPath = process.platform === 'win32' ? path.win32 : path.posix;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `linmas-${normalizedLabel}-env-`));
  try {
    const config = path.join(root, 'config');
    const cache = path.join(root, 'cache');
    fs.mkdirSync(config);
    fs.mkdirSync(cache);
    const globalGitConfig = path.join(root, 'gitconfig');
    fs.writeFileSync(globalGitConfig, '', { mode: 0o600 });
    const gitConfigStat = fs.lstatSync(globalGitConfig);
    if (!gitConfigStat.isFile() || gitConfigStat.isSymbolicLink()) throw new Error('isolated Git config is not a regular file');
    const safePathEntries = [platformPath.dirname(trustedGitPath)];
    if (process.platform === 'win32') {
      safePathEntries.push(platformPath.join(systemRoot, 'System32'));
    } else {
      safePathEntries.push('/usr/bin', '/bin');
    }
    const childPath = [...new Set(safePathEntries)].join(path.delimiter);
    const env = {
      PATH: childPath,
      HOME: root,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalGitConfig,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0'
    };
    if (process.platform === 'win32') {
      for (const name of ['SystemRoot', 'PATHEXT']) {
        const value = process.env[name] ?? process.env[name.toUpperCase()];
        if (typeof value === 'string' && value !== '') env[name] = value;
      }
    }
    for (const key of ['LINMAS_APPROVED_NPM_CLI', 'LINMAS_APPROVED_NODE_PATH']) {
      if (typeof process.env[key] === 'string' && process.env[key].length > 0) env[key] = process.env[key];
    }
    return {
      env,
      root,
      policy: CHILD_ENVIRONMENT_POLICY,
      cleanup() {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function assertTrustedGitAvailable() {
  return resolveTrustedGitPath();
}
