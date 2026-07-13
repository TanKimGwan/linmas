import os from 'node:os';
import { createClaudeAdapter } from './claude.mjs';
import { createCodexAdapter } from './codex.mjs';

export function createHostRegistry({ homedir = os.homedir() } = {}) {
  return new Map([
    ['claude', createClaudeAdapter({ homedir })],
    ['codex', createCodexAdapter({ homedir })]
  ]);
}
