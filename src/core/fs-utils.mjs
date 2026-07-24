import fs from 'node:fs';
import path from 'node:path';

// Resolve a path through symlinks even when the deepest segments do not exist
// yet: realpath the nearest existing ancestor, then re-attach the missing tail.
// This lets containment checks see where a write/delete would *physically* land,
// closing symlink-based escapes from the intended root.
export function resolveThroughSymlinks(targetPath) {
  let current = path.resolve(targetPath);
  const suffix = [];

  while (true) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        return path.resolve(targetPath);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function assertInsideRoot(rootPath, targetPath) {
  const resolvedRoot = resolveThroughSymlinks(rootPath);
  const resolvedTarget = resolveThroughSymlinks(targetPath);
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
