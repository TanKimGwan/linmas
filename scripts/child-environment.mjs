import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHILD_ENVIRONMENT_POLICY = 'explicit-allowlist-v1';
export const TRUSTED_GIT_PATH = '/usr/bin/git';

const SAFE_PATH = '/usr/bin:/bin';

function safeLabel(label) {
  if (typeof label !== 'string' || !/^[a-z0-9-]+$/u.test(label)) throw new Error('child environment label is invalid');
  return label;
}

function assertRegularTrustedGit() {
  let stat;
  try {
    stat = fs.lstatSync(TRUSTED_GIT_PATH);
  } catch (error) {
    throw new Error(`trusted Git executable is unavailable: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error('trusted Git executable is not an immutable regular file');
}

export function createExplicitChildEnvironment(label = 'child') {
  const normalizedLabel = safeLabel(label);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `linmas-${normalizedLabel}-env-`));
  const config = path.join(root, 'config');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(config);
  fs.mkdirSync(cache);
  const env = {
    PATH: SAFE_PATH,
    HOME: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0'
  };
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
}

export function assertTrustedGitAvailable() {
  assertRegularTrustedGit();
  return TRUSTED_GIT_PATH;
}
