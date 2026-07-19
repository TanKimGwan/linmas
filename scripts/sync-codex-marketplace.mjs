#!/usr/bin/env node
import fs from 'node:fs/promises';
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

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
