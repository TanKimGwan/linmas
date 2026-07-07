import fs from 'node:fs';
import path from 'node:path';

export function createClaudeAdapter({ homedir }) {
  const rootPath = path.join(homedir, '.claude');
  const installRoot = path.join(rootPath, 'skills');
  const manifestPath = path.join(rootPath, 'linmas-manifest.json');

  return {
    detect() {
      const rootExists = fs.existsSync(rootPath);
      const skillsExists = fs.existsSync(installRoot);
      const writable = rootExists;

      if (skillsExists) {
        return {
          host: 'claude',
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
          host: 'claude',
          status: 'probably_detected',
          reason: `${rootPath} exists but skills root is missing`,
          rootPath,
          installRoot,
          manifestPath,
          writable
        };
      }

      return {
        host: 'claude',
        status: 'not_detected',
        reason: 'no Claude directory found',
        rootPath,
        installRoot,
        manifestPath,
        writable: false
      };
    }
  };
}
