import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry, resolveProvider } from '../src/providers/registry.mjs';
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
