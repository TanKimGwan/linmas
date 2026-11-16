import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { loadCapsuleEvidence } from '../src/proof/load-evidence.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { verifyProofBundle } from '../src/proof/verify-bundle.mjs';
import { createLinmasDispatcher } from '../mcp/server.mjs';
import { toPublicReviewError } from '../src/review/public-error.mjs';
import { run } from '../bin/linmas.mjs';

// Regression tests for audit T9 findings T9-01, T9-02, T9-04 and T9-05. Keys are
// disposable ed25519 keys generated in a temporary directory.

const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;
const skip = !hasSshKeygen || process.platform === 'win32';
const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };
const finding = { id: 'F-1', status: 'Confirmed finding', severity: 'High', evidence: 'unsafe query', affectedSurface: 'db', preconditions: 'input reaches query', remediation: 'parameterize', verification: 'run test' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function capsule() {
  return buildReviewCapsule({
    input: { source: 'fixture.diff', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: {
      schemaVersion: 1, caseId: 'proof/t9', specialist: 'secure-code-reviewer',
      modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic evidence.'], findings: [finding], deterministicChecks: [], safetyBoundary
    },
    policyResult: null,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-t9-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alice = path.join(root, 'alice');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'alice', '-f', alice]);
  const allowed = path.join(root, 'allowed-signers');
  await fs.writeFile(allowed, `alice@example ${(await fs.readFile(`${alice}.pub`, 'utf8')).trim()}\n`);
  const capsulePath = path.join(root, 'capsule.json');
  await fs.writeFile(capsulePath, `${JSON.stringify(capsule(), null, 2)}\n`);
  const source = await loadCapsuleEvidence(capsulePath);
  const receipt = (principal, label = 'Alice', disposition = 'remediation-required') => buildDecisionReceipt({
    subject: { kind: source.kind, sha256: source.sourceSha256 },
    reviewer: { label, principal },
    findings: [{ id: 'F-1', disposition, rationale: 'Reproduced.' }],
    statement: 'Reviewed by a human.',
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  const signed = (await writeProofBundle(path.join(root, 'signed'), source, receipt('alice@example'), { signingKey: alice })).path;
  const unsigned = (await writeProofBundle(path.join(root, 'unsigned'), source, receipt(null))).path;
  return { root, alice, allowed, source, receipt, signed, unsigned };
}

async function copyBundle(from, to) {
  await fs.cp(from, to, { recursive: true });
  return to;
}

async function readManifest(bundle) {
  return JSON.parse(await fs.readFile(path.join(bundle, 'manifest.json'), 'utf8'));
}

async function writeManifest(bundle, manifest) {
  await fs.writeFile(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function replaceReceipt(bundle, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await fs.writeFile(path.join(bundle, 'decision-receipt.json'), bytes);
  const manifest = await readManifest(bundle);
  manifest.receipt.sha256 = sha256(bytes);
  for (const artifact of manifest.artifacts) if (artifact.path === 'decision-receipt.json') Object.assign(artifact, { sha256: sha256(bytes), bytes: bytes.byteLength });
  return manifest;
}

function resign(bundle, key) {
  const manifestPath = path.join(bundle, 'manifest.json');
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-n', 'linmas-proof-v1', '-f', key, manifestPath]);
  return fs.rename(`${manifestPath}.sig`, path.join(bundle, 'signature', 'manifest.sig'));
}

async function rejection(promise) {
  return promise.then(() => assert.fail('verification must fail'), (error) => error);
}

test('T9-01 allowed signers require a signature: a stripped, forged bundle is rejected', { skip }, async (t) => {
  const f = await fixture(t);
  const stripped = await copyBundle(f.signed, path.join(f.root, 'stripped'));
  const manifest = await replaceReceipt(stripped, f.receipt('alice@example', 'Alice', 'accepted-risk'));
  manifest.signature = null;
  await writeManifest(stripped, manifest);
  await fs.rm(path.join(stripped, 'signature'), { recursive: true, force: true });
  manifest.artifacts = manifest.artifacts.filter((artifact) => !artifact.path.startsWith('signature/'));
  await writeManifest(stripped, manifest);

  const error = await rejection(verifyProofBundle(stripped, { allowedSignersPath: f.allowed }));
  assert.equal(error.category, 'signature');
  assert.equal(error.exitCode, 4);
  // Without allowed signers the honest label is kept.
  const unchecked = await verifyProofBundle(stripped);
  assert.deepEqual({ signature: unchecked.signature, identity: unchecked.identity }, { signature: 'unsigned', identity: 'self-asserted' });
  // A bundle that was never signed is also rejected when allowed signers are given.
  assert.equal((await rejection(verifyProofBundle(f.unsigned, { allowedSignersPath: f.allowed }))).category, 'signature');
});

test('T9-01 every malformed or missing signature variant fails when allowed signers are given', { skip }, async (t) => {
  const f = await fixture(t);
  const variants = {
    'signature field missing': async (bundle) => { const m = await readManifest(bundle); delete m.signature; await writeManifest(bundle, m); },
    'signature empty object': async (bundle) => { const m = await readManifest(bundle); m.signature = {}; await writeManifest(bundle, m); },
    'signature wrong type': async (bundle) => { const m = await readManifest(bundle); m.signature = 'ssh-sig'; await writeManifest(bundle, m); },
    'signature false': async (bundle) => { const m = await readManifest(bundle); m.signature = false; await writeManifest(bundle, m); },
    'signer.pub missing': async (bundle) => { await fs.rm(path.join(bundle, 'signature', 'signer.pub')); },
    'manifest.sig missing': async (bundle) => { await fs.rm(path.join(bundle, 'signature', 'manifest.sig')); }
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const bundle = await copyBundle(f.signed, path.join(f.root, name.replaceAll(/\W+/g, '-')));
    await mutate(bundle);
    const error = await rejection(verifyProofBundle(bundle, { allowedSignersPath: f.allowed }));
    assert.ok(['signature', 'contract'].includes(error.category), `${name}: ${error.category}`);
    assert.equal(error.exitCode, 4, name);
  }
});

test('T9-01 CLI and MCP reject an unsigned bundle when allowed signers are supplied', { skip }, async (t) => {
  const f = await fixture(t);
  let stderr = '';
  const io = { stdout: { write() {} }, stderr: { write(value) { stderr += value; } } };
  assert.equal(await run(['node', 'linmas', 'proof', 'verify', f.unsigned, '--allowed-signers', f.allowed], io), 4);
  assert.match(stderr, /not signed/i);
  assert.equal(await run(['node', 'linmas', 'proof', 'verify', f.unsigned], { ...io, stdout: { write() {} } }), 0);

  const dispatch = createLinmasDispatcher();
  const error = await dispatch('linmas_proof_verify', { workspace_root: f.root, bundle_path: 'unsigned', allowed_signers_path: 'allowed-signers' }).then(() => null, (failure) => failure);
  assert.ok(error, 'MCP verification must fail');
  assert.equal(toPublicReviewError(error).code, 'SIGNATURE_VERIFICATION_FAILED');
  const unchecked = await dispatch('linmas_proof_verify', { workspace_root: f.root, bundle_path: 'unsigned' });
  assert.equal(unchecked.verification.signature, 'unsigned');
});

test('T9-02 the signing principal must match the receipt reviewer principal', { skip }, async (t) => {
  const f = await fixture(t);
  const bundle = await copyBundle(f.signed, path.join(f.root, 'mismatch'));
  const manifest = await replaceReceipt(bundle, f.receipt('bob@example', 'Bob', 'accepted-risk'));
  await writeManifest(bundle, manifest);
  await fs.rm(path.join(bundle, 'signature', 'manifest.sig'));
  await resign(bundle, f.alice);
  for (const options of [{ allowedSignersPath: f.allowed }, {}]) {
    const error = await rejection(verifyProofBundle(bundle, options));
    assert.equal(error.category, 'signature');
    assert.match(error.message, /principal/);
  }
});

test('T9-02 verification reports the verified signing principal', { skip }, async (t) => {
  const f = await fixture(t);
  const trusted = await verifyProofBundle(f.signed, { allowedSignersPath: f.allowed });
  assert.equal(trusted.principal, 'alice@example');
  assert.equal((await verifyProofBundle(f.unsigned)).principal, null);
  let stdout = '';
  const io = { stdout: { write(value) { stdout += value; } }, stderr: { write() {} } };
  assert.equal(await run(['node', 'linmas', 'proof', 'verify', f.signed, '--allowed-signers', f.allowed], io), 0);
  assert.match(stdout, /Principal\s+alice@example/);
  const mcp = await createLinmasDispatcher()('linmas_proof_verify', { workspace_root: f.root, bundle_path: 'signed', allowed_signers_path: 'allowed-signers' });
  assert.equal(mcp.verification.principal, 'alice@example');
});

test('T9-04 signer.pub must be a listed, regular, non-symlink file', { skip }, async (t) => {
  const f = await fixture(t);
  const outsideKey = path.join(f.root, 'outside.pub');
  await fs.copyFile(path.join(f.signed, 'signature', 'signer.pub'), outsideKey);

  const symlinked = await copyBundle(f.signed, path.join(f.root, 'symlinked'));
  await fs.rm(path.join(symlinked, 'signature', 'signer.pub'));
  await fs.symlink(outsideKey, path.join(symlinked, 'signature', 'signer.pub'));
  assert.equal((await rejection(verifyProofBundle(symlinked))).exitCode, 4);

  const unlisted = await copyBundle(f.signed, path.join(f.root, 'unlisted'));
  const manifest = await readManifest(unlisted);
  manifest.artifacts = manifest.artifacts.filter((artifact) => artifact.path !== 'signature/signer.pub');
  await writeManifest(unlisted, manifest);
  await fs.rm(path.join(unlisted, 'signature', 'manifest.sig'));
  await resign(unlisted, f.alice);
  const error = await rejection(verifyProofBundle(unlisted));
  assert.match(error.message, /public key/);
});

test('T9-04 FIFO signature files are rejected without blocking', { skip: skip || process.platform !== 'linux' }, async (t) => {
  const f = await fixture(t);
  for (const name of ['signer.pub', 'manifest.sig']) {
    const bundle = await copyBundle(f.signed, path.join(f.root, `fifo-${name}`));
    if (name === 'signer.pub') {
      // The audit case: the public key is not listed, so only its path is known.
      const manifest = await readManifest(bundle);
      manifest.artifacts = manifest.artifacts.filter((artifact) => artifact.path !== 'signature/signer.pub');
      await writeManifest(bundle, manifest);
      await fs.rm(path.join(bundle, 'signature', 'manifest.sig'));
      await resign(bundle, f.alice);
    }
    await fs.rm(path.join(bundle, 'signature', name));
    execFileSync('mkfifo', [path.join(bundle, 'signature', name)]);
    const started = Date.now();
    const error = await rejection(verifyProofBundle(bundle, { allowedSignersPath: f.allowed }));
    assert.equal(error.exitCode, 4, name);
    assert.ok(Date.now() - started < 10000, `${name} verification must not block`);
  }
});

test('T9-04 an oversized manifest signature is rejected before it is read', { skip }, async (t) => {
  const f = await fixture(t);
  const bundle = await copyBundle(f.signed, path.join(f.root, 'oversized'));
  await fs.writeFile(path.join(bundle, 'signature', 'manifest.sig'), Buffer.alloc(1024 * 1024, 0x41));
  const error = await rejection(verifyProofBundle(bundle));
  assert.match(error.message, /signature exceeds|size/);
});

test('T9-05 files not listed in the manifest are rejected; current bundles still verify', { skip }, async (t) => {
  const f = await fixture(t);
  assert.equal((await verifyProofBundle(f.signed, { allowedSignersPath: f.allowed })).identity, 'trusted');
  assert.equal((await verifyProofBundle(f.unsigned)).integrity, 'valid');
  for (const [name, add] of Object.entries({
    'extra html': (bundle) => fs.writeFile(path.join(bundle, 'evil.html'), '<script>alert(1)</script>'),
    'report backup': (bundle) => fs.writeFile(path.join(bundle, 'report.md.bak'), 'APPROVED'),
    'nested extra': (bundle) => fs.writeFile(path.join(bundle, 'evidence', 'note.txt'), 'APPROVED'),
    'empty directory': (bundle) => fs.mkdir(path.join(bundle, 'extra')),
    'signature dir in unsigned bundle': (bundle) => fs.mkdir(path.join(bundle, 'signature'))
  })) {
    const bundle = await copyBundle(name.includes('unsigned') ? f.unsigned : f.signed, path.join(f.root, name.replaceAll(/\W+/g, '-')));
    await add(bundle);
    const error = await rejection(verifyProofBundle(bundle));
    assert.equal(error.exitCode, 4, name);
    assert.match(error.message, /not listed in the manifest/, name);
  }
});

test('T11 F-2 CLI proof output neutralizes control characters from untrusted values', { skip }, async (t) => {
  const f = await fixture(t);
  const escPrincipal = 'alice\u001b[31mX';
  const bundle = (await writeProofBundle(path.join(f.root, 'esc'), f.source, f.receipt(escPrincipal), { signingKey: f.alice })).path;
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } };
  assert.equal(await run(['node', 'linmas', 'proof', 'verify', bundle], io), 0, stderr);
  assert.equal(stdout.includes('\u001b'), false, 'raw ESC must not reach the terminal');
  assert.match(stdout, /Principal\s+alice\\u001b\[31mX/);

  // Untrusted manifest paths in error messages are neutralized too.
  const tampered = await copyBundle(f.unsigned, path.join(f.root, 'esc-path'));
  const manifest = await readManifest(tampered);
  manifest.artifacts.push({ ...manifest.artifacts[0], path: 'evidence/\u001b]0;pwned\u0007.json' });
  await writeManifest(tampered, manifest);
  stderr = '';
  assert.equal(await run(['node', 'linmas', 'proof', 'verify', tampered], io), 4);
  assert.match(stderr, /Error: /);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(stderr), false, JSON.stringify(stderr));
});
