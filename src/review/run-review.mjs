import { formatReviewResult } from './format-review.mjs';
import { loadReviewInput } from './load-input.mjs';
import { prepareReview } from './prepare-review.mjs';
import { normalizeProviderResponse } from './normalize-response.mjs';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { resolveProvider } from '../providers/registry.mjs';

export async function runReview(args, { io, cwd = process.cwd(), providerRegistry }) {
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
  const result = normalizeProviderResponse(runResult, {
    caseId: 'review/local',
    specialist: request.specialist
  });
  return { exitCode: EXIT_CODES.OK, output: formatReviewResult(result, { output: args.output }) };
}
