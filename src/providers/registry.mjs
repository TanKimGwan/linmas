import fs from 'node:fs';
import path from 'node:path';
import { createClaudeRunner } from './claude-api.mjs';
import { createCodexCapabilityProbe, selectCodexModel } from './codex-capabilities.mjs';
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

export function createProviderRegistry({
  env = process.env,
  platform = process.platform,
  fetchImpl = fetch,
  spawnImpl,
  binaryLookup = defaultBinaryLookup,
  createCodexCapabilityProbeImpl = createCodexCapabilityProbe
} = {}) {
  const claude = {
    id: 'claude',
    detectConfiguration({ env: source = env, model } = {}) {
      const missingRequirements = [];
      if (!source.ANTHROPIC_API_KEY) missingRequirements.push('ANTHROPIC_API_KEY');
      const resolvedModel = model ?? source.LINMAS_EVAL_MODEL;
      if (!resolvedModel) missingRequirements.push('LINMAS_EVAL_MODEL');
      const reason = missingRequirements.length ? `${missingRequirements.join(' and ')} ${missingRequirements.length === 1 ? 'is' : 'are'} not set` : 'Claude provider configuration is complete';
      return { provider: 'claude', status: missingRequirements.length ? 'missing' : 'configured', reason, defaultModel: source.LINMAS_EVAL_MODEL ?? null, missingRequirements };
    },
    prepareExecution(options = {}) {
      const configuration = this.detectConfiguration({ env, model: options.model });
      if (configuration.status !== 'configured') {
        throw new ReviewError('Claude provider configuration is incomplete', 'provider-configuration', EXIT_CODES.PROVIDER, {
          stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false,
          provider: 'claude', transmissionState: 'not-attempted', missingRequirements: configuration.missingRequirements
        });
      }
      return { ...options, model: options.model ?? env.LINMAS_EVAL_MODEL, authMode: 'api-key', modelVerified: false };
    },
    create({ model } = {}) {
      const resolvedModel = model ?? env.LINMAS_EVAL_MODEL;
      if (!env.ANTHROPIC_API_KEY) throw new ReviewError('Claude credentials are not configured', 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, provider: 'claude', transmissionState: 'not-attempted', missingRequirements: ['ANTHROPIC_API_KEY'] });
      if (!resolvedModel) throw new ReviewError('Claude model is required', 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, provider: 'claude', transmissionState: 'not-attempted', missingRequirements: ['LINMAS_EVAL_MODEL'] });
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
          : 'codex binary is available; authentication and model are verified at execution';
      return { provider: 'codex', status: binaryAvailable ? 'configured' : 'missing', reason, defaultModel: source.LINMAS_EVAL_MODEL ?? null, missingRequirements: binaryAvailable ? [] : ['CODEX_BINARY'] };
    },
    async discoverCapabilities({ includeModels = false, signal, timeoutMs } = {}) {
      const binary = binaryLookup('codex', { env, platform });
      if (!binary) throw new ReviewError('Codex binary is not configured', 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, provider: 'codex', transmissionState: 'not-attempted', missingRequirements: ['CODEX_BINARY'] });
      if (!isDirectExecutable(binary, platform) && binary !== true) {
        throw new ReviewError('Codex .cmd/.bat shims are unsupported without a shell; install a direct executable', 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, provider: 'codex', transmissionState: 'not-attempted', missingRequirements: ['CODEX_DIRECT_EXECUTABLE'] });
      }
      try {
        const probe = createCodexCapabilityProbeImpl({
          command: typeof binary === 'string' ? binary : 'codex',
          spawnImpl,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        });
        if (!probe || typeof probe.read !== 'function') throw providerConfiguration('Codex capability probe is invalid');
        return await probe.read({ includeModels, signal });
      } catch (error) {
        throw translateProviderError(error, 'codex');
      }
    },
    async prepareExecution(options = {}) {
      let capabilities;
      try {
        capabilities = await this.discoverCapabilities({
          includeModels: true,
          signal: options.signal,
          timeoutMs: options.capabilityTimeoutMs
        });
      } catch (error) {
        if (options.model && error?.capabilityUnavailable === true) {
          return { ...options, authMode: 'unverified', modelVerified: false };
        }
        throw error;
      }
      return {
        ...options,
        model: selectCodexModel(capabilities.models, options.model),
        authMode: capabilities.authMode,
        modelVerified: true
      };
    },
    create({ model, timeoutMs, cwd } = {}) {
      const resolvedModel = model ?? env.LINMAS_EVAL_MODEL;
      const binary = binaryLookup('codex', { env, platform });
      if (!binary) throw new ReviewError('Codex binary is not configured', 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, provider: 'codex', transmissionState: 'not-attempted', missingRequirements: ['CODEX_BINARY'] });
      if (!isDirectExecutable(binary, platform) && binary !== true) throw new ReviewError('Codex .cmd/.bat shims are unsupported without a shell; install a direct executable', 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, provider: 'codex', transmissionState: 'not-attempted', missingRequirements: ['CODEX_DIRECT_EXECUTABLE'] });
      if (!resolvedModel) throw new ReviewError('Codex model is required', 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, provider: 'codex', transmissionState: 'not-attempted', missingRequirements: ['LINMAS_EVAL_MODEL'] });
      return createManagedCodexRunner({ model: resolvedModel, command: typeof binary === 'string' ? binary : 'codex', spawnImpl, timeoutMs, cwd });
    }
  };
  return new Map([['claude', claude], ['codex', codex]]);
}

