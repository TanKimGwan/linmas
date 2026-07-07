import fs from 'node:fs';
import path from 'node:path';

function binaryExists(envPath, names) {
  for (const dir of (envPath || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      if (fs.existsSync(path.join(dir, name))) return true;
    }
  }
  return false;
}

export function createCodexAdapter({ homedir }) {
  const rootPath = path.join(homedir, '.codex');
  const installRoot = path.join(rootPath, 'skills');
  const manifestPath = path.join(rootPath, 'linmas-manifest.json');

  const checkWritable = (dir) => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const getTargetWritability = () => {
    if (fs.existsSync(rootPath)) {
      return checkWritable(rootPath);
    }
    const parentDir = path.dirname(rootPath);
    if (fs.existsSync(parentDir)) {
      return checkWritable(parentDir);
    }
    return false;
  };

  const adapter = {
    getInstallRoot() { return installRoot; },
    getManifestPath() { return manifestPath; },
    validateTarget() {
      const exists = fs.existsSync(rootPath);
      let writable = false;
      if (exists) {
        writable = checkWritable(rootPath);
      } else {
        const parentDir = path.dirname(rootPath);
        if (fs.existsSync(parentDir)) {
          writable = checkWritable(parentDir);
        }
      }
      const creatable = writable && !fs.existsSync(installRoot);

      if (writable) {
        return {
          status: 'detected',
          writable,
          reason: creatable
            ? `skills root is missing but ${rootPath} exists and target root can be created safely`
            : `${installRoot} exists and target root is writable`
        };
      } else {
        return {
          status: 'probably_detected',
          writable,
          reason: `${rootPath} exists but is not writable`
        };
      }
    },
    detect({ env = process.env, platform = process.platform } = {}) {
      void platform;
      const rootExists = fs.existsSync(rootPath);
      const skillsExists = fs.existsSync(installRoot);
      const hasBinary = binaryExists(env.PATH, ['codex']);
      const writable = getTargetWritability();

      if (skillsExists) {
        return {
          host: 'codex',
          status: 'detected',
          reason: `${installRoot} exists`,
          rootPath,
          installRoot,
          manifestPath,
          writable
        };
      }

      if (rootExists) {
        const validation = adapter.validateTarget();
        if (rootExists && !hasBinary) {
          return {
            host: 'codex',
            status: 'probably_detected',
            reason: `${rootPath} exists but skills root is missing`,
            rootPath,
            installRoot,
            manifestPath,
            writable
          };
        }

        return {
          host: 'codex',
          status: validation.status,
          reason: validation.reason,
          rootPath,
          installRoot,
          manifestPath,
          writable: validation.writable
        };
      }

      if (hasBinary) {
        const validation = adapter.validateTarget();
        return {
          host: 'codex',
          status: validation.status,
          reason: validation.reason,
          rootPath,
          installRoot,
          manifestPath,
          writable: validation.writable
        };
      }

      return {
        host: 'codex',
        status: 'not_detected',
        reason: 'no host directory or binary found',
        rootPath,
        installRoot,
        manifestPath,
        writable: false
      };
    }
  };

  return adapter;
}
