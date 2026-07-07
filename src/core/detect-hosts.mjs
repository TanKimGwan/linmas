import os from 'node:os';
import { createClaudeAdapter } from '../hosts/claude.mjs';
import { createCodexAdapter } from '../hosts/codex.mjs';

export function detectHosts({ env = process.env, homedir = os.homedir(), platform = process.platform } = {}) {
  void env;
  void platform;

  return [
    createClaudeAdapter({ homedir }).detect(),
    createCodexAdapter({ homedir }).detect()
  ];
}
