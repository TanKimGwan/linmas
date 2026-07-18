import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  MAX_CAPABILITY_MODELS,
  createCodexCapabilityProbe
} from '../src/providers/codex-capabilities.mjs';

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

function successfulServer({ account, pages = [] }) {
  return fakeAppServer((message, child) => {
    if (message.method === 'initialize') respond(child, message.id, { userAgent: 'codex', codexHome: '/private', platformFamily: 'unix', platformOs: 'linux' });
    if (message.method === 'account/read') respond(child, message.id, { account, requiresOpenaiAuth: true });
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

test('timeout and abort terminate the app server with stable taxonomy', async () => {
  const timeoutChild = fakeAppServer();
  await assert.rejects(
    createCodexCapabilityProbe({ spawnImpl: () => timeoutChild, timeoutMs: 1, killGraceMs: 1 }).read(),
    (error) => error.category === 'provider-timeout'
  );
  assert.equal(timeoutChild.kills[0], 'SIGTERM');

  const abortChild = fakeAppServer();
  const controller = new AbortController();
  const pending = createCodexCapabilityProbe({ spawnImpl: () => abortChild, timeoutMs: 100 }).read({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.category === 'provider-transport' && /cancelled/i.test(error.message));
  assert.equal(abortChild.kills[0], 'SIGTERM');
});
