import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderRegistry, defaultBinaryLookup, prepareProviderExecution, resolveProvider } from '../src/providers/registry.mjs';
import { EXIT_CODES, ReviewError } from '../src/review/errors.mjs';

test('resolves Claude only when explicitly selected', () => {
  const registry = createProviderRegistry({ env: { ANTHROPIC_API_KEY: 'test', LINMAS_EVAL_MODEL: 'model' }, fetchImpl: async () => {} });
  assert.equal(registry.has('claude'), true);
  assert.throws(() => resolveProvider(registry, null, {}), /provider is required/);
  assert.throws(() => resolveProvider(registry, 'missing', {}), /unsupported provider/);
});

test('requires credentials and model when creating Claude runner', () => {
  assert.throws(() => resolveProvider(createProviderRegistry({ env: {} }), 'claude', {}), /credentials/);
  assert.throws(() => resolveProvider(createProviderRegistry({ env: { ANTHROPIC_API_KEY: 'test' } }), 'claude', {}), /model is required/);
});

test('Claude configuration detection names a missing LINMAS_EVAL_MODEL', () => {
  const registry = createProviderRegistry({ env: { ANTHROPIC_API_KEY: 'test-secret' } });
  const status = registry.get('claude').detectConfiguration();
  assert.equal(status.status, 'missing');
  assert.equal(status.reason, 'LINMAS_EVAL_MODEL is not set');
  assert.doesNotMatch(JSON.stringify(status), /test-secret/);
});

test('resolveProvider rejects invalid descriptors as provider configuration', () => {
  for (const descriptor of [null, 1, {}, { create: 'not-a-function' }]) {
    assert.throws(
      () => resolveProvider(new Map([['broken', descriptor]]), 'broken', {}),
      (error) => error instanceof ReviewError && error.category === 'provider-configuration' && error.exitCode === EXIT_CODES.PROVIDER
    );
  }
});

test('resolveProvider rejects every invalid runner shape before execution', () => {
  for (const runner of [undefined, null, 1, 'runner', {}, { run: true }]) {
    assert.throws(
      () => resolveProvider(new Map([['broken', { id: 'broken', create: () => runner }]]), 'broken', {}),
      (error) => error instanceof ReviewError
        && error.category === 'provider-configuration'
        && error.exitCode === EXIT_CODES.PROVIDER
        && /invalid runner/.test(error.message)
    );
  }
});

test('resolveProvider preserves valid runner metadata and supports sync runners', async () => {
  const runner = resolveProvider(new Map([['sync', {
    id: 'sync',
    create() { return { id: 'sync', model: 'fixture-model', run: () => ({ rawResponse: '{}' }) }; }
  }]]), 'sync', {});
  assert.equal(runner.id, 'sync');
  assert.equal(runner.model, 'fixture-model');
  assert.deepEqual(await runner.run({}), { rawResponse: '{}' });
});

test('resolveProvider translates non-Error provider failures without throwing a TypeError', async () => {
  const runner = resolveProvider(new Map([['broken', {
    id: 'broken',
    create() { return { async run() { throw undefined; } }; }
  }]]), 'broken', {});
  await assert.rejects(
    runner.run({}),
    (error) => error instanceof ReviewError && error.category === 'provider-transport' && error.exitCode === EXIT_CODES.PROVIDER
  );
});

