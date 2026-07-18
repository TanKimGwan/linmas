import fs from 'node:fs';
import path from 'node:path';
import { createClaudeRunner } from './claude-api.mjs';
import { createManagedCodexRunner } from './codex-cli.mjs';
import { EXIT_CODES, ReviewError } from '../review/errors.mjs';

export function defaultBinaryLookup(name, { env = process.env, platform = process.platform, accessSync = fs.accessSync } = {}) {
  const windows = platform === 'win32';
  const delimiter = windows ? ';' : path.delimiter;
  const extensions = windows
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((extension) => extension.startsWith('.') ? extension : `.${extension}`)
    : [''];
  const candidates = windows ? [name, ...extensions.map((extension) => `${name}${extension}`)] : [name];
  for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const executable = path.join(dir, candidate);
      try {
        accessSync(executable, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return executable;
      } catch { /* try the next candidate */ }
    }
  }
  return null;
}

function isDirectExecutable(binary, platform) {
  return typeof binary === 'string' && (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(binary));
}

export function createProviderRegistry({ env = process.env, platform = process.platform, fetchImpl = fetch, spawnImpl, binaryLookup = defaultBinaryLookup } = {}) {
  const claude = {
    id: 'claude',
    detectConfiguration({ env: source = env } = {}) {
      const reason = !source.ANTHROPIC_API_KEY
        ? 'ANTHROPIC_API_KEY is not set'
        : !source.LINMAS_EVAL_MODEL ? 'LINMAS_EVAL_MODEL is not set' : 'ANTHROPIC_API_KEY and LINMAS_EVAL_MODEL are configured';
      return { provider: 'claude', status: source.ANTHROPIC_API_KEY && source.LINMAS_EVAL_MODEL ? 'configured' : 'missing', reason, defaultModel: source.LINMAS_EVAL_MODEL ?? null };
    },
    create({ model } = {}) {
      const resolvedModel = model ?? env.LINMAS_EVAL_MODEL;
      if (!env.ANTHROPIC_API_KEY) throw new ReviewError('Claude credentials are not configured', 'provider-configuration', EXIT_CODES.PROVIDER);
      if (!resolvedModel) throw new ReviewError('Claude model is required', 'provider-configuration', EXIT_CODES.PROVIDER);
      return createClaudeRunner({ apiKey: env.ANTHROPIC_API_KEY, model: resolvedModel, fetchImpl });
    }
  };
  const codex = {
    id: 'codex',
    detectConfiguration({ env: source = env } = {}) {
      const binary = binaryLookup('codex', { env: source, platform });
      const binaryAvailable = isDirectExecutable(binary, platform) || binary === true;
      const reason = !binary
        ? 'codex binary is not available'
        : !binaryAvailable
          ? 'codex .cmd/.bat shims are unsupported without a shell; install a direct executable'
          : !source.LINMAS_EVAL_MODEL ? 'LINMAS_EVAL_MODEL is not set' : 'codex binary and LINMAS_EVAL_MODEL are configured';
      return { provider: 'codex', status: binaryAvailable && source.LINMAS_EVAL_MODEL ? 'configured' : 'missing', reason, defaultModel: source.LINMAS_EVAL_MODEL ?? null };
    },
    create({ model, timeoutMs, cwd } = {}) {
      const resolvedModel = model ?? env.LINMAS_EVAL_MODEL;
      const binary = binaryLookup('codex', { env, platform });
      if (!binary) throw new ReviewError('Codex binary is not configured', 'provider-configuration', EXIT_CODES.PROVIDER);
      if (!isDirectExecutable(binary, platform) && binary !== true) throw new ReviewError('Codex .cmd/.bat shims are unsupported without a shell; install a direct executable', 'provider-configuration', EXIT_CODES.PROVIDER);
      if (!resolvedModel) throw new ReviewError('Codex model is required', 'provider-configuration', EXIT_CODES.PROVIDER);
      return createManagedCodexRunner({ model: resolvedModel, command: typeof binary === 'string' ? binary : 'codex', spawnImpl, timeoutMs, cwd });
    }
  };
  return new Map([['claude', claude], ['codex', codex]]);
}

export function resolveProvider(registry, providerId, options) {
  if (!providerId) throw new ReviewError('provider is required for execution', 'provider-configuration', EXIT_CODES.PROVIDER);
  if (!registry || typeof registry.get !== 'function') throw providerConfiguration('provider registry is invalid');
  const provider = registry.get(providerId);
  if (!provider) throw new ReviewError(`unsupported provider: ${providerId}`, 'provider-configuration', EXIT_CODES.PROVIDER);
  if (typeof provider !== 'object' || Array.isArray(provider) || typeof provider.create !== 'function') {
    throw providerConfiguration(`provider ${providerId} has an invalid descriptor`);
  }
  let runner;
  try { runner = provider.create(options); }
  catch (error) { throw translateProviderError(error); }
  if (!runner || (typeof runner !== 'object' && typeof runner !== 'function') || typeof runner.run !== 'function') {
    throw providerConfiguration(`provider ${providerId} created an invalid runner`);
  }
  return {
    ...runner,
    async run(request) {
      try { return await runner.run(request); }
      catch (error) { throw translateProviderError(error); }
    }
  };
}

function providerConfiguration(message) {
  return new ReviewError(message, 'provider-configuration', EXIT_CODES.PROVIDER);
}

function translateProviderError(error) {
  if (error instanceof ReviewError) return error;
  const failureClass = error && typeof error === 'object' ? error.failureClass : undefined;
  const normalization = failureClass === 'normalization-failed';
  const message = error instanceof Error && error.message ? error.message : String(error ?? 'provider execution failed');
  return new ReviewError(message, normalization ? 'normalization' : failureClass ?? 'provider-transport', normalization ? EXIT_CODES.CONTRACT : EXIT_CODES.PROVIDER);
}
