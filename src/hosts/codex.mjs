import fs from 'node:fs';
import path from 'node:path';

export function createCodexAdapter({ homedir }) {
  const rootPath = path.join(homedir, '.codex');
  const installRoot = path.join(rootPath, 'skills');
  const manifestPath = path.join(rootPath, 'linmas-manifest.json');

  return {
    detect() {
      const rootExists = fs.existsSync(rootPath);
      const skillsExists = fs.existsSync(installRoot);
      const writable = rootExists;

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
        status: 'not_detected',
        reason: 'no Codex directory found',
        rootPath,
        installRoot,
        manifestPath,
        writable: false
      };
    }
  };
}
