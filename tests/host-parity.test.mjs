import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertHostAdapter } from '../src/hosts/adapter-contract.mjs';
import { createHostRegistry } from '../src/hosts/registry.mjs';

const DETECTION_FIELDS = ['host', 'status', 'reason', 'rootPath', 'installRoot', 'manifestPath', 'writable'];
const SECRET_LIKE_KEY = /token|secret|credential|apiKey/i;

function completeAdapter(detection) {
  return {
    detect: () => detection,
    getInstallRoot() {},
    getManifestPath() {},
    validateTarget() {}
  };
}

test('current host adapters satisfy the same contract', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-host-contract-'));
  try {
    const registry = createHostRegistry({ homedir: tempHome });
    for (const [id, adapter] of registry) {
      assert.equal(assertHostAdapter(id, adapter), adapter);
    }
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('rejects incomplete adapters before use', () => {
  assert.throws(() => assertHostAdapter('bad', { detect() {} }), /bad.*getInstallRoot/);
});

test('rejects each missing detection field with a field-specific error', () => {
  const detection = {
    host: 'bad',
    status: 'not_detected',
    reason: 'absent',
    rootPath: '/tmp/.bad',
    installRoot: '/tmp/.bad/skills',
    manifestPath: '/tmp/.bad/linmas-manifest.json',
    writable: false
  };

  for (const field of DETECTION_FIELDS) {
    const incomplete = { ...detection };
    delete incomplete[field];
    assert.throws(
      () => assertHostAdapter('bad', completeAdapter(incomplete)),
      new RegExp(`bad.*${field}`)
    );
  }
});

test('rejects invalid detection identity and status with field-specific errors', () => {
  const detection = {
    host: 'bad',
    status: 'not_detected',
    reason: 'absent',
    rootPath: '/tmp/.bad',
    installRoot: '/tmp/.bad/skills',
    manifestPath: '/tmp/.bad/linmas-manifest.json',
    writable: false
  };

  assert.throws(
    () => assertHostAdapter('bad', completeAdapter({ ...detection, host: 'other' })),
    /bad.*host/
  );
  assert.throws(
    () => assertHostAdapter('bad', completeAdapter({ ...detection, status: 'unknown' })),
    /bad.*status/
  );
});

test('registered hosts preserve detection parity across filesystem states', async (t) => {
  const hostIds = [...createHostRegistry({ homedir: '/home/test' }).keys()];
  const cases = [
    {
      name: 'absent',
      setup() {},
      expected({ id, rootPath, installRoot, manifestPath }) {
        return { host: id, status: 'not_detected', reason: 'no host directory or binary found', rootPath, installRoot, manifestPath, writable: false };
      }
    },
    {
      name: 'root present and skills missing',
      setup({ rootPath }) { fs.mkdirSync(rootPath, { recursive: true }); },
      expected({ id, rootPath, installRoot, manifestPath }) {
        return { host: id, status: 'probably_detected', reason: `${rootPath} exists but skills root is missing`, rootPath, installRoot, manifestPath, writable: true };
      }
    },
    {
      name: 'skills present',
      setup({ installRoot }) { fs.mkdirSync(installRoot, { recursive: true }); },
      expected({ id, rootPath, installRoot, manifestPath }) {
        return { host: id, status: 'detected', reason: `${installRoot} exists`, rootPath, installRoot, manifestPath, writable: true };
      }
    },
    {
      name: 'writable',
      binary: true,
      setup({ rootPath }) { fs.mkdirSync(rootPath, { recursive: true }); },
      expected({ id, rootPath, installRoot, manifestPath }) {
        return { host: id, status: 'detected', reason: `skills root is missing but ${rootPath} exists and target root can be created safely`, rootPath, installRoot, manifestPath, writable: true };
      }
    },
    {
      name: 'not writable',
      binary: true,
      setup({ rootPath }) {
        fs.mkdirSync(rootPath, { recursive: true });
        fs.chmodSync(rootPath, 0o500);
      },
      expected({ id, rootPath, installRoot, manifestPath }) {
        return { host: id, status: 'probably_detected', reason: `${rootPath} exists but is not writable`, rootPath, installRoot, manifestPath, writable: false };
      }
    }
  ];

  for (const id of hostIds) {
    for (const parityCase of cases) {
      await t.test(`${id}: ${parityCase.name}`, () => {
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), `linmas-${id}-parity-`));
        const rootPath = path.join(tempHome, `.${id}`);
        const installRoot = path.join(rootPath, 'skills');
        const manifestPath = path.join(rootPath, 'linmas-manifest.json');
        const binPath = path.join(tempHome, 'bin');
        const context = { id, rootPath, installRoot, manifestPath };

        try {
          parityCase.setup(context);
          if (parityCase.binary) {
            fs.mkdirSync(binPath, { recursive: true });
            fs.writeFileSync(path.join(binPath, id), 'test binary');
          }

          const adapter = createHostRegistry({ homedir: tempHome }).get(id);
          const detection = adapter.detect({ env: { PATH: parityCase.binary ? binPath : '' }, platform: 'linux' });

          assert.deepEqual(detection, parityCase.expected(context));
          assert.equal(path.dirname(detection.manifestPath), detection.rootPath);
          assert.equal(path.relative(detection.installRoot, detection.manifestPath).startsWith('..'), true);
          assert.deepEqual(Object.keys(detection).filter((key) => SECRET_LIKE_KEY.test(key)), []);
        } finally {
          if (fs.existsSync(rootPath)) fs.chmodSync(rootPath, 0o700);
          fs.rmSync(tempHome, { recursive: true, force: true });
        }
      });
    }
  }
});
