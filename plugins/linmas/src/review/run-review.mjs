import { formatReviewResult } from './format-review.mjs';
import { loadReviewInput } from './load-input.mjs';
import { prepareReview } from './prepare-review.mjs';
import { normalizeProviderResponse } from './normalize-response.mjs';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { prepareProviderExecution } from '../providers/registry.mjs';
import { loadPolicyPack } from '../policy/load-pack.mjs';
import { evaluatePolicy } from '../policy/evaluate-policy.mjs';
import { formatPolicyResult } from '../policy/format-policy.mjs';
import { buildReviewCapsule } from './build-capsule.mjs';
import { preflightCapsuleDestination, writeReviewCapsule } from './write-capsule.mjs';

export async function runReview(args, { io, cwd = process.cwd(), rootDir, providerRegistry, loadPolicy = loadPolicyPack, now = () => new Date() }) {
  if (args.policyId && args.policyFile) {
    throw new ReviewError('provide exactly one policy id or policy file', 'input', EXIT_CODES.INPUT);
  }
  if ((args.policyId || args.policyFile) && !args.provider) {
    throw new ReviewError('policy evaluation requires --provider', 'input', EXIT_CODES.INPUT);
  }
  if (args.capsulePath && !args.provider) {
    throw new ReviewError('capsule generation requires --provider', 'input', EXIT_CODES.INPUT);
  }
  if (args.provider && args.useStdin && !args.assumeYes) {
    throw new ReviewError('--stdin requires --yes; interactive confirmation cannot share stdin with the review input', 'input', EXIT_CODES.INPUT);
  }

  const input = await loadReviewInput({ inputPath: args.inputPath, useStdin: args.useStdin, stdin: io.stdin, cwd });
  const request = prepareReview({ input, skillName: args.skillName });
  const capsuleTarget = args.capsulePath
    ? await preflightCapsuleDestination(args.capsulePath, { cwd })
    : null;

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

  let policy = null;
  if (args.policyId || args.policyFile) {
    try {
      policy = loadPolicy({ id: args.policyId, filePath: args.policyFile, rootDir, cwd });
    } catch (error) {
      throw new ReviewError(error?.message ?? String(error), 'input', EXIT_CODES.INPUT);
    }
    assertPolicyAcceptsSpecialist(policy, request.specialist);
    if (!policy.modes.includes(request.mode)) {
      throw new ReviewError(`policy does not accept mode: ${request.mode}`, 'input', EXIT_CODES.INPUT);
    }
  }

  const execution = await prepareProviderExecution(providerRegistry, args.provider, { model: args.model, cwd });
  const summary = `Outbound review\nsource: ${input.source}\nbytes: ${input.bytes}\nspecialist: ${request.specialist}\nprovider: ${execution.metadata.provider}\nauth: ${execution.metadata.authMode}\nmodel: ${execution.metadata.model}\nmodel verified: ${execution.metadata.modelVerified ? 'yes' : 'no'}\ndata leaves this machine: yes\n`;
  io.stdout.write(summary);
  if (!args.assumeYes) {
    if (io.isInteractive !== true && io.isTTY !== true) throw new ReviewError('non-interactive execution requires --yes', 'input', EXIT_CODES.INPUT);
    io.stdout.write('Type yes to transmit: ');
    const confirmation = await io.readLine();
    if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== 'yes') {
      throw new ReviewError('outbound transmission not confirmed', 'input', EXIT_CODES.INPUT);
    }
  }

  const runner = execution.createRunner();
  const runResult = await runner.run({
    system: 'Return only ReviewResult schemaVersion 1 JSON.',
    user: JSON.stringify(request)
  });
  const reviewResult = normalizeProviderResponse(runResult, {
    caseId: 'review/local',
    specialist: request.specialist
  });

  let policyResult = null;
  if (policy) {
    // The provider response may carry its own specialist, so re-check it before evaluating.
    assertPolicyAcceptsSpecialist(policy, reviewResult.specialist);
    policyResult = evaluatePolicy(policy, reviewResult);
  }

  if (capsuleTarget) {
    const capsule = buildReviewCapsule({
      input: { source: input.source, bytes: input.bytes, sha256: input.sha256 },
      execution: {
        mode: 'live',
        provider: reviewResult.modelMetadata.provider,
        authMode: execution.metadata.authMode,
        model: reviewResult.modelMetadata.model,
        modelVerified: execution.metadata.modelVerified === true
          && execution.metadata.model === reviewResult.modelMetadata.model
      },
      review: reviewResult,
      policyResult,
      now: now()
    });
    await writeReviewCapsule(capsuleTarget, capsule);
  }

  if (!policyResult) return { exitCode: EXIT_CODES.OK, output: formatReviewResult(reviewResult, { output: args.output }) };
  if (args.output === 'json') return { exitCode: EXIT_CODES.OK, output: `${JSON.stringify({ review: reviewResult, policy: policyResult }, null, 2)}\n` };
  return {
    exitCode: EXIT_CODES.OK,
    output: `${formatReviewResult(reviewResult)}\n${formatPolicyResult(policyResult)}`
  };
}

function assertPolicyAcceptsSpecialist(policy, specialist) {
  if (!policy.specialists.includes(specialist)) {
    throw new ReviewError(`policy does not accept specialist: ${specialist}`, 'input', EXIT_CODES.INPUT);
  }
}
