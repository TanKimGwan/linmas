import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REVIEW_RESULT_SCHEMA, MAX_RESPONSE_BYTES, createCodexRunner, createManagedCodexRunner } from '../src/providers/codex-cli.mjs';
import { createProviderRegistry, resolveProvider } from '../src/providers/registry.mjs';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';

const validJson = '{"schemaVersion":1}';
const request = { system: 'Return ReviewResult JSON.', user: 'review this input' };

function fakeSpawn({ lastMessage = validJson, stderr = '', code = 0, delay = 0, error } = {}, calls = []) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { child.killedWith = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
    calls.push({ command, args, options, child });
    queueMicrotask(async () => {
      if (error) {
        child.emit('error', error);
        return queueMicrotask(() => child.emit('close', null, null));
      }
      child.stderr.end(stderr);
      if (lastMessage !== null) {
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        await writeFile(outputPath, lastMessage);
      }
      setTimeout(() => child.emit('close', code, null), delay);
    });
    return child;
  };
}

async function withPaths(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'linmas-codex-test-'));
  const schemaPath = path.join(dir, 'review-result.schema.json');
  const outputPath = path.join(dir, 'last-message.json');
  try { return await callback({ schemaPath, outputPath }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function assertProviderError(error, category) {
  assert.ok(error instanceof ReviewError);
  assert.equal(error.category, category);
  assert.equal(error.failureClass, category);
  assert.equal(error.exitCode, EXIT_CODES.PROVIDER);
  return true;
}

test('runs Codex read-only with supported pinned flags and reads the final message', async () => {
  await withPaths(async ({ schemaPath, outputPath }) => {
    const calls = [];
    const runner = createCodexRunner({ model: 'codex-model', schemaPath, outputPath, spawnImpl: fakeSpawn({}, calls) });
    const result = await runner.run(request);
    assert.equal(calls[0].command, 'codex');
    assert.deepEqual(calls[0].args, ['exec', '--model', 'codex-model', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema', schemaPath, '--output-last-message', outputPath, '-']);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].child.stdin.read().toString(), 'Return ReviewResult JSON.\n\nreview this input');
    assert.equal(result.provider, 'codex');
    assert.equal(result.model, 'codex-model');
    assert.equal(result.rawResponse, validJson);
  });
});

test('safetyBoundary schema enforces canonical object contract only', () => {
  const schema = REVIEW_RESULT_SCHEMA.properties.safetyBoundary;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['satisfied', 'humanReviewRequired', 'statement']);
  assert.equal(schema.properties.humanReviewRequired.const, true);
  assert.equal(schema.properties.humanReviewRequired.type, 'boolean');
  assert.equal(schema.properties.satisfied.const, true);
  assert.equal(schema.properties.satisfied.type, 'boolean');
  assert.equal(schema.properties.statement.type, 'string');
  assert.equal(schema.properties.statement.const, 'Human review remains required.');
  assert.equal(schema.anyOf, undefined, 'string variant must be removed');
});

test('safetyBoundary schema accepts GitHub fine-grained PAT in redaction', async () => {
  await withPaths(async (paths) => {
    const stderr = 'token=github_pat_11AA_TEST_SYNTHETIC_VALUE abc123';
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ code: 1, stderr }) });
    await assert.rejects(runner.run(request), (error) => {
      assert.doesNotMatch(error.message, /github_pat_11AA_TEST_SYNTHETIC_VALUE/);
      assert.doesNotMatch(error.message, /github_pat_/);
      return true;
    });
  });
});

test('classifies missing binary as provider configuration', async () => {
  await withPaths(async (paths) => {
    const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ error: missing }) });
    await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-configuration'));
  });
});

test('classifies timeout, nonzero exit, and absent output as provider failures, including auth and rate limits', async (t) => {
  await t.test('timeout', async () => withPaths(async (paths) => {
    const runner = createCodexRunner({ model: 'm', ...paths, timeoutMs: 1, spawnImpl: fakeSpawn({ delay: 100 }) });
    await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-timeout'));
  }));
  await t.test('nonzero exit', async () => withPaths(async (paths) => {
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ code: 7, stderr: 'Authorization: Bearer secret token=other-secret failure' }) });
    await assert.rejects(runner.run(request), (error) => {
      assertProviderError(error, 'provider-transport');
      assert.match(error.message, /Authorization=\[redacted\]/);
      assert.match(error.message, /token=\[redacted\]/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }));
  await t.test('authentication', async () => withPaths(async (paths) => {
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ code: 1, stderr: '401 Unauthorized' }) });
    await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-authentication'));
  }));
  await t.test('rate limit', async () => withPaths(async (paths) => {
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ code: 1, stderr: '429 rate limit exceeded' }) });
    await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-rate-limit'));
  }));
  await t.test('absent output', async () => withPaths(async (paths) => {
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ lastMessage: null }) });
    await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-transport'));
  }));
});