test('defaultBinaryLookup finds POSIX executable and rejects a non-executable file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-binary-'));
  try {
    const executable = path.join(root, 'codex');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    let executableAllowed = true;
    const accessSync = (candidate, mode) => {
      assert.equal(mode, fs.constants.X_OK);
      if (candidate === executable && executableAllowed) return;
      throw Object.assign(new Error('not executable'), { code: 'EACCES' });
    };
    assert.equal(defaultBinaryLookup('codex', { env: { PATH: root }, platform: 'linux', accessSync }), executable);
    executableAllowed = false;
    assert.equal(defaultBinaryLookup('codex', { env: { PATH: root }, platform: 'linux', accessSync }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('defaultBinaryLookup honors Windows PATHEXT including CMD and paths with spaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas binary '));
  try {
    const command = path.join(root, 'codex.CMD');
    fs.writeFileSync(command, '@echo off\r\n');
    assert.equal(defaultBinaryLookup('codex', {
      env: { PATH: root, PATHEXT: '.EXE;.CMD' },
      platform: 'win32'
    }), command);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('defaultBinaryLookup prefers a native Windows executable over unsafe command shims', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas native binary '));
  try {
    const executable = path.join(root, 'codex.EXE');
    const shim = path.join(root, 'codex.CMD');
    fs.writeFileSync(executable, 'native fixture');
    fs.writeFileSync(shim, '@echo off\r\n');
    assert.equal(defaultBinaryLookup('codex', {
      env: { PATH: root, PATHEXT: '.EXE;.CMD' },
      platform: 'win32'
    }), executable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('defaultBinaryLookup uses safe Windows defaults and fails cleanly for empty PATH', () => {
  assert.equal(defaultBinaryLookup('codex', { env: { PATH: '', PATHEXT: '' }, platform: 'win32' }), null);
  const seen = [];
  const found = defaultBinaryLookup('codex', {
    env: { PATH: 'C:\\tools', PATHEXT: '' },
    platform: 'win32',
    accessSync(candidate) {
      seen.push(candidate);
      if (candidate.endsWith('codex.EXE')) return;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  });
  assert.match(found, /codex\.EXE$/);
  assert.ok(seen.some((candidate) => candidate.endsWith('codex.CMD')) || seen.some((candidate) => candidate.endsWith('codex.EXE')));
});

test('Codex detection and creation use the same resolved Windows executable', async () => {
  const calls = [];
  const binary = path.join('/tmp', 'Codex Tools', 'codex.EXE');
  const registry = createProviderRegistry({
    env: { PATH: '/tmp/Codex Tools', PATHEXT: '.EXE;.CMD', LINMAS_EVAL_MODEL: 'model' },
    platform: 'win32',
    binaryLookup() { return binary; },
    spawnImpl(command) {
      calls.push(command);
      throw Object.assign(new Error('stop after command assertion'), { code: 'ENOENT' });
    }
  });
  assert.equal(registry.get('codex').detectConfiguration().status, 'configured');
  const runner = resolveProvider(registry, 'codex', {});
  await assert.rejects(runner.run({ system: 's', user: 'u' }), /failed to start/);
  assert.deepEqual(calls, [binary]);
});

test('Codex reports a Windows CMD shim as unsupported instead of failing at runtime', () => {
  const binary = path.join('/tmp', 'Codex Tools', 'codex.CMD');
  const registry = createProviderRegistry({
    env: { PATH: '/tmp/Codex Tools', PATHEXT: '.CMD', LINMAS_EVAL_MODEL: 'model' },
    platform: 'win32',
    binaryLookup() { return binary; }
  });
  const status = registry.get('codex').detectConfiguration();
  assert.equal(status.status, 'missing');
  assert.match(status.reason, /shims are unsupported/);
  assert.throws(
    () => resolveProvider(registry, 'codex', {}),
    (error) => error instanceof ReviewError && error.category === 'provider-configuration' && /shims are unsupported/.test(error.message)
  );
});

test('Codex binary is configured without requiring LINMAS_EVAL_MODEL', () => {
  const registry = createProviderRegistry({
    env: {},
    binaryLookup() { return '/usr/bin/codex'; }
  });
  assert.deepEqual(registry.get('codex').detectConfiguration(), {
    provider: 'codex',
    status: 'configured',
    reason: 'codex binary is available; authentication and model are verified at execution',
    defaultModel: null,
    missingRequirements: []
  });
});

test('Codex capability discovery uses the same direct executable and returns sanitized capabilities', async () => {
  const binary = path.join('/tmp', 'Codex Tools', 'codex');
  const factoryCalls = [];
  const readCalls = [];
  const registry = createProviderRegistry({
    env: { PATH: '/tmp/Codex Tools' },
    platform: 'linux',
    binaryLookup() { return binary; },
    createCodexCapabilityProbeImpl(options) {
      factoryCalls.push(options);
      return {
        async read(options) {
          readCalls.push(options);
          return {
            authMode: 'chatgpt',
            requiresOpenaiAuth: true,
            models: [{ id: 'model-id', model: 'model-id', isDefault: true }]
          };
        }
      };
    }
  });

  const signal = new AbortController().signal;
  const result = await registry.get('codex').discoverCapabilities({ includeModels: true, signal, timeoutMs: 1234 });

  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].command, binary);
  assert.equal(factoryCalls[0].timeoutMs, 1234);
  assert.deepEqual(readCalls, [{ includeModels: true, signal }]);
  assert.deepEqual(result, {
    authMode: 'chatgpt',
    requiresOpenaiAuth: true,
    models: [{ id: 'model-id', model: 'model-id', isDefault: true }]
  });
});

test('Codex capability discovery fails before spawning for missing or unsupported binaries', async () => {
  let factoryCalled = false;
  const missing = createProviderRegistry({
    env: {},
    binaryLookup() { return null; },
    createCodexCapabilityProbeImpl() { factoryCalled = true; }
  });
  await assert.rejects(
    missing.get('codex').discoverCapabilities(),
    (error) => error instanceof ReviewError && error.category === 'provider-configuration' && /not configured/.test(error.message)
  );

  const unsupported = createProviderRegistry({
    env: { PATH: 'C:\\tools' },
    platform: 'win32',
    binaryLookup() { return 'C:\\tools\\codex.CMD'; },
    createCodexCapabilityProbeImpl() { factoryCalled = true; }
  });
  await assert.rejects(
    unsupported.get('codex').discoverCapabilities(),
    (error) => error instanceof ReviewError && error.category === 'provider-configuration' && /shims are unsupported/.test(error.message)
  );
  assert.equal(factoryCalled, false);
});

test('subscription-first Codex preparation verifies auth and model before runner creation', async () => {
  let created = false;
  const registry = new Map([['codex', {
    id: 'codex',
    async prepareExecution(options) {
      assert.deepEqual(options, { model: null, cwd: '/fixture' });
      return { model: 'gpt-5.6-sol', authMode: 'chatgpt', modelVerified: true };
    },
    create(options) {
      created = true;
      assert.equal(options.model, 'gpt-5.6-sol');
      return { id: 'codex', model: options.model, async run() {} };
    }
  }]]);

  const prepared = await prepareProviderExecution(registry, 'codex', { model: null, cwd: '/fixture' });
  assert.equal(created, false);
  assert.deepEqual(prepared.metadata, {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    authMode: 'chatgpt',
    modelVerified: true
  });
  const runner = prepared.createRunner();
  assert.equal(created, true);
  assert.equal(runner.model, 'gpt-5.6-sol');
});

test('Codex registry prepares both ChatGPT and API-key auth through one verified contract', async () => {
  for (const authMode of ['chatgpt', 'apiKey']) {
    let runnerModel;
    const registry = createProviderRegistry({
      env: {},
      binaryLookup() { return '/usr/bin/codex'; },
      createCodexCapabilityProbeImpl() {
        return {
          async read() {
            return {
              authMode,
              requiresOpenaiAuth: true,
              models: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: true }]
            };
          }
        };
      },
      spawnImpl() { throw new Error('runner must not execute in preparation test'); }
    });

    const prepared = await prepareProviderExecution(registry, 'codex', {});
    assert.equal(prepared.metadata.authMode, authMode);
    assert.equal(prepared.metadata.model, 'gpt-5.6-sol');
    assert.equal(prepared.metadata.modelVerified, true);
    runnerModel = prepared.createRunner().model;
    assert.equal(runnerModel, 'gpt-5.6-sol');
  }
});

test('older Codex can retain explicit-model execution with unverified capability metadata', async () => {
  const unavailable = new ReviewError('Codex capability method is unavailable', 'provider-configuration', EXIT_CODES.PROVIDER);
  unavailable.capabilityUnavailable = true;
  const registry = createProviderRegistry({
    env: {},
    binaryLookup() { return '/usr/bin/codex'; },
    createCodexCapabilityProbeImpl() {
      return { async read() { throw unavailable; } };
    }
  });

  const prepared = await prepareProviderExecution(registry, 'codex', { model: 'explicit-model' });
  assert.deepEqual(prepared.metadata, {
    provider: 'codex',
    model: 'explicit-model',
    authMode: 'unverified',
    modelVerified: false
  });
  assert.equal(prepared.createRunner().model, 'explicit-model');

  await assert.rejects(
    prepareProviderExecution(registry, 'codex', {}),
    (error) => error === unavailable
  );
});
