import fs from 'node:fs';
import path from 'node:path';
import { validatePolicyPack } from './validate-pack.mjs';

const BUILT_INS = Object.freeze({
  'baseline-appsec': 'baseline-appsec.json',
  'cloud-change': 'cloud-change.json',
  'release-security': 'release-security.json'
});

export function loadPolicyPack({ id = null, filePath = null, rootDir, cwd = process.cwd(), maxBytes = 65536 }) {
  if (Boolean(id) === Boolean(filePath)) throw new Error('provide exactly one policy id or policy file');
  if (id && !BUILT_INS[id]) throw new Error(`unknown built-in policy: ${id}`);
  const target = id ? path.join(rootDir, 'policies', BUILT_INS[id]) : path.resolve(cwd, filePath);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new Error(`unable to read policy: ${error.message}`);
  }
  if (stat.isSymbolicLink()) throw new Error('policy file must not be a symlink');
  if (!stat.isFile()) throw new Error('policy path must be a regular file');
  if (stat.size > maxBytes) throw new Error(`policy exceeds ${maxBytes} bytes`);
  try {
    return validatePolicyPack(JSON.parse(fs.readFileSync(target, 'utf8')), { source: target });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${target}: invalid JSON`);
    throw error;
  }
}
