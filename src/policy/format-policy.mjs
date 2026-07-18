export function formatPolicyResult(result, { output = 'text' } = {}) {
  if (output === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  const lines = [`Policy: ${result.policy.id}@${result.policy.version}`, `Decision: ${result.decision}`];
  for (const rule of result.rules) lines.push(`- ${rule.id}: ${rule.outcome} — ${rule.reason}`);
  lines.push(`Human review required: ${result.humanReviewRequired ? 'yes' : 'no'}`, result.disclaimer);
  return `${lines.join('\n')}\n`;
}
