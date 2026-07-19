import path from 'node:path';
import { loadProofEvidence } from './load-evidence.mjs';
import { collectDecisionReceipt } from './wizard.mjs';
import { writeProofBundle } from './write-bundle.mjs';
import { verifyProofBundle } from './verify-bundle.mjs';
import { ProofError } from './errors.mjs';

export async function runProof(args, { io, cwd = process.cwd(), now = () => new Date() } = {}) {
  if (args.proofErrors?.length) throw new ProofError(args.proofErrors.join('; '), 'input', 2);
  if (args.proofAction === 'create') {
    if (!args.proofSource || !args.proofBundle) throw new ProofError('proof create requires source and --bundle', 'input', 2);
    const source = await loadProofEvidence(path.resolve(cwd, args.proofSource));
    const receipt = await collectDecisionReceipt(source, { io, signing: Boolean(args.signingKey), now: now() });
    const result = await writeProofBundle(path.resolve(cwd, args.proofBundle), source, receipt, { now: now(), signingKey: args.signingKey ? path.resolve(cwd, args.signingKey) : null });
    io.stdout.write(`Proof bundle created: ${result.path}\n`);
    return { exitCode: 0, output: '' };
  }
  if (args.proofAction === 'verify') {
    if (!args.proofSource) throw new ProofError('proof verify requires a bundle directory', 'input', 2);
    if (args.signingKey) throw new ProofError('--signing-key is only valid with proof create', 'input', 2);
    const result = await verifyProofBundle(path.resolve(cwd, args.proofSource), { allowedSignersPath: args.allowedSigners ? path.resolve(cwd, args.allowedSigners) : null });
    const output = args.output === 'json'
      ? `${JSON.stringify(result, null, 2)}\n`
      : `LINMAS PROOF VERIFICATION\nIntegrity   ${result.integrity}\nSignature   ${result.signature}\nIdentity     ${result.identity}\nSafety       Human review remains required.\n`;
    io.stdout.write(output);
    return { exitCode: 0, output };
  }
  throw new ProofError('proof action must be create or verify', 'input', 2);
}
