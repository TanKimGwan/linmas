import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHosts } from '../src/core/detect-hosts.mjs';
import { createHostRegistry } from '../src/hosts/registry.mjs';

test('host registry contains Claude and Codex in stable order', () => {
  const registry = createHostRegistry({ homedir: '/home/test', env: {} });

  assert.deepEqual([...registry.keys()], ['claude', 'codex']);
  for (const adapter of registry.values()) {
    assert.equal(typeof adapter.detect, 'function');
    assert.equal(typeof adapter.getInstallRoot, 'function');
    assert.equal(typeof adapter.getManifestPath, 'function');
    assert.equal(typeof adapter.validateTarget, 'function');
  }
});

test('detectHosts accepts an injected registry', () => {
  const registry = new Map([['fake', {
    detect: () => ({ host: 'fake', status: 'not_detected' })
  }]]);

  assert.deepEqual(detectHosts({ registry }), [{ host: 'fake', status: 'not_detected' }]);
});

test('project targets use shared Codex storage and Claude attachments without creating paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-host-targets-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  try {
    const registry = createHostRegistry({ homedir: home, env: {} });
    const claude = registry.get('claude').resolveTarget({ scope: 'project', projectRoot: project });
    const codex = registry.get('codex').resolveTarget({ scope: 'project', projectRoot: project });
    assert.equal(claude.rootPath, path.join(project, '.claude'));
    assert.equal(claude.installRoot, path.join(project, '.claude', 'skills'));
    assert.equal(codex.installRoot, path.join(project, '.agents', 'skills'));
    assert.equal(claude.canonicalRoot, codex.canonicalRoot);
    assert.equal(claude.manifestPath, path.join(project, '.agents', 'linmas-manifest.json'));
    assert.equal(fs.existsSync(path.join(project, '.agents')), false);
    assert.equal(registry.get('claude').validateTarget({ scope: 'project', projectRoot: project }).writable, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('global targets honor Claude config and keep Codex canonical under .agents', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-host-global-'));
  const claudeConfig = path.join(home, 'claude-config');
  try {
    const registry = createHostRegistry({ homedir: home, env: { CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: path.join(home, '.codex-custom') } });
    assert.equal(registry.get('claude').resolveTarget().installRoot, path.join(claudeConfig, 'skills'));
    assert.equal(registry.get('codex').resolveTarget().installRoot, path.join(home, '.agents', 'skills'));
    assert.throws(() => createHostRegistry({ homedir: home, env: { CLAUDE_CONFIG_DIR: 'relative' } }), /CLAUDE_CONFIG_DIR must be an absolute/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