test('passes an isolated working directory to Codex', async () => {
  await withPaths(async (paths) => {
    const calls = [];
    const runner = createCodexRunner({ model: 'm', ...paths, cwd: '/tmp/linmas-input-only', spawnImpl: fakeSpawn({}, calls) });
    await runner.run(request);
    assert.equal(calls[0].options.cwd, '/tmp/linmas-input-only');
  });
});

test('redacts common credential forms from Codex stderr', async () => {
  await withPaths(async (paths) => {
    const stderr = 'password=hunter2 ghp_012345678901234567890123456789012345 AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ code: 1, stderr }) });
    await assert.rejects(runner.run(request), (error) => {
      assert.doesNotMatch(error.message, /hunter2|ghp_|AKIAIOSFODNN7EXAMPLE/);
      return true;
    });
  });
});

test('bounded Codex diagnostics preserve the final error after repetitive warnings', async () => {
  await withPaths(async (paths) => {
    const stderr = `Authorization: Bearer top-secret\n${'repetitive warning\n'.repeat(80)}fatal: unsupported configuration option`;
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ code: 1, stderr }) });
    await assert.rejects(runner.run(request), (error) => {
      assert.match(error.message, /Authorization=\[redacted\]/);
      assert.match(error.message, /fatal: unsupported configuration option/);
      assert.doesNotMatch(error.message, /top-secret/);
      assert.ok(error.message.length < 700, 'diagnostic must remain bounded');
      return true;
    });
  });
});

test('process cleanup does not wait forever for an inherited stderr pipe', async () => {
  await withPaths(async (paths) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const runner = createCodexRunner({ model: 'm', ...paths, timeoutMs: 1, killGraceMs: 1, spawnImpl: () => child });
    await assert.rejects(Promise.race([
      runner.run(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup hung')), 100))
    ]), (error) => error instanceof ReviewError && error.failureClass === 'provider-timeout');
  });
});

test('cancels an active Codex process through AbortSignal', async () => {
  await withPaths(async (paths) => {
    const calls = [];
    const controller = new AbortController();
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ delay: 100 }, calls) });
    const running = runner.run({ ...request, signal: controller.signal });
    controller.abort();
    await assert.rejects(running, (error) => assertProviderError(error, 'provider-cancelled'));
    assert.equal(calls[0].child.killedWith, 'SIGTERM');
  });
});

test('timeout sends SIGTERM then SIGKILL in order', async () => {
  await withPaths(async (paths) => {
    const signals = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      return child;
    };
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl, timeoutMs: 1, killGraceMs: 5 });
    await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-timeout'));
    assert.equal(signals[0], 'SIGTERM', 'SIGTERM must be sent first');
    assert.equal(signals[1], 'SIGKILL', 'SIGKILL must be sent after SIGTERM');
  });
});

test('abort sends SIGTERM then SIGKILL when child ignores SIGTERM', async () => {
  await withPaths(async (paths) => {
    const signals = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      return child;
    };
    const controller = new AbortController();
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl, killGraceMs: 1 }).run({ ...request, signal: controller.signal });
    controller.abort();
    await assert.rejects(runner, (error) => assertProviderError(error, 'provider-cancelled'));
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });
});

test('handles stdin stream error without crashing', async () => {
  await withPaths(async (paths) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const runner = createCodexRunner({ model: 'm', ...paths, timeoutMs: 100, spawnImpl: () => child });
    const running = runner.run(request);
    child.stdin.destroy(new Error('EPIPE'));
    await assert.rejects(running, (error) => {
      assertProviderError(error, 'provider-transport');
      return true;
    });
  });
});

test('escalates cancellation when the child ignores SIGTERM', async () => {
  await withPaths(async (paths) => {
    const signals = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      return child;
    };
    const controller = new AbortController();
    const running = createCodexRunner({ model: 'm', ...paths, spawnImpl, killGraceMs: 1 }).run({ ...request, signal: controller.signal });
    controller.abort();
    await assert.rejects(running, (error) => assertProviderError(error, 'provider-cancelled'));
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });
});

test('managed runner classifies schema setup failures', async () => {
  const runner = createManagedCodexRunner({ model: 'm', tempRoot: '/path/that/does/not/exist', spawnImpl: fakeSpawn() });
  await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-configuration'));
});

