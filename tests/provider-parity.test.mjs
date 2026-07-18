import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry } from '../src/providers/registry.mjs';

const testEnv = {
  ANTHROPIC_API_KEY: 'test-secret',
  LINMAS_EVAL_MODEL: 'claude-opus-4-8'
};

test('every provider reports configuration without secret values', () => {
  const registry = createProviderRegistry({ env: testEnv, fetchImpl: async () => {} });
  for (const [id, descriptor] of registry) {
    assert.equal(descriptor.id, id);
    const status = descriptor.detectConfiguration({ env: testEnv });
    assert.equal(status.provider, id);
    assert.match(status.status, /^(configured|missing)$/);
    assert.doesNotMatch(JSON.stringify(status), /test-secret/);
  }
});
