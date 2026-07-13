import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry, resolveProvider } from '../src/providers/registry.mjs';

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
