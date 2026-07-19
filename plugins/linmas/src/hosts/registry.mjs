import os from 'node:os';
import { assertHostAdapter } from './adapter-contract.mjs';
import { createClaudeAdapter } from './claude.mjs';
import { createCodexAdapter } from './codex.mjs';

export function createHostRegistry({ homedir = os.homedir() } = {}) {
  return new Map([
    ['claude', assertHostAdapter('claude', createClaudeAdapter({ homedir }))],
    ['codex', assertHostAdapter('codex', createCodexAdapter({ homedir }))]
  ]);
}
