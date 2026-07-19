export function formatReviewResult(result, { output = 'text' } = {}) {
  if (output === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  const lines = [`Review: ${result.specialist}`, 'Human review required: yes'];
  for (const finding of result.findings) {
    lines.push(
      '',
      `[${finding.severity}] ${finding.status}: ${finding.id}`,
      `Evidence: ${finding.evidence}`,
      `Remediation: ${finding.remediation}`,
      `Verification: ${finding.verification}`
    );
  }
  return `${lines.join('\n')}\n`;
}
