import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EXIT_CODES, ReviewError } from '../review/errors.mjs';

const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const FINAL_CLOSE_GRACE_MS = 20;

export const REVIEW_RESULT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'scopeAndAssumptions', 'findings', 'deterministicChecks', 'safetyBoundary'],
  properties: {
    schemaVersion: { const: 1 },
    caseId: { type: 'string', minLength: 1 },
    specialist: { type: 'string', minLength: 1 },
    modelMetadata: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model'],
      properties: {
        provider: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
        generatedAt: { type: 'string', minLength: 1 },
        usage: { type: ['object', 'null'] },
        requestId: { type: ['string', 'null'] }
      }
    },
    scopeAndAssumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'severity', 'evidence', 'affectedSurface', 'preconditions', 'remediation', 'verification'],
        properties: {
          id: { type: 'string', minLength: 1 },
          status: { enum: ['Confirmed finding', 'Needs validation', 'Recommendation'] },
          severity: { enum: ['Critical', 'High', 'Medium', 'Low', 'Info'] },
          evidence: { type: 'string', minLength: 1 },
          affectedSurface: { type: 'string', minLength: 1 },
          preconditions: { type: 'string', minLength: 1 },
          remediation: { type: 'string', minLength: 1 },
          verification: { type: 'string', minLength: 1 }
        }
      }
    },
    deterministicChecks: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string', minLength: 1 },
          {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'completed'],
            properties: { id: { type: 'string', minLength: 1 }, completed: { type: 'boolean' } }
          }
        ]
      }
    },
    safetyBoundary: {
      type: 'object',
      additionalProperties: false,
      required: ['satisfied', 'humanReviewRequired', 'statement'],
      properties: {
        satisfied: { type: 'boolean' },
        humanReviewRequired: { const: true },
        statement: { type: 'string', minLength: 1 }
      }
    }
  }
});

function codexArgs(model, schemaPath, outputPath) {
  return ['exec', '--model', model, '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check', '--output-schema', schemaPath, '--output-last-message', outputPath, '-'];
}

export function createManagedCodexRunner({ model, spawnImpl, timeoutMs, cwd, tempRoot = os.tmpdir(), removeImpl = fs.rm } = {}) {
  return {
    id: 'codex', model,
    async run(request) {
      let tempDir;
      let failure;
      try {
        tempDir = await fs.mkdtemp(path.join(tempRoot, 'linmas-codex-'));
        const schemaPath = path.join(tempDir, 'review-result.schema.json');
        const outputPath = path.join(tempDir, 'last-message.json');
        await fs.writeFile(schemaPath, JSON.stringify(REVIEW_RESULT_SCHEMA), { mode: 0o600 });
        return await createCodexRunner({ model, schemaPath, outputPath, cwd: tempDir, spawnImpl, timeoutMs }).run(request);
      } catch (cause) {
        failure = cause instanceof ReviewError
          ? cause
          : classified('provider-configuration', 'Codex schema workspace could not be prepared', cause);
        throw failure;
      } finally {
        if (tempDir) {
          try { await removeImpl(tempDir, { recursive: true, force: true }); }
          catch (cause) {
            if (failure) failure.cleanupCause = cause;
            else throw classified('provider-configuration', 'Codex schema workspace could not be removed', cause);
          }
        }
      }
    }
  };
}

export function createCodexRunner({ model, schemaPath, outputPath, cwd = path.dirname(schemaPath), spawnImpl = spawn, timeoutMs = 60000, killGraceMs = 5000 } = {}) {
  if (!model || !schemaPath || !outputPath) throw classified('provider-configuration', 'Codex model, schemaPath, and outputPath are required');
  return {
    id: 'codex', model,
    async run({ system, user, signal } = {}) {
      if (signal?.aborted) throw classified('provider-transport', 'Codex invocation cancelled', signal.reason);
      let child;
      try {
        child = spawnImpl('codex', codexArgs(model, schemaPath, outputPath), { cwd, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (cause) {
        throw classified(cause?.code === 'ENOENT' ? 'provider-configuration' : 'provider-transport', 'Codex invocation failed to start', cause);
      }
      const outcome = await collectBoundedProcess(child, { input: `${system}\n\n${user}`, timeoutMs, killGraceMs, signal });
      if (outcome.error) {
        const category = outcome.error.code === 'ENOENT' ? 'provider-configuration' : 'provider-transport';
        throw classified(category, 'Codex invocation failed to start', outcome.error);
      }
      if (outcome.timedOut) throw classified('provider-timeout', 'Codex invocation timed out');
      if (outcome.aborted) throw classified('provider-transport', 'Codex invocation cancelled', signal?.reason);
      if (outcome.code !== 0) {
        const stderr = outcome.stderr;
        const category = /(?:401|403|unauthori[sz]ed|forbidden|authentication|invalid api key|login required)/i.test(stderr)
          ? 'provider-authentication'
          : /(?:429|rate[ -]?limit|too many requests|quota)/i.test(stderr)
            ? 'provider-rate-limit'
            : 'provider-transport';
        throw classified(category, `Codex exited ${outcome.code}: ${sanitize(stderr)}`);
      }
      let rawResponse;
      try {
        const handle = await fs.open(outputPath, 'r');
        try {
          const buffer = Buffer.alloc(MAX_RESPONSE_BYTES + 1);
          const { bytesRead } = await handle.read(buffer, 0, MAX_RESPONSE_BYTES + 1, 0);
          if (bytesRead > MAX_RESPONSE_BYTES) throw classified('provider-transport', `Codex response exceeds ${MAX_RESPONSE_BYTES} bytes`);
          rawResponse = buffer.toString('utf8', 0, bytesRead);
        } finally {
          await handle.close();
        }
      } catch (cause) {
        if (cause instanceof ReviewError) throw cause;
        throw classified('provider-transport', 'Codex did not produce a final response', cause);
      }
      return { provider: 'codex', model, rawResponse, usage: null, requestId: randomUUID() };
    }
  };
}

function collectBoundedProcess(child, { input, timeoutMs, killGraceMs, signal }) {
  return new Promise((resolve) => {
    let stderr = '';
    let stderrBytes = 0;
    let error;
    let timedOut = false;
    let settled = false;
    let stopped = false;
    let forceTimer;
    let cleanupTimer;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ stderr, error, timedOut, aborted: signal?.aborted === true, ...value });
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        cleanupTimer = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), FINAL_CLOSE_GRACE_MS);
      }, killGraceMs);
    };
    const abort = () => stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      if (remaining <= 0) return;
      const value = chunk.subarray(0, remaining);
      stderr += value.toString('utf8');
      stderrBytes += value.length;
    });
    child.once('error', (cause) => { error = cause; finish({ code: null, signal: null }); });
    child.once('close', (code, closeSignal) => finish({ code, signal: closeSignal }));
    child.once('exit', (code, closeSignal) => {
      if (timedOut || signal?.aborted) finish({ code, signal: closeSignal });
    });
    child.stdin?.once('error', (cause) => {
      finish({ code: null, signal: null, error: cause });
    });
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(input);
  });
}

function classified(category, message, cause) {
  const error = new ReviewError(message, category, EXIT_CODES.PROVIDER);
  error.failureClass = category;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function sanitize(value) {
  return value
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, 'Authorization=[redacted]')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g, '[redacted-github-token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .slice(0, 512);
}
