import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LINMAS_VERSION, loadLinmasVersion } from '../src/core/version.mjs';

test('Linmas version loader validates package metadata deterministically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-version-'));
  try {
    const valid = path.join(root, 'valid.json');
    const malformed = path.join(root, 'malformed.json');
    const empty = path.join(root, 'empty.json');
    await fs.writeFile(valid, '{"version":"9.8.7"}\n');
    await fs.writeFile(malformed, '{not-json}\n');
    await fs.writeFile(empty, '{"version":"  "}\n');

    assert.equal(LINMAS_VERSION, '0.5.2');
    assert.equal(loadLinmasVersion(valid), '9.8.7');
    assert.throws(() => loadLinmasVersion(malformed), /unable to read Linmas package version/);
    assert.throws(() => loadLinmasVersion(path.join(root, 'missing.json')), /unable to read Linmas package version/);
    assert.throws(() => loadLinmasVersion(empty), /must be a non-empty string/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
