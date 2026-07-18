import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(rootDir, 'src');

async function listSourceModules(directory) {
  const modules = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...await listSourceModules(target));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) modules.push(target);
  }
  return modules;
}

test('coverage inventory imports every source module', async () => {
  const modules = await listSourceModules(sourceRoot);
  assert.ok(modules.length > 0, 'source inventory must not be empty');
  await Promise.all(modules.map((modulePath) => import(pathToFileURL(modulePath).href)));
});
