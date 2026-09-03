import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_CAPABILITY_MODELS,
  createCodexCapabilityProbe,
  selectCodexModel
} from '../src/providers/codex-capabilities.mjs';
import { createManagedCodexRunner } from '../src/providers/codex-cli.mjs';

function fakeAppServer(handler = () => {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  let buffer = '';

  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) handler(JSON.parse(line), child);
    }
  });
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function respond(child, id, result) {
  child.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function successfulServer({ account, pages = [], requiresOpenaiAuth = true }) {
  return fakeAppServer((message, child) => {
    if (message.method === 'initialize') respond(child, message.id, { userAgent: 'codex', codexHome: '/private', platformFamily: 'unix', platformOs: 'linux' });
    if (message.method === 'account/read') respond(child, message.id, { account, requiresOpenaiAuth });
    if (message.method === 'model/list') {
      const page = pages.find((item) => (item.cursor ?? null) === (message.params.cursor ?? null)) ?? { data: [], nextCursor: null };
      respond(child, message.id, page);
    }
  });
}

test('classifies ChatGPT auth without retaining account PII', async () => {
  const child = successfulServer({ account: { type: 'chatgpt', email: 'private@example.test', planType: 'plus' } });
  const probe = createCodexCapabilityProbe({ spawnImpl: () => child });
  const result = await probe.read();

  assert.deepEqual(result, { authMode: 'chatgpt', requiresOpenaiAuth: true, models: null });
  assert.doesNotMatch(JSON.stringify(result), /private@example|plus/);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('classifies API-key auth without reading or returning the key', async () => {
  const child = successfulServer({ account: { type: 'apiKey' } });
  const result = await createCodexCapabilityProbe({ spawnImpl: () => child }).read();
  assert.deepEqual(result, { authMode: 'apiKey', requiresOpenaiAuth: true, models: null });
});

test('F-002 capability probe uses the isolated runner launch policy', async () => {
  const calls = [];
  const child = successfulServer({ account: { type: 'chatgpt' } });
  await createCodexCapabilityProbe({
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    }
  }).read();

  assert.deepEqual(calls[0].args, ['app-server', '--stdio', '-c', 'model_provider="openai"']);
  assert.equal(calls[0].options.shell, false);
});

test('F-002 probe and runner share isolated configuration despite malformed or custom user config', async (t) => {
  for (const [name, userConfig] of [
    ['malformed config', 'model_provider = [broken\n'],
    ['custom provider', 'model_provider = "custom"\n[model_providers.custom]\nname = "fixture"\n']
  ]) {
    await t.test(name, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-codex-isolation-'));
      try {
        const userHome = path.join(tmp, 'user-codex-home');
        fs.mkdirSync(userHome);
        fs.writeFileSync(path.join(userHome, 'config.toml'), userConfig);
        fs.writeFileSync(path.join(userHome, 'auth.json'), '{}', { mode: 0o600 });
        const env = { PATH: process.env.PATH, CODEX_HOME: userHome };
        const inspectLaunchPolicy = (args, options = {}) => {
          const ignoresUserConfig = args.includes('--ignore-user-config');
          const launchHome = options.env?.CODEX_HOME ?? env.CODEX_HOME;
          const config = ignoresUserConfig ? '' : fs.readFileSync(path.join(launchHome, 'config.toml'), 'utf8');
          if (/model_provider\s*=\s*\[/.test(config)) throw new Error('synthetic malformed Codex config');
          const configuredProvider = config.match(/model_provider\s*=\s*"([^"]+)"/)?.[1];
          let effectiveProvider = configuredProvider;
          for (let index = 0; index < args.length - 1; index += 1) {
            if (args[index] === '-c') effectiveProvider = args[index + 1].match(/^model_provider="([^"]+)"$/)?.[1] ?? effectiveProvider;
          }
          return {
            launchHome,
            config,
            ignoresUserConfig,
            loadedUserConfig: !ignoresUserConfig && launchHome === userHome,
            effectiveProvider
          };
        };

        const legacyProbeArgs = ['app-server', '--stdio', '-c', 'model_provider="openai"'];
        const legacyRunnerArgs = ['exec', '-c', 'model_provider="openai"', '--ignore-user-config'];
        if (name === 'malformed config') {
          assert.throws(() => inspectLaunchPolicy(legacyProbeArgs), /malformed Codex config/);
        } else {
          assert.equal(inspectLaunchPolicy(legacyProbeArgs).loadedUserConfig, true);
        }
        assert.equal(inspectLaunchPolicy(legacyRunnerArgs).loadedUserConfig, false);

        const observed = [];
        const spawnImpl = (command, args, options) => {
          const policy = inspectLaunchPolicy(args, options);
          observed.push({
            args,
            ...policy,
            authPresent: fs.existsSync(path.join(policy.launchHome, 'auth.json'))
          });
          if (args[0] === 'app-server') {
            return successfulServer({ account: { type: 'chatgpt' } });
          }
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = (signal) => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
          queueMicrotask(() => {
            fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"schemaVersion":1}');
            child.emit('close', 0, null);
          });
          return child;
        };

        const capabilities = await createCodexCapabilityProbe({ spawnImpl, env, tempRoot: tmp }).read();
        const result = await createManagedCodexRunner({ model: 'fixture-model', spawnImpl, env, tempRoot: tmp })
          .run({ system: 's', user: 'u' });

        assert.equal(capabilities.authMode, 'chatgpt');
        assert.equal(result.rawResponse, '{"schemaVersion":1}');
        assert.equal(observed.length, 2);
        for (const launch of observed) {
          assert.notEqual(launch.launchHome, userHome);
          assert.equal(launch.config, 'model_provider = "openai"\n');
          assert.equal(launch.authPresent, true);
          assert.equal(launch.loadedUserConfig, false);
          assert.equal(launch.ignoresUserConfig, false);
          assert.equal(launch.effectiveProvider, 'openai');
          assert.equal(fs.existsSync(launch.launchHome), false);
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

test('F-002 account null is valid when the selected provider needs no OpenAI auth', async () => {
  const child = successfulServer({ account: null, requiresOpenaiAuth: false });
  const result = await createCodexCapabilityProbe({ spawnImpl: () => child }).read();
  assert.deepEqual(result, { authMode: 'not-required', requiresOpenaiAuth: false, models: null });
});

test('F-005 capability diagnostics redact quoted JSON credentials', async () => {
  const child = fakeAppServer((message, server) => {
    if (message.method === 'initialize') respond(server, message.id, {});
    if (message.method === 'account/read') {
      server.stdout.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32000, message: '\"Authorization\":\"Bearer CAPABILITY_SENTINEL\" \'api_key\': \'CAPABILITY_API_SENTINEL\'' }
      })}\n`);
    }
  });

  await assert.rejects(
    createCodexCapabilityProbe({ spawnImpl: () => child }).read(),
    (error) => !/CAPABILITY_SENTINEL|CAPABILITY_API_SENTINEL/.test(error.message)
  );
});

test('fails closed when no Codex account is available', async () => {
  const child = successfulServer({ account: null });
  await assert.rejects(
    createCodexCapabilityProbe({ spawnImpl: () => child }).read(),
    (error) => error.category === 'provider-authentication' && /not authenticated/i.test(error.message)
  );
});

test('discovers bounded paginated models and returns only non-sensitive fields', async () => {
  const child = successfulServer({
    account: { type: 'chatgpt', email: 'private@example.test', planType: 'plus' },
    pages: [
      { cursor: null, data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'Sol', description: 'x', hidden: false, isDefault: true }], nextCursor: 'next' },
      { cursor: 'next', data: [{ id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'Terra', description: 'x', hidden: false, isDefault: false }], nextCursor: null }
    ]
  });
  const result = await createCodexCapabilityProbe({ spawnImpl: () => child }).read({ includeModels: true });

  assert.deepEqual(result.models, [
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: true },
    { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', isDefault: false }
  ]);
});

test('rejects malformed protocol output and bounds model inventory', async () => {
  const malformed = fakeAppServer((message, child) => {
    if (message.method === 'initialize') child.stdout.write('{bad json}\n');
  });
  await assert.rejects(
    createCodexCapabilityProbe({ spawnImpl: () => malformed }).read(),
    (error) => error.category === 'provider-configuration' && /invalid JSON/i.test(error.message)
  );

  const tooMany = successfulServer({
    account: { type: 'chatgpt', email: null, planType: 'plus' },
    pages: [{ cursor: null, data: Array.from({ length: MAX_CAPABILITY_MODELS + 1 }, (_, index) => ({ id: `m-${index}`, model: `m-${index}`, hidden: false, isDefault: false })), nextCursor: null }]
  });
  await assert.rejects(
    createCodexCapabilityProbe({ spawnImpl: () => tooMany }).read({ includeModels: true }),
    /model inventory exceeds/i
  );
});

test('classifies JSON-RPC method absence as feature unavailability', async () => {
  const child = fakeAppServer((message, server) => {
    if (message.method === 'initialize') respond(server, message.id, {});
    if (message.method === 'account/read') {
      server.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`);
    }
  });
  await assert.rejects(
    createCodexCapabilityProbe({ spawnImpl: () => child }).read(),
    (error) => error.category === 'provider-configuration' && error.capabilityUnavailable === true
  );
});

test('timeout and abort terminate the app server with stable taxonomy', async () => {
  const timeoutChild = fakeAppServer();
  await assert.rejects(
    createCodexCapabilityProbe({ spawnImpl: () => timeoutChild, timeoutMs: 1, killGraceMs: 1 }).read(),
    (error) => error.category === 'provider-timeout'
  );
  assert.equal(timeoutChild.kills[0], 'SIGTERM');

  const abortChild = fakeAppServer();
  const controller = new AbortController();
  let markSpawned;
  const spawned = new Promise((resolve) => { markSpawned = resolve; });
  const pending = createCodexCapabilityProbe({
    spawnImpl() { markSpawned(); return abortChild; },
    timeoutMs: 100
  }).read({ signal: controller.signal });
  await spawned;
  controller.abort();
  await assert.rejects(pending, (error) => error.category === 'provider-transport' && /cancelled/i.test(error.message));
  assert.equal(abortChild.kills[0], 'SIGTERM');
});

test('selects an explicit account-visible model and rejects unavailable explicit models', () => {
  const models = [
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: true },
    { id: 'gpt-5.5', model: 'gpt-5.5', isDefault: false }
  ];
  assert.equal(selectCodexModel(models, 'gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.throws(
    () => selectCodexModel(models, 'gpt-5.6-missing'),
    (error) => error.category === 'provider-configuration' && /not available/i.test(error.message)
  );
});

test('automatic selection follows one account-visible default without pinning a model generation', () => {
  assert.equal(selectCodexModel([
    { id: 'future-default', model: 'future-default', isDefault: true },
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: false }
  ]), 'future-default');

  assert.equal(selectCodexModel([
    { id: 'only-visible-model', model: 'only-visible-model', isDefault: false }
  ]), 'only-visible-model');

  assert.throws(
    () => selectCodexModel([
      { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: false },
      { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', isDefault: false }
    ]),
    (error) => error.category === 'provider-configuration'
      && /choose an explicit model/i.test(error.message)
      && /gpt-5\.6-sol, gpt-5\.6-terra/.test(error.message)
  );
  assert.throws(
    () => selectCodexModel([
      { id: 'default-one', model: 'default-one', isDefault: true },
      { id: 'default-two', model: 'default-two', isDefault: true }
    ]),
    (error) => error.category === 'provider-configuration' && /multiple default models/i.test(error.message)
  );
  assert.throws(
    () => selectCodexModel([]),
    (error) => error.category === 'provider-configuration' && /no account-visible models/i.test(error.message)
  );
});
