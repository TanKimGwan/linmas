import { terminalSafe } from '../core/terminal-text.mjs';

// Text output quotes provider response values, which are untrusted. Free-text
// fields keep line breaks; every other unsafe character is escaped.
export function formatReviewResult(result, { output = 'text' } = {}) {
  if (output === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  const lines = [`Review: ${terminalSafe(result.specialist)}`, 'Human review required: yes'];
  for (const finding of result.findings) {
    lines.push(
      '',
      `[${terminalSafe(finding.severity)}] ${terminalSafe(finding.status)}: ${terminalSafe(finding.id)}`,
      `Evidence: ${freeText(finding.evidence)}`,
      `Remediation: ${freeText(finding.remediation)}`,
      `Verification: ${freeText(finding.verification)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

// Continuation lines of provider free text get a fixed "  |" prefix, so the
// provider cannot start a line at column 0 and forge Linmas output such as a
// finding header or "Human review required: no".
function freeText(value) {
  return terminalSafe(value, { multiline: true }).split('\n').map((line, index) => (index === 0 ? line : line ? `  | ${line}` : '  |')).join('\n');
}
