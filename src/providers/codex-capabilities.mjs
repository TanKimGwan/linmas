import { spawn } from 'node:child_process';
import { EXIT_CODES, ReviewError } from '../review/errors.mjs';
import { LINMAS_VERSION } from '../core/version.mjs';

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_MODEL_PAGES = 5;
const FINAL_CLOSE_GRACE_MS = 20;
export const MAX_CAPABILITY_MODELS = 200;

export function selectCodexModel(models, requestedModel) {
  if (!Array.isArray(models)) throw classified('provider-configuration', 'Codex model inventory is unavailable', undefined, { stage: 'model-selection', reasonCode: 'MODEL_INVENTORY_INVALID', retryable: false });
  if (requestedModel !== undefined && requestedModel !== null && requestedModel !== '') {
    const match = models.find((item) => item?.id === requestedModel || item?.model === requestedModel);
    if (!match) throw classified('provider-configuration', `Requested Codex model is not available: ${sanitize(requestedModel)}`, undefined, { stage: 'model-selection', reasonCode: 'MODEL_NOT_AVAILABLE', retryable: false });
    return match.model;
  }

  if (models.length === 0) throw classified('provider-configuration', 'No account-visible models are available to this Codex account', undefined, { stage: 'model-selection', reasonCode: 'NO_VISIBLE_MODELS', retryable: false });
  const defaults = models.filter((item) => item?.isDefault === true);
  if (defaults.length === 1) return defaults[0].model;
  if (defaults.length > 1) throw classified('provider-configuration', 'Codex reported multiple default models; choose an explicit model');
  if (models.length === 1) return models[0].model;

  const choices = [...new Set(models.map((item) => item?.model).filter(Boolean))].slice(0, 10);
  throw classified('provider-configuration', `Multiple account-visible models are available; choose an explicit model: ${choices.join(', ')}`);
}

export function createCodexCapabilityProbe({
  command = 'codex',
  spawnImpl = spawn,
  timeoutMs = 5000,
  killGraceMs = 500
} = {}) {
  return {
    async read({ includeModels = false, signal } = {}) {
      if (signal?.aborted) throw classified('provider-transport', 'Codex capability discovery cancelled', signal.reason);

      let child;
      try {
        child = spawnImpl(command, ['app-server', '--stdio'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (cause) {
        throw startFailure(cause);
      }

      const session = createSession(child, { timeoutMs, signal });
      let primaryFailure;
      try {
        await session.request('initialize', {
          clientInfo: { name: 'linmas', version: LINMAS_VERSION },
          capabilities: { experimentalApi: true }
        });
        session.notify('initialized');

        const accountResult = await session.request('account/read', { refreshToken: false });
        const account = classifyAccount(accountResult);
        const models = includeModels ? await readModels(session) : null;
        return { ...account, models };
      } catch (cause) {
        primaryFailure = cause instanceof ReviewError
          ? cause
          : classified('provider-configuration', 'Codex capability discovery failed', cause);
        throw primaryFailure;
      } finally {
        session.dispose();
        try {
          await stopChild(child, { killGraceMs });
        } catch (cause) {
          if (primaryFailure) primaryFailure.cleanupCause = cause;
          else throw classified('provider-transport', 'Codex capability process could not be stopped', cause);
        }
      }
    }
  };
}

function createSession(child, { timeoutMs, signal }) {
  let nextId = 1;
  let stdoutBuffer = '';
  let stdoutBytes = 0;
  let stderr = '';
  let stderrBytes = 0;
  let disposed = false;
  const pending = new Map();
  let rejectFatal;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  fatal.catch(() => {});

  const fail = (error) => {
    if (disposed) return;
    rejectFatal(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const timer = setTimeout(() => {
    fail(classified('provider-timeout', 'Codex capability discovery timed out'));
  }, timeoutMs);
  const abort = () => fail(classified('provider-transport', 'Codex capability discovery cancelled', signal?.reason));
  signal?.addEventListener('abort', abort, { once: true });

  child.stdout?.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      fail(classified('provider-configuration', 'Codex capability output exceeds limit'));
      return;
    }
    stdoutBuffer += chunk.toString('utf8');
    while (stdoutBuffer.includes('\n')) {
      const newline = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (cause) {
        fail(classified('provider-configuration', 'Codex capability protocol returned invalid JSON', cause));
        return;
      }
      if (!Object.hasOwn(message, 'id')) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) {
        const error = classified('provider-configuration', `Codex capability protocol error: ${safeProtocolError(message.error)}`);
        if (message.error.code === -32601) error.capabilityUnavailable = true;
        waiter.reject(error);
      }
      else if (!Object.hasOwn(message, 'result')) waiter.reject(classified('provider-configuration', 'Codex capability response has no result'));
      else waiter.resolve(message.result);
    }
  });
  child.stderr?.on('data', (chunk) => {
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining <= 0) return;
    const bounded = chunk.subarray(0, remaining);
    stderr += bounded.toString('utf8');
    stderrBytes += bounded.length;
  });
  child.once('error', (cause) => fail(startFailure(cause)));
  child.once('close', (code, closeSignal) => {
    if (!disposed && pending.size > 0) {
      fail(classified('provider-transport', `Codex capability process exited before responding: ${code ?? closeSignal ?? 'unknown'} ${sanitize(stderr)}`.trim()));
    }
  });
  child.stdin?.once('error', (cause) => fail(classified('provider-transport', 'Codex capability request could not be written', cause)));

  const write = (message) => {
    if (!child.stdin?.writable) throw classified('provider-transport', 'Codex capability input is unavailable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return {
    request(method, params) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      write({ jsonrpc: '2.0', id, method, params });
      return Promise.race([response, fatal]);
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      for (const waiter of pending.values()) waiter.reject(classified('provider-transport', 'Codex capability session closed'));
      pending.clear();
    }
  };
}

function classifyAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.requiresOpenaiAuth !== 'boolean') {
    throw classified('provider-configuration', 'Codex account response is malformed');
  }
  if (value.account === null) throw classified('provider-authentication', 'Codex is not authenticated');
  if (!value.account || typeof value.account !== 'object' || Array.isArray(value.account)) {
    throw classified('provider-configuration', 'Codex account response is malformed');
  }
  if (value.account.type !== 'chatgpt' && value.account.type !== 'apiKey') {
    throw classified('provider-configuration', `Unsupported Codex account type: ${String(value.account.type ?? 'unknown')}`);
  }
  return { authMode: value.account.type, requiresOpenaiAuth: value.requiresOpenaiAuth };
}

async function readModels(session) {
  const models = [];
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const result = await session.request('model/list', { includeHidden: false, limit: MAX_CAPABILITY_MODELS, ...(cursor ? { cursor } : {}) });
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.data)) {
      throw classified('provider-configuration', 'Codex model inventory is malformed');
    }
    for (const model of result.data) {
      if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id || typeof model.model !== 'string' || !model.model) {
        throw classified('provider-configuration', 'Codex model entry is malformed');
      }
      models.push({ id: model.id, model: model.model, isDefault: model.isDefault === true });
      if (models.length > MAX_CAPABILITY_MODELS) throw classified('provider-configuration', `Codex model inventory exceeds ${MAX_CAPABILITY_MODELS} entries`);
    }
    if (result.nextCursor === null || result.nextCursor === undefined) return models;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) {
      throw classified('provider-configuration', 'Codex model pagination cursor is invalid');
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw classified('provider-configuration', `Codex model inventory exceeds ${MAX_MODEL_PAGES} pages`);
}

function stopChild(child, { killGraceMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let forceTimer;
    let finalTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(finalTimer);
      resolve();
    };
    child.once('close', finish);
    try { child.stdin?.end(); } catch { /* kill remains the cleanup boundary */ }
    try { child.kill('SIGTERM'); }
    catch { finish(); return; }
    forceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* final grace below */ }
      finalTimer = setTimeout(finish, FINAL_CLOSE_GRACE_MS);
    }, killGraceMs);
  });
}

function startFailure(cause) {
  return classified(cause?.code === 'ENOENT' ? 'provider-configuration' : 'provider-transport', 'Codex capability process failed to start', cause);
}

function classified(category, message, cause, metadata = {}) {
  const error = new ReviewError(message, category, EXIT_CODES.PROVIDER, {
    stage: metadata.stage ?? (category === 'provider-timeout' ? 'capability-startup' : category === 'provider-authentication' ? 'authentication' : 'capability-startup'),
    reasonCode: metadata.reasonCode ?? (category === 'provider-timeout' ? 'CAPABILITY_TIMEOUT' : category === 'provider-authentication' ? 'AUTHENTICATION_REQUIRED' : category === 'provider-transport' ? 'CAPABILITY_UNAVAILABLE' : 'CAPABILITY_START_FAILED'),
    retryable: metadata.retryable ?? (category === 'provider-timeout' || category === 'provider-transport'),
    transmissionState: metadata.transmissionState ?? 'not-started',
    ...metadata
  });
  error.failureClass = category;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function safeProtocolError(value) {
  if (!value || typeof value !== 'object') return 'unknown error';
  return sanitize(typeof value.message === 'string' ? value.message : 'unknown error');
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, 'Authorization=[redacted]')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 512);
}
