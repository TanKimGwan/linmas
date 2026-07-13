import { createClaudeRunner } from './claude-api.mjs';
import { EXIT_CODES, ReviewError } from '../review/errors.mjs';

export function createProviderRegistry({ env = process.env, fetchImpl = fetch } = {}) {
  return new Map([['claude', {
    id: 'claude',
    detectConfiguration({ env: source = env } = {}) {
      return {
        provider: 'claude',
        status: source.ANTHROPIC_API_KEY && source.LINMAS_EVAL_MODEL ? 'configured' : 'missing',
        reason: source.ANTHROPIC_API_KEY ? 'API credential present; model configuration checked' : 'ANTHROPIC_API_KEY is not set',
        defaultModel: source.LINMAS_EVAL_MODEL ?? null
      };
    },
    create({ model = env.LINMAS_EVAL_MODEL } = {}) {
      if (!env.ANTHROPIC_API_KEY) throw new ReviewError('Claude credentials are not configured', 'provider-configuration', EXIT_CODES.PROVIDER);
      if (!model) throw new ReviewError('Claude model is required', 'provider-configuration', EXIT_CODES.PROVIDER);
      return createClaudeRunner({ apiKey: env.ANTHROPIC_API_KEY, model, fetchImpl });
    }
  }]]);
}

export function resolveProvider(registry, providerId, options) {
  if (!providerId) throw new ReviewError('provider is required for execution', 'provider-configuration', EXIT_CODES.PROVIDER);
  const provider = registry.get(providerId);
  if (!provider) throw new ReviewError(`unsupported provider: ${providerId}`, 'provider-configuration', EXIT_CODES.PROVIDER);
  return provider.create(options);
}
