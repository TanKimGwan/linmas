import { terminalSafe } from '../core/terminal-text.mjs';

// Policy packs may come from an untrusted --policy-file; escape their text.
export function formatPolicyResult(result, { output = 'text' } = {}) {
  if (output === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  const lines = [`Policy: ${terminalSafe(result.policy.id)}@${terminalSafe(result.policy.version)}`, `Decision: ${terminalSafe(result.decision)}`];
  for (const rule of result.rules) lines.push(`- ${terminalSafe(rule.id)}: ${terminalSafe(rule.outcome)} — ${terminalSafe(rule.reason)}`);
  lines.push(`Human review required: ${result.humanReviewRequired ? 'yes' : 'no'}`, result.disclaimer);
  return `${lines.join('\n')}\n`;
}
