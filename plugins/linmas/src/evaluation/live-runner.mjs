import { createProviderRegistry, resolveProvider } from '../providers/registry.mjs';

export function createLiveEvaluationRunner({ env = process.env, registry } = {}) {
  const provider = env.LINMAS_EVAL_PROVIDER || 'codex';
  const model = env.LINMAS_EVAL_MODEL;
  if (!model) throw new Error('LINMAS_EVAL_MODEL is required');
  const providers = registry || createProviderRegistry({ env });
  return resolveProvider(providers, provider, { model });
}
