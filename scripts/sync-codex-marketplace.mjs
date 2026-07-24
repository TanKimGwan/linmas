#!/usr/bin/env node
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin, EXPECTED_SKILLS, REPOSITORY_ROOT } from './build-codex-plugin.mjs';

export const PUBLIC_PLUGIN_PARENT = path.join(REPOSITORY_ROOT, 'plugins');
export const PUBLIC_PLUGIN_ROOT = path.join(PUBLIC_PLUGIN_PARENT, 'linmas');

export async function syncCodexMarketplace() {
  await fs.mkdir(PUBLIC_PLUGIN_PARENT, { recursive: true });
  return buildPlugin(PUBLIC_PLUGIN_ROOT);
}

async function main() {
  const target = await syncCodexMarketplace();
  console.log(`Synced public Codex marketplace plugin: ${target}`);
  console.log(`Skills copied: ${EXPECTED_SKILLS.length}`);
}

// Compare via realpath so a symlinked invocation path (e.g. macOS /var ->
// /private/var) still matches the module URL node resolves for the entry file.
function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(modulePath);
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
