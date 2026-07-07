import fs from 'node:fs';
import path from 'node:path';

export function assertInsideRoot(rootPath, targetPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '') {
    throw new Error(`refusing to operate on root path: ${targetPath}`);
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside root: ${targetPath}`);
  }
}

export function createTimestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

export function backupDirectory(sourceDir, backupDir) {
  fs.mkdirSync(path.dirname(backupDir), { recursive: true });
  fs.cpSync(sourceDir, backupDir, { recursive: true, force: true });
}

export function copySkillDirectory(sourceDir, destinationDir) {
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true });
}
