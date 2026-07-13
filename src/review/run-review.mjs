import { formatReviewResult } from './format-review.mjs';
import { loadReviewInput } from './load-input.mjs';
import { prepareReview } from './prepare-review.mjs';
import { normalizeProviderResponse } from './normalize-response.mjs';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { resolveProvider } from '../providers/registry.mjs';
import { loadPolicyPack } from '../policy/load-pack.mjs';
import { evaluatePolicy } from '../policy/evaluate-policy.mjs';
import { formatPolicyResult } from '../policy/format-policy.mjs';

export async function runReview(args, { io, cwd = process.cwd(), rootDir, providerRegistry, loadPolicy = loadPolicyPack }) {
  if (args.policyId && args.policyFile) {
    throw new ReviewError('provide exactly one policy id or policy file', 'input', EXIT_CODES.INPUT);
  }
  if ((args.policyId || args.policyFile) && !args.provider) {
    throw new ReviewError('policy evaluation requires --provider', 'input', EXIT_CODES.INPUT);
  }

  const input = await loadReviewInput({ inputPath: args.inputPath, useStdin: args.useStdin, stdin: io.stdin, cwd });
  const request = prepareReview({ input, skillName: args.skillName });

  if (!args.provider) {
    return {
      exitCode: EXIT_CODES.OK,
      output: `${JSON.stringify(request, null, 2)}\nNo data was transmitted.\n`
    };
  }

  if (!request.specialist) {
    throw new ReviewError(
      `select --skill after reviewing recommendations: ${request.recommendations.join(', ') || 'none'}`,
      'input',
      EXIT_CODES.INPUT
    );
  }

  const summary = `Outbound review\nsource: ${input.source}\nbytes: ${input.bytes}\nspecialist: ${request.specialist}\nprovider: ${args.provider}\nmodel: ${args.model ?? 'provider default'}\ndata leaves this machine: yes\n`;
  io.stdout.write(summary);
  if (!args.assumeYes) {
    if (!io.isTTY) throw new ReviewError('non-interactive execution requires --yes', 'input', EXIT_CODES.INPUT);
    if ((await io.readLine()).trim().toLowerCase() !== 'yes') {
      throw new ReviewError('outbound transmission not confirmed', 'input', EXIT_CODES.INPUT);
    }
  }

  const runner = resolveProvider(providerRegistry, args.provider, { model: args.model });
  const runResult = await runner.run({
    system: 'Return only ReviewResult schemaVersion 1 JSON.',
    user: JSON.stringify(request)
  });
  const reviewResult = normalizeProviderResponse(runResult, {
    caseId: 'review/local',
    specialist: request.specialist
  });

  if (!args.policyId && !args.policyFile) {
    return { exitCode: EXIT_CODES.OK, output: formatReviewResult(reviewResult, { output: args.output }) };
  }

  const policy = loadPolicy({
    id: args.policyId,
    filePath: args.policyFile,
    rootDir,
    cwd
  });
  if (!policy.specialists.includes(reviewResult.specialist)) {
    throw new ReviewError(`policy does not accept specialist: ${reviewResult.specialist}`, 'input', EXIT_CODES.INPUT);
  }
  if (!policy.modes.includes(request.mode)) {
    throw new ReviewError(`policy does not accept mode: ${request.mode}`, 'input', EXIT_CODES.INPUT);
  }
  const policyResult = evaluatePolicy(policy, reviewResult);
  if (args.output === 'json') {
    return {
      exitCode: EXIT_CODES.OK,
      output: `${JSON.stringify({ review: reviewResult, policy: policyResult }, null, 2)}\n`
    };
  }
  return {
    exitCode: EXIT_CODES.OK,
    output: `${formatReviewResult(reviewResult)}\n${formatPolicyResult(policyResult)}`
  };
}
