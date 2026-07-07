import os from 'node:os';
import { createClaudeAdapter } from '../hosts/claude.mjs';
import { createCodexAdapter } from '../hosts/codex.mjs';

export function detectHosts({ env = process.env, homedir = os.homedir(), platform = process.platform } = {}) {
  return [
    createClaudeAdapter({ homedir }).detect({ env, platform }),
    createCodexAdapter({ homedir }).detect({ env, platform })
  ];
}
