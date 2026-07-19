import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('offline proof demo creates and verifies an ephemeral bundle', async () => {
  const node = process.execPath;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(node, ['scripts/demo-proof.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }) : reject(new Error(Buffer.concat(stderr).toString())));
  });
  assert.match(output.stdout, /OFFLINE FIXTURE — NO MODEL CALL/);
  assert.match(output.stdout, /Integrity   valid/);
  assert.equal(output.stderr, '');
});

test('npm package includes the public proof demo and verifier but excludes internal reports', () => {
  const npmCli = process.env.npm_execpath;
  const args = ['pack', '--dry-run', '--json', '--cache', '/tmp/linmas-npm-cache'];
  const packed = JSON.parse(npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { cwd: rootDir, encoding: 'utf8' })
    : execFileSync('npm', args, { cwd: rootDir, encoding: 'utf8' }));
  const files = new Set(packed[0].files.map((item) => item.path));
  assert.equal(files.has('scripts/demo-proof.mjs'), true);
  assert.equal(files.has('src/proof/run-proof.mjs'), true);
  assert.equal(files.has('README.md'), true);
  assert.equal([...files].some((item) => item.startsWith('docs/')), false);
  assert.equal([...files].some((item) => item.endsWith('laporan.md')), false);
});
