import fs from 'node:fs';
import path from 'node:path';
import { createClaudeRunner } from './claude-api.mjs';
import { createManagedCodexRunner } from './codex-cli.mjs';
import { EXIT_CODES, ReviewError } from '../review/errors.mjs';

function defaultBinaryLookup(name, { env = process.env } = {}) {
  return (env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; }
    catch { return false; }
  });
}

export function createProviderRegistry({ env = process.env, fetchImpl = fetch, spawnImpl, binaryLookup = defaultBinaryLookup } = {}) {
  const claude = {
    id: 'claude',
    detectConfiguration({ env: source = env } = {}) {
      const reason = !source.ANTHROPIC_API_KEY
        ? 'ANTHROPIC_API_KEY is not set'
        : !source.LINMAS_EVAL_MODEL ? 'LINMAS_EVAL_MODEL is not set' : 'ANTHROPIC_API_KEY and LINMAS_EVAL_MODEL are configured';
      return { provider: 'claude', status: source.ANTHROPIC_API_KEY && source.LINMAS_EVAL_MODEL ? 'configured' : 'missing', reason, defaultModel: source.LINMAS_EVAL_MODEL ?? null };
    },
    create({ model = env.LINMAS_EVAL_MODEL } = {}) {
      if (!env.ANTHROPIC_API_KEY) throw new ReviewError('Claude credentials are not configured', 'provider-configuration', EXIT_CODES.PROVIDER);
      if (!model) throw new ReviewError('Claude model is required', 'provider-configuration', EXIT_CODES.PROVIDER);
      return createClaudeRunner({ apiKey: env.ANTHROPIC_API_KEY, model, fetchImpl });
    }
  };
  const codex = {
    id: 'codex',
    detectConfiguration({ env: source = env } = {}) {
      const binaryAvailable = binaryLookup('codex', { env: source });
      const reason = !binaryAvailable ? 'codex binary is not available' : !source.LINMAS_EVAL_MODEL ? 'LINMAS_EVAL_MODEL is not set' : 'codex binary and LINMAS_EVAL_MODEL are configured';
      return { provider: 'codex', status: binaryAvailable && source.LINMAS_EVAL_MODEL ? 'configured' : 'missing', reason, defaultModel: source.LINMAS_EVAL_MODEL ?? null };
    },
    create({ model = env.LINMAS_EVAL_MODEL, timeoutMs } = {}) {
      if (!binaryLookup('codex', { env })) throw new ReviewError('Codex binary is not configured', 'provider-configuration', EXIT_CODES.PROVIDER);
      if (!model) throw new ReviewError('Codex model is required', 'provider-configuration', EXIT_CODES.PROVIDER);
      return createManagedCodexRunner({ model, spawnImpl, timeoutMs });
    }
  };
  return new Map([['claude', claude], ['codex', codex]]);
}

export function resolveProvider(registry, providerId, options) {
  if (!providerId) throw new ReviewError('provider is required for execution', 'provider-configuration', EXIT_CODES.PROVIDER);
  const provider = registry.get(providerId);
  if (!provider) throw new ReviewError(`unsupported provider: ${providerId}`, 'provider-configuration', EXIT_CODES.PROVIDER);
  return provider.create(options);
}
