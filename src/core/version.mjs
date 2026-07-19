import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
} catch (cause) {
  throw new Error(`unable to read Linmas package version: ${cause.message}`, { cause });
}

if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
  throw new Error('Linmas package version must be a non-empty string');
}

export const LINMAS_VERSION = packageJson.version;
