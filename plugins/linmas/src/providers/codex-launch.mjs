import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER_OVERRIDE = 'model_provider="openai"';
const ISOLATED_CONFIG = 'model_provider = "openai"\n';
const MAX_AUTH_BYTES = 1024 * 1024;

function safeAuthOpenFlags(constants, platform) {
  if (!constants || !Number.isInteger(constants.O_RDONLY)) {
    throw new Error('Safe authentication inspection is unavailable');
  }
  if (platform === 'win32') return constants.O_RDONLY;
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    throw new Error('Safe no-follow and nonblocking authentication inspection is unavailable');
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function invalidAuth(cause) {
  return cause
    ? new Error('Codex authentication file is invalid', { cause })
    : new Error('Codex authentication file is invalid');
}

function exceedsAuthLimit(size) {
  return typeof size === 'bigint'
    ? size < 0n || size > BigInt(MAX_AUTH_BYTES)
    : !Number.isSafeInteger(size) || size < 0 || size > MAX_AUTH_BYTES;
}

function hasPrivatePosixMode(mode) {
  return typeof mode === 'bigint'
    ? (mode & 0o077n) === 0n
    : Number.isInteger(mode) && (mode & 0o077) === 0;
}

function validateAuthStat(stat, { enforcePrivateMode }) {
  if (!stat?.isFile?.() || exceedsAuthLimit(stat.size)) throw invalidAuth();
  if (enforcePrivateMode && !hasPrivatePosixMode(stat.mode)) throw invalidAuth();
}

function windowsIdentity(stat) {
  if (typeof stat?.dev !== 'bigint'
    || typeof stat?.ino !== 'bigint'
    || typeof stat?.birthtimeNs !== 'bigint'
    || stat.ino === 0n) {
    throw invalidAuth();
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs
  };
}

function sameWindowsIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function sameWindowsSource(left, right) {
  return sameWindowsIdentity(windowsIdentity(left), windowsIdentity(right))
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function sameAuthSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readBoundedAuth(handle) {
  const contents = Buffer.alloc(MAX_AUTH_BYTES + 1);
  let total = 0;
  while (total < contents.length) {
    const { bytesRead } = await handle.read(contents, total, contents.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > MAX_AUTH_BYTES) throw new Error('Codex authentication file is invalid');
  return contents.subarray(0, total);
}

async function copyAuthIfPresent({ sourceHome, codexHome, flags, platform, fsImpl }) {
  const authPath = path.join(sourceHome, 'auth.json');
  let expectedSnapshot = null;
  let sourceObserved = false;
  let auth;
  try {
    if (platform === 'win32') {
      const sourceStat = await fsImpl.lstat(authPath, { bigint: true });
      sourceObserved = true;
      validateAuthStat(sourceStat, { enforcePrivateMode: false });
      windowsIdentity(sourceStat);
      expectedSnapshot = sourceStat;
    }

    auth = await fsImpl.open(authPath, flags);
    const stat = await auth.stat({ bigint: true });
    validateAuthStat(stat, { enforcePrivateMode: platform !== 'win32' });
    if (expectedSnapshot && !sameWindowsSource(expectedSnapshot, stat)) throw invalidAuth();

    const contents = await readBoundedAuth(auth);
    const finalStat = await auth.stat({ bigint: true });
    validateAuthStat(finalStat, { enforcePrivateMode: platform !== 'win32' });
    if (!sameAuthSnapshot(stat, finalStat) || BigInt(contents.length) !== finalStat.size) throw invalidAuth();

    await fsImpl.writeFile(path.join(codexHome, 'auth.json'), contents, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'ENOENT' && !sourceObserved && !auth) return;
    if (error?.message === 'Codex authentication file is invalid') throw error;
    throw invalidAuth(error);
  } finally {
    await auth?.close();
  }
}

export function codexCapabilityArgs() {
  return ['app-server', '--stdio', '-c', PROVIDER_OVERRIDE];
}

export function codexExecutionArgs({ model, schemaPath, outputPath }) {
  return [
    'exec', '-c', PROVIDER_OVERRIDE, '--model', model, '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '--skip-git-repo-check', '--ephemeral',
    '--ignore-rules', '--output-schema', schemaPath,
    '--output-last-message', outputPath, '-'
  ];
}

export async function prepareCodexLaunchEnvironment({
  workspaceDir,
  env = process.env,
  fsConstantsImpl = fsConstants,
  fsImpl = fs,
  platform = process.platform
} = {}) {
  if (typeof workspaceDir !== 'string' || !workspaceDir) throw new Error('Codex launch workspace is required');
  const authFlags = safeAuthOpenFlags(fsConstantsImpl, platform);
  const codexHome = path.join(workspaceDir, 'codex-home');
  let created = false;
  try {
    await fsImpl.mkdir(codexHome, { mode: 0o700 });
    created = true;
    await fsImpl.writeFile(path.join(codexHome, 'config.toml'), ISOLATED_CONFIG, { mode: 0o600, flag: 'wx' });

    const userHome = env.HOME || env.USERPROFILE || os.homedir();
    const sourceHome = env.CODEX_HOME || path.join(userHome, '.codex');
    await copyAuthIfPresent({ sourceHome, codexHome, flags: authFlags, platform, fsImpl });
  } catch (error) {
    if (created) {
      try {
        await fsImpl.rm(codexHome, { recursive: true, force: true });
      } catch (cleanupCause) {
        error.cleanupCause = cleanupCause;
      }
    }
    throw error;
  }

  return { ...env, CODEX_HOME: codexHome };
}

export function sanitizeCodexDiagnostic(value, { singleLine = false } = {}) {
  let redacted = String(value ?? '')
    .replace(/(["'])(authorization|api[_-]?key|token|password|secret)\1\s*:\s*(["'])(?:\\.|(?!\3)[\s\S])*?\3/gi, '$1$2$1:$3[redacted]$3')
    .replace(/\b(authorization|api[_-]?key|token|password|secret)\b\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi, '$1=[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g, '[redacted-github-token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted-private-key]');
  if (singleLine) redacted = redacted.replace(/[\r\n]+/g, ' ');
  if (redacted.length <= 512) return redacted;
  return singleLine
    ? redacted.slice(0, 512)
    : `${redacted.slice(0, 240)}\n...[diagnostic truncated]...\n${redacted.slice(-240)}`;
}