test('managed runner classifies cleanup failures without replacing provider failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linmas-codex-root-'));
  const cleanupError = new Error('cleanup failed');
  const removeImpl = async () => { throw cleanupError; };
  try {
    await t.test('after success', async () => {
      const runner = createManagedCodexRunner({ model: 'm', tempRoot: root, spawnImpl: fakeSpawn(), removeImpl });
      await assert.rejects(runner.run(request), (error) => assertProviderError(error, 'provider-configuration'));
    });
    await t.test('after provider failure', async () => {
      const runner = createManagedCodexRunner({ model: 'm', tempRoot: root, spawnImpl: fakeSpawn({ code: 7 }), removeImpl });
      await assert.rejects(runner.run(request), (error) => {
        assertProviderError(error, 'provider-transport');
        assert.equal(error.cleanupCause, cleanupError);
        return true;
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registry configuration failures preserve ReviewError failureClass and exit code', () => {
  assert.throws(
    () => resolveProvider(createProviderRegistry({ env: {}, binaryLookup: () => false }), 'codex', {}),
    (error) => assertProviderError(error, 'provider-configuration')
  );
});

test('registry uses injected binary lookup and removes its private schema directory', async () => {
  const calls = [];
  const lookupCalls = [];
  let privateDir;
  const binaryLookup = (name) => { lookupCalls.push(name); return true; };
  const spawnImpl = (command, args, options) => {
    privateDir = path.dirname(args[args.indexOf('--output-schema') + 1]);
    return fakeSpawn({}, calls)(command, args, options);
  };
  const registry = createProviderRegistry({ env: { LINMAS_EVAL_MODEL: 'codex-model' }, binaryLookup, spawnImpl });
  const descriptor = registry.get('codex');
  assert.deepEqual(descriptor.detectConfiguration(), { provider: 'codex', status: 'configured', reason: 'codex binary is available; authentication and model are verified at execution', defaultModel: 'codex-model', missingRequirements: [] });
  const runner = resolveProvider(registry, 'codex', {});
  const result = await runner.run(request);
  assert.equal(result.rawResponse, validJson);
  assert.deepEqual(lookupCalls, ['codex', 'codex']);
  await assert.rejects(access(privateDir), { code: 'ENOENT' });
});

test('registry writes a restrictive ReviewResult schema artifact before spawning', async () => {
  let schema;
  const spawnImpl = (command, args, options) => {
    const schemaPath = args[args.indexOf('--output-schema') + 1];
    schema = readFile(schemaPath, 'utf8').then(JSON.parse);
    return fakeSpawn()(command, args, options);
  };
  const registry = createProviderRegistry({ env: { LINMAS_EVAL_MODEL: 'm' }, binaryLookup: () => true, spawnImpl });
  await resolveProvider(registry, 'codex', {}).run(request);
  const value = await schema;
  assert.equal(value.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(value.type, 'object');
  assert.equal(value.properties.schemaVersion.const, 1);
  assert.equal(value.additionalProperties, false);
});

test('Codex output schema contains only model-owned required fields', () => {
  const props = REVIEW_RESULT_SCHEMA.properties;
  assert.equal(REVIEW_RESULT_SCHEMA.additionalProperties, false, 'top-level additionalProperties must be false');
  assert.deepEqual(REVIEW_RESULT_SCHEMA.required, ['schemaVersion', 'scopeAndAssumptions', 'findings', 'deterministicChecks', 'safetyBoundary'], 'required must not include caseId, specialist, or modelMetadata');
  assert.deepEqual(Object.keys(props), REVIEW_RESULT_SCHEMA.required, 'strict provider schema must expose only model-owned fields');
  assert.equal('caseId' in props, false, 'caseId is injected after provider execution');
  assert.equal('specialist' in props, false, 'specialist is injected after provider execution');
  assert.equal('modelMetadata' in props, false, 'provider metadata is injected after provider execution');
  assert.equal(props.schemaVersion.type, 'integer', 'const fields still require an explicit structured-output type');
  assert.equal(props.findings.items.additionalProperties, false, 'finding items must have additionalProperties: false');
  assert.equal(props.deterministicChecks.items.anyOf[1].additionalProperties, false, 'object deterministicCheck must have additionalProperties: false');
  assert.equal(props.safetyBoundary.additionalProperties, false, 'safetyBoundary must have additionalProperties: false');
});

test('bounded output read accepts response exactly at limit', async () => {
  await withPaths(async (paths) => {
    const payload = '{' + 'a'.repeat(MAX_RESPONSE_BYTES - 2) + '}';
    assert.equal(Buffer.byteLength(payload, 'utf8'), MAX_RESPONSE_BYTES);
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ lastMessage: payload }) });
    const result = await runner.run(request);
    assert.equal(result.rawResponse, payload);
  });
});

test('bounded output read rejects response exceeding limit', async () => {
  await withPaths(async (paths) => {
    const payload = '{' + 'a'.repeat(MAX_RESPONSE_BYTES - 1) + '}';
    assert.equal(Buffer.byteLength(payload, 'utf8'), MAX_RESPONSE_BYTES + 1);
    const runner = createCodexRunner({ model: 'm', ...paths, spawnImpl: fakeSpawn({ lastMessage: payload }) });
    await assert.rejects(runner.run(request), (error) => {
      assertProviderError(error, 'provider-response-invalid');
      assert.match(error.message, /Codex response exceeds/);
      return true;
    });
  });
});