export function resolveProvider(registry, providerId, options) {
  const provider = getProviderDescriptor(registry, providerId);
  return createResolvedRunner(provider, providerId, options);
}

export async function prepareProviderExecution(registry, providerId, options = {}) {
  const provider = getProviderDescriptor(registry, providerId);
  let preparedOptions = options;
  if (typeof provider.prepareExecution === 'function') {
    try { preparedOptions = await provider.prepareExecution(options); }
    catch (error) { throw translateProviderError(error, providerId); }
    if (!preparedOptions || typeof preparedOptions !== 'object' || Array.isArray(preparedOptions)) {
      throw providerConfiguration(`provider ${providerId} returned invalid execution options`);
    }
  }

  const metadata = {
    provider: providerId,
    model: typeof preparedOptions.model === 'string' && preparedOptions.model ? preparedOptions.model : 'provider default',
    authMode: typeof preparedOptions.authMode === 'string' && preparedOptions.authMode ? preparedOptions.authMode : 'unverified',
    modelVerified: preparedOptions.modelVerified === true
  };
  let created = false;
  return {
    metadata,
    createRunner() {
      if (created) throw providerConfiguration(`provider ${providerId} runner was already created`);
      created = true;
      return createResolvedRunner(provider, providerId, preparedOptions);
    }
  };
}

function getProviderDescriptor(registry, providerId) {
  if (!providerId) throw new ReviewError('provider is required for execution', 'provider-configuration', EXIT_CODES.PROVIDER);
  if (!registry || typeof registry.get !== 'function') throw providerConfiguration('provider registry is invalid');
  const provider = registry.get(providerId);
  if (!provider) throw new ReviewError(`unsupported provider: ${providerId}`, 'provider-configuration', EXIT_CODES.PROVIDER);
  if (typeof provider !== 'object' || Array.isArray(provider) || typeof provider.create !== 'function') {
    throw providerConfiguration(`provider ${providerId} has an invalid descriptor`);
  }
  return provider;
}

function createResolvedRunner(provider, providerId, options) {
  let runner;
  try { runner = provider.create(options); }
    catch (error) { throw translateProviderError(error, providerId); }
  if (!runner || (typeof runner !== 'object' && typeof runner !== 'function') || typeof runner.run !== 'function') {
    throw providerConfiguration(`provider ${providerId} created an invalid runner`);
  }
  return {
    ...runner,
    async run(request) {
      try { return await runner.run(request); }
      catch (error) { throw translateProviderError(error, providerId); }
    }
  };
}

function providerConfiguration(message) {
  return new ReviewError(message, 'provider-configuration', EXIT_CODES.PROVIDER, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, transmissionState: 'not-attempted' });
}

function translateProviderError(error, providerId = null) {
  if (error instanceof ReviewError) {
    if (!error.provider) error.provider = providerId;
    return error;
  }
  const failureClass = error && typeof error === 'object' ? error.failureClass : undefined;
  const normalization = failureClass === 'normalization-failed';
  const responseInvalid = failureClass === 'provider-response-invalid';
  const message = error instanceof Error && error.message ? error.message : String(error ?? 'provider execution failed');
  return new ReviewError(message, normalization ? 'normalization' : responseInvalid ? 'provider-response-invalid' : failureClass ?? 'provider-transport', normalization ? EXIT_CODES.CONTRACT : EXIT_CODES.PROVIDER, {
    stage: error?.stage ?? (normalization || responseInvalid ? 'normalization' : 'provider-execution'),
    reasonCode: error?.reasonCode ?? null,
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : null,
    provider: error?.provider ?? providerId,
    transmissionState: error?.transmissionState ?? 'unknown',
    missingRequirements: error?.missingRequirements ?? null,
    httpStatus: error?.httpStatus ?? null
  });
}
