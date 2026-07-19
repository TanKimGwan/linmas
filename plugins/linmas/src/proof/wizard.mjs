import { ProofError } from './errors.mjs';
import { DISPOSITIONS } from './constants.mjs';
import { buildDecisionReceipt } from './validate-receipt.mjs';

const LABELS = new Map([
  ['1', 'remediation-required'],
  ['2', 'accepted-risk'],
  ['3', 'false-positive'],
  ['4', 'needs-more-evidence']
]);

export async function collectDecisionReceipt(source, { io, signing = false, now = new Date() } = {}) {
  if (!io?.isTTY) throw new ProofError('proof creation requires an interactive TTY', 'input', 2);
  const label = await ask(io, 'Reviewer label: ');
  const principal = signing ? await ask(io, 'SSH signer principal: ') : null;
  const decisions = [];
  for (const finding of source.findings) {
    io.stdout.write(`\nFinding ${finding.id}${finding.title ? ` — ${finding.title}` : ''} (${finding.severity ?? 'unknown'})\n`);
    io.stdout.write('1) remediation-required  2) accepted-risk  3) false-positive  4) needs-more-evidence\n');
    const choice = await ask(io, 'Disposition: ');
    const disposition = LABELS.get(choice) ?? (DISPOSITIONS.includes(choice) ? choice : null);
    if (!disposition) throw new ProofError(`invalid disposition for ${finding.id}`, 'input', 2);
    const rationale = await ask(io, 'Rationale: ');
    decisions.push({ id: finding.id, disposition, rationale });
  }
  const statement = await ask(io, 'Human summary: ');
  io.stdout.write(`\nOverall disposition: ${buildDecisionReceipt({ subject: { kind: source.kind, sha256: source.sourceSha256 }, reviewer: { label, principal }, findings: decisions, statement, now }).summary.overallDisposition}\n`);
  const confirmation = await ask(io, 'Create immutable proof bundle? [y/N]: ');
  if (!/^y(?:es)?$/i.test(confirmation)) throw new ProofError('proof creation cancelled', 'input', 2);
  return buildDecisionReceipt({ subject: { kind: source.kind, sha256: source.sourceSha256 }, reviewer: { label, principal }, findings: decisions, statement, now });
}

async function ask(io, prompt) {
  io.stdout.write(prompt);
  const answer = await io.readLine();
  if (answer === null) throw new ProofError('proof creation input ended unexpectedly', 'input', 2);
  if (!answer.trim()) throw new ProofError('proof creation input cannot be empty', 'input', 2);
  return answer.trim();
}
