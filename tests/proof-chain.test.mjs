import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { deriveOverallDisposition } from '../src/proof/derive-disposition.mjs';
import { buildDecisionReceipt, validateDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { loadCapsuleEvidence } from '../src/proof/load-evidence.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { verifyProofBundle } from '../src/proof/verify-bundle.mjs';
import { renderProofReports } from '../src/proof/render-report.mjs';
import { run } from '../bin/linmas.mjs';

const execFileAsync = promisify(execFile);

const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };

function capsule(findings = []) {
  return buildReviewCapsule({
    input: { source: 'fixture.diff', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: {
      schemaVersion: 1,
      caseId: 'proof/test',
      specialist: 'secure-code-reviewer',
      modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic evidence.'],
      findings,
      deterministicChecks: [],
      safetyBoundary
    },
    policyResult: null,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
}

const finding = { id: 'F-1', status: 'Confirmed finding', severity: 'High', evidence: 'unsafe query', affectedSurface: 'db', preconditions: 'input reaches query', remediation: 'parameterize', verification: 'run test' };

test('derives action-oriented overall disposition deterministically', () => {
  assert.equal(deriveOverallDisposition([]), 'no-findings-reported');
  assert.equal(deriveOverallDisposition([{ disposition: 'false-positive' }]), 'no-action');
  assert.equal(deriveOverallDisposition([{ disposition: 'accepted-risk' }, { disposition: 'needs-more-evidence' }]), 'needs-more-evidence');
  assert.equal(deriveOverallDisposition([{ disposition: 'remediation-required' }, { disposition: 'accepted-risk' }]), 'remediation-required');
});

test('builds and validates a human decision receipt without approval vocabulary', () => {
  const receipt = buildDecisionReceipt({
    subject: { kind: 'linmas-review-capsule', sha256: 'a'.repeat(64) },
    reviewer: { label: 'Tan', principal: null },
    findings: [{ id: 'F-1', disposition: 'remediation-required', rationale: 'The finding is reproducible.' }],
    statement: 'Remediation is required before release.',
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  assert.equal(validateDecisionReceipt(receipt).summary.overallDisposition, 'remediation-required');
  const bad = structuredClone(receipt);
  bad.summary.statement = 'Approved without human review.';
  assert.throws(() => validateDecisionReceipt(bad), /approval|human review|statement/i);
});

test('writes and verifies a capsule proof bundle, then detects tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-'));
  try {
    const capsulePath = path.join(root, 'capsule.json');
    const bundlePath = path.join(root, 'bundle');
    await fs.writeFile(capsulePath, `${JSON.stringify(capsule([finding]), null, 2)}\n`);
    const source = await loadCapsuleEvidence(capsulePath);
    const receipt = buildDecisionReceipt({
      subject: { kind: source.kind, sha256: source.sourceSha256 },
      reviewer: { label: 'Tan', principal: null },
      findings: [{ id: 'F-1', disposition: 'remediation-required', rationale: 'Reproduced in the fixture.' }],
      statement: 'Remediation is required before release.',
      now: new Date('2026-07-19T00:00:00.000Z')
    });
    await writeProofBundle(bundlePath, source, receipt);
    assert.equal((await verifyProofBundle(bundlePath)).integrity, 'valid');
    await fs.appendFile(path.join(bundlePath, 'report.md'), '\nchanged\n');
    await assert.rejects(verifyProofBundle(bundlePath), /hash|integrity|manifest/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reports escape untrusted finding text in HTML', () => {
  const receipt = buildDecisionReceipt({
    subject: { kind: 'linmas-review-capsule', sha256: 'b'.repeat(64) },
    reviewer: { label: '<script>alert(1)</script>', principal: null },
    findings: [{ id: 'F-1', disposition: 'false-positive', rationale: '<img src=x onerror=alert(1)>' }],
    statement: 'No action is recorded.',
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  const reports = renderProofReports({ source: { kind: 'linmas-review-capsule', findings: [{ id: 'F-1', title: '<unsafe>' }] }, receipt });
  assert.doesNotMatch(reports.html, /<script>|<img /i);
  assert.match(reports.html, /&lt;script&gt;/);
});

test('proof CLI creates a capsule bundle through the human wizard', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-cli-'));
  try {
    const capsulePath = path.join(root, 'capsule.json');
    const bundlePath = path.join(root, 'bundle');
    await fs.writeFile(capsulePath, `${JSON.stringify(capsule([finding]), null, 2)}\n`);
    const output = [];
    const answers = ['Tan', '1', 'Reproduced', 'Remediation is required.', 'y'];
    const io = {
      isTTY: true,
      stdout: { write(value) { output.push(value); } },
      stderr: { write() {} },
      async readLine() { return answers.shift() ?? null; }
    };
    assert.equal(await run(['node', 'linmas', 'proof', 'create', capsulePath, '--bundle', bundlePath], io), 0);
    assert.match(output.join(''), /Proof bundle created/);
    assert.equal((await verifyProofBundle(bundlePath)).receipt.summary.overallDisposition, 'remediation-required');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('optional SSH signature verifies as self-asserted and trusted', { skip: !process.env.CI && process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-ssh-'));
  try {
    const keyPath = path.join(root, 'id_ed25519');
    const capsulePath = path.join(root, 'capsule.json');
    const bundlePath = path.join(root, 'bundle');
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
    await fs.writeFile(capsulePath, `${JSON.stringify(capsule([finding]), null, 2)}\n`);
    const source = await loadCapsuleEvidence(capsulePath);
    const receipt = buildDecisionReceipt({
      subject: { kind: source.kind, sha256: source.sourceSha256 },
      reviewer: { label: 'Tan', principal: 'tan@linmas' },
      findings: [{ id: 'F-1', disposition: 'remediation-required', rationale: 'Reproduced.' }],
      statement: 'Remediation is required.',
      now: new Date('2026-07-19T00:00:00.000Z')
    });
    await writeProofBundle(bundlePath, source, receipt, { signingKey: keyPath });
    const selfAsserted = await verifyProofBundle(bundlePath);
    assert.deepEqual({ signature: selfAsserted.signature, identity: selfAsserted.identity }, { signature: 'valid', identity: 'self-asserted' });
    const publicKey = (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim();
    const allowed = path.join(root, 'allowed-signers');
    await fs.writeFile(allowed, `tan@linmas ${publicKey}\n`);
    const trusted = await verifyProofBundle(bundlePath, { allowedSignersPath: allowed });
    assert.equal(trusted.identity, 'trusted');
    assert.equal((await fs.readdir(path.join(bundlePath, 'signature'))).includes('id_ed25519'), false);
    await fs.writeFile(path.join(bundlePath, 'signature', 'manifest.sig'), 'tampered');
    await assert.rejects(verifyProofBundle(bundlePath), /signature verification failed|ssh-keygen command failed/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
