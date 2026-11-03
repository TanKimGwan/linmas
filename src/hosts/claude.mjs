import fs from 'node:fs';
import path from 'node:path';

function binaryExists(envPath, names) {
  for (const dir of (envPath || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) if (fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

function writableFromExistingPath(targetPath) {
  let current = targetPath;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      try { fs.accessSync(current, fs.constants.W_OK); return true; } catch { return false; }
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

function directoryPath(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute directory path`);
  }
  return path.resolve(value);
}

function projectPath(value) {
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project root must be an existing non-symlink directory');
  return resolved;
}

export function createClaudeAdapter({ homedir, env = process.env }) {
  const home = path.resolve(homedir);
  const globalConfig = directoryPath(env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  const legacyRoot = globalConfig;

  function resolveTarget({ scope = 'global', projectRoot = process.cwd() } = {}) {
    if (!['project', 'global'].includes(scope)) throw new Error(`Invalid installation scope: ${scope}`);
    const scopeRoot = scope === 'project' ? projectPath(projectRoot) : home;
    const rootPath = scope === 'project' ? path.join(scopeRoot, '.claude') : globalConfig;
    const installRoot = path.join(rootPath, 'skills');
    const stateRoot = path.join(scopeRoot, '.agents');
    return {
      host: 'claude', scope, scopeRoot, rootPath, installRoot,
      manifestPath: path.join(stateRoot, 'linmas-manifest.json'),
      canonicalRoot: path.join(stateRoot, 'skills')
    };
  }

  function detect({ env: detectEnv = env, platform = process.platform, scope, projectRoot } = {}) {
    void platform;
    const target = scope ? resolveTarget({ scope, projectRoot }) : {
      host: 'claude', rootPath: legacyRoot, installRoot: path.join(legacyRoot, 'skills'),
      manifestPath: path.join(legacyRoot, 'linmas-manifest.json')
    };
    const rootExists = fs.existsSync(target.rootPath);
    const skillsExists = fs.existsSync(target.installRoot);
    const hasBinary = binaryExists(detectEnv.PATH, ['claude', 'claude-code']);
    const writable = writableFromExistingPath(target.rootPath);

    if (skillsExists) return { ...target, status: 'detected', reason: `${target.installRoot} exists`, writable };
    if (rootExists) return {
      ...target,
      status: hasBinary && writable ? 'detected' : 'probably_detected',
      reason: !writable
        ? `${target.rootPath} exists but is not writable`
        : hasBinary
        ? `skills root is missing but ${target.rootPath} exists and target root can be created safely`
        : `${target.rootPath} exists but skills root is missing`,
      writable
    };
    if (hasBinary && writable) return {
      ...target,
      status: 'detected',
      reason: scope
        ? `skills root is missing but ${target.rootPath} can be created safely`
        : `skills root is missing but ${target.rootPath} exists and target root can be created safely`,
      writable
    };
    return { ...target, status: 'not_detected', reason: 'no host directory or binary found', writable: false };
  }

  const adapter = {
    getInstallRoot() { return path.join(legacyRoot, 'skills'); },
    getManifestPath() { return path.join(legacyRoot, 'linmas-manifest.json'); },
    validateTarget({ scope = 'global', projectRoot } = {}) {
      const target = resolveTarget({ scope, projectRoot });
      const writable = writableFromExistingPath(target.rootPath);
      return {
        status: writable ? 'detected' : 'probably_detected',
        writable,
        reason: writable
          ? `target can be created safely under ${target.rootPath}`
          : `${target.rootPath} has no writable, non-symlink directory ancestor`
      };
    },
    detect
  };
  Object.defineProperty(adapter, 'resolveTarget', { value: resolveTarget });
  return adapter;
}
