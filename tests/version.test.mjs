import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LINMAS_VERSION, loadLinmasVersion } from '../src/core/version.mjs';
import { validatePackageVersionConsistency } from '../scripts/validate-package-version.mjs';

const releaseRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createVersionFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-version-fixture-'));
  await writeJson(path.join(root, 'package.json'), { name: 'linmas', version: '0.8.0' });
  await writeJson(path.join(root, 'package-lock.json'), {
    name: 'linmas',
    version: '0.8.0',
    packages: { '': { name: 'linmas', version: '0.8.0' } }
  });
  await writeJson(path.join(root, 'plugins', 'linmas', 'package.json'), { name: 'linmas', version: '0.8.0' });
  await writeJson(path.join(root, 'plugins', 'linmas', '.codex-plugin', 'plugin.json'), { name: 'linmas', version: '0.8.0' });
  return root;
}

async function withVersionFixture(callback) {
  const root = await createVersionFixture();
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function updateJson(filePath, update) {
  const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  update(value);
  await writeJson(filePath, value);
}

function consistencyError(surfacePattern) {
  return (error) => {
    assert.match(error.message, /Package version consistency failed/);
    assert.match(error.message, surfacePattern);
    return true;
  };
}

test('Linmas version loader validates package metadata deterministically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-version-loader-'));
  try {
    const valid = path.join(root, 'valid.json');
    const malformed = path.join(root, 'malformed.json');
    const empty = path.join(root, 'empty.json');
    await fs.writeFile(valid, '{"version":"9.8.7"}\n');
    await fs.writeFile(malformed, '{not-json}\n');
    await fs.writeFile(empty, '{"version":"  "}\n');

    assert.equal(LINMAS_VERSION, '0.8.0');
    assert.equal(loadLinmasVersion(valid), '9.8.7');
    assert.throws(() => loadLinmasVersion(malformed), /unable to read Linmas package version/);
    assert.throws(() => loadLinmasVersion(path.join(root, 'missing.json')), /unable to read Linmas package version/);
    assert.throws(() => loadLinmasVersion(empty), /must be a non-empty string/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('REL-001 validates all five canonical surfaces and rejects every unsafe fixture', async (t) => {
  const candidateFiles = [
    'package.json',
    'package-lock.json',
    'plugins/linmas/package.json',
    'plugins/linmas/.codex-plugin/plugin.json'
  ];
  const candidateBefore = await Promise.all(candidateFiles.map((file) => fs.readFile(path.join(releaseRoot, file))));

  await t.test('aligned five surfaces pass', async () => {
    await withVersionFixture((root) => {
      const result = validatePackageVersionConsistency(root);
      assert.equal(result.version, '0.8.0');
      assert.deepEqual(result.surfaces.map(({ label }) => label), [
        'package.json',
        'package-lock.json top-level',
        'package-lock.json packages[""]',
        'plugins/linmas/package.json',
        'plugins/linmas/.codex-plugin/plugin.json'
      ]);
    });
  });

  const mismatchCases = [
    ['package-lock.json top-level', 'package-lock.json', (value) => { value.version = '0.7.0'; }],
    ['package-lock.json packages[""]', 'package-lock.json', (value) => { value.packages[''].version = '0.7.0'; }],
    ['plugins/linmas/package.json', 'plugins/linmas/package.json', (value) => { value.version = '0.7.0'; }],
    ['plugins/linmas/.codex-plugin/plugin.json', 'plugins/linmas/.codex-plugin/plugin.json', (value) => { value.version = '0.7.0'; }]
  ];
  for (const [name, file, update] of mismatchCases) {
    await t.test(`mismatch in ${name} fails`, async () => {
      await withVersionFixture(async (root) => {
        await updateJson(path.join(root, file), update);
        assert.throws(
          () => validatePackageVersionConsistency(root),
          consistencyError(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        );
      });
    });
  }

  for (const invalid of ['not-semver', 'v0.8.0', '0.8', '0.8.0foo', '']) {
    await t.test(`invalid-but-equal ${JSON.stringify(invalid)} fails`, async () => {
      await withVersionFixture(async (root) => {
        await updateJson(path.join(root, 'package.json'), (value) => { value.version = invalid; });
        await updateJson(path.join(root, 'package-lock.json'), (value) => {
          value.version = invalid;
          value.packages[''].version = invalid;
        });
        await updateJson(path.join(root, 'plugins', 'linmas', 'package.json'), (value) => { value.version = invalid; });
        await updateJson(path.join(root, 'plugins', 'linmas', '.codex-plugin', 'plugin.json'), (value) => { value.version = invalid; });
        assert.throws(
          () => validatePackageVersionConsistency(root),
          /package\.json version must be a strict release SemVer string \(x\.y\.z\)/
        );
      });
    });
  }

  const missingCases = [
    ['package version', async (root) => updateJson(path.join(root, 'package.json'), (value) => { delete value.version; }), /package\.json version/],
    ['lock top-level version', async (root) => updateJson(path.join(root, 'package-lock.json'), (value) => { delete value.version; }), /package-lock\.json top-level version/],
    ['lock root package version', async (root) => updateJson(path.join(root, 'package-lock.json'), (value) => { delete value.packages[''].version; }), /package-lock\.json packages\[""\] version/],
    ['plugin package file', async (root) => fs.rm(path.join(root, 'plugins', 'linmas', 'package.json')), /plugins\/linmas\/package\.json is missing/],
    ['plugin manifest file', async (root) => fs.rm(path.join(root, 'plugins', 'linmas', '.codex-plugin', 'plugin.json')), /plugins\/linmas\/\.codex-plugin\/plugin\.json is missing/],
    ['entire plugin mirror', async (root) => fs.rm(path.join(root, 'plugins', 'linmas'), { recursive: true }), /plugins\/linmas mirror is missing/]
  ];
  for (const [name, prepare, errorPattern] of missingCases) {
    await t.test(`missing ${name} fails`, async () => {
      await withVersionFixture(async (root) => {
        await prepare(root);
        assert.throws(() => validatePackageVersionConsistency(root), consistencyError(errorPattern));
      });
    });
  }

  await t.test('malformed canonical JSON fails with its surface', async () => {
    await withVersionFixture(async (root) => {
      await fs.writeFile(path.join(root, 'package-lock.json'), '{not-json}\n');
      assert.throws(
        () => validatePackageVersionConsistency(root),
        consistencyError(/package-lock\.json is not valid JSON/)
      );
    });
  });

  await t.test('non-string canonical value fails with its surface', async () => {
    await withVersionFixture(async (root) => {
      await updateJson(path.join(root, 'plugins', 'linmas', '.codex-plugin', 'plugin.json'), (value) => { value.version = 8; });
      assert.throws(
        () => validatePackageVersionConsistency(root),
        consistencyError(/plugins\/linmas\/\.codex-plugin\/plugin\.json version must be a strict release SemVer string/)
      );
    });
  });

  const candidateAfter = await Promise.all(candidateFiles.map((file) => fs.readFile(path.join(releaseRoot, file))));
  for (let index = 0; index < candidateFiles.length; index += 1) {
    assert.deepEqual(candidateAfter[index], candidateBefore[index], `fixture matrix mutated ${candidateFiles[index]}`);
  }
});
