import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRegistry } from '../src/hosts/registry.mjs';

test('host registry contains Claude and Codex in stable order', () => {
  const registry = createHostRegistry({ homedir: '/home/test' });

  assert.deepEqual([...registry.keys()], ['claude', 'codex']);
  for (const adapter of registry.values()) {
    assert.equal(typeof adapter.detect, 'function');
    assert.equal(typeof adapter.getInstallRoot, 'function');
    assert.equal(typeof adapter.getManifestPath, 'function');
    assert.equal(typeof adapter.validateTarget, 'function');
  }
});
