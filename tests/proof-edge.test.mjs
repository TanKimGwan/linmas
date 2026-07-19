import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { parseArgv } from '../src/cli/parse-args.mjs';
import { runProof } from '../src/proof/run-proof.mjs';
import { loadCapsuleEvidence, loadProofEvidence, sha256 } from '../src/proof/load-evidence.mjs';
import { buildDecisionReceipt, validateDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { deriveOverallDisposition, assertOverallDisposition } from '../src/proof/derive-disposition.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { verifyProofBundle } from '../src/proof/verify-bundle.mjs';
import { collectDecisionReceipt } from '../src/proof/wizard.mjs';
import { derivePublicKey } from '../src/proof/ssh-signature.mjs';
import { run as runCli } from '../bin/linmas.mjs';

const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };

function capsule() {
  return buildReviewCapsule({
    input: { source: 'fixture.diff', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: { schemaVersion: 1, caseId: 'edge', specialist: 'secure-code-reviewer', modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null }, scopeAndAssumptions: ['fixture'], findings: [], deterministicChecks: [], safetyBoundary },
    policyResult: null,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
}

async function makeBundle(root) {
  const capsulePath = path.join(root, 'capsule.json');
  await fs.writeFile(capsulePath, `${JSON.stringify(capsule(), null, 2)}\n`);
  const source = await loadCapsuleEvidence(capsulePath);
  const receipt = buildDecisionReceipt({ subject: { kind: source.kind, sha256: source.sourceSha256 }, reviewer: { label: 'Tan', principal: null }, findings: [], statement: 'No findings were reported.', now: new Date('2026-07-19T00:00:00.000Z') });
  const bundle = path.join(root, 'bundle');
  await writeProofBundle(bundle, source, receipt);
  return { bundle, source, receipt };
}

test('covers proof source and disposition input guards', async () => {
  await assert.rejects(loadCapsuleEvidence(''), /source path is invalid/);
  await assert.rejects(loadCapsuleEvidence('\0bad'), /source path is invalid/);
  await assert.rejects(loadCapsuleEvidence('/definitely/missing'), /could not be read/);
  await assert.rejects(loadProofEvidence('/definitely/missing'), /could not be inspected/);
  assert.throws(() => deriveOverallDisposition(null), /array/);
  assert.throws(() => deriveOverallDisposition([{ disposition: 'bad' }]), /invalid/);
  assert.throws(() => assertOverallDisposition('bad'), /invalid/);
  const tooLargeFs = { async lstat() { return { isSymbolicLink: () => false, isFile: () => true, size: 17 * 1024 * 1024 }; } };
  await assert.rejects(loadCapsuleEvidence('/tmp/capsule.json', { fsApi: tooLargeFs }), /exceeds/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-source-'));
  try {
    await fs.writeFile(path.join(root, 'bad.json'), '{bad');
    await assert.rejects(loadCapsuleEvidence(path.join(root, 'bad.json')), /invalid JSON/);
    await fs.writeFile(path.join(root, 'invalid.json'), '{}');
    await assert.rejects(loadCapsuleEvidence(path.join(root, 'invalid.json')), /source is invalid/);
    await fs.mkdir(path.join(root, 'directory'));
    await assert.rejects(loadCapsuleEvidence(path.join(root, 'directory')), /regular non-symlink/);
    await fs.writeFile(path.join(root, 'real.json'), '{}');
    await fs.symlink(path.join(root, 'real.json'), path.join(root, 'link.json'));
    await assert.rejects(loadCapsuleEvidence(path.join(root, 'link.json')), /regular non-symlink/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('wizard covers all dispositions, signing principal, invalid input, EOF, and cancellation', async () => {
  const source = { kind: 'linmas-review-capsule', sourceSha256: 'a'.repeat(64), findings: [1, 2, 3, 4].map((id) => ({ id: `F-${id}`, title: `Finding ${id}`, severity: 'High' })) };
  const answers = ['Tan', 'tan@linmas', '1', 'r1', '2', 'r2', '3', 'r3', '4', 'r4', 'Summary', 'y'];
  const output = [];
  const io = { isTTY: true, stdout: { write(value) { output.push(value); } }, async readLine() { return answers.shift() ?? null; } };
  const receipt = await collectDecisionReceipt(source, { io, signing: true, now: new Date('2026-07-19T00:00:00.000Z') });
  assert.equal(receipt.findings.length, 4);
  assert.equal(receipt.reviewer.principal, 'tan@linmas');
  assert.equal(receipt.summary.overallDisposition, 'remediation-required');
  await assert.rejects(collectDecisionReceipt(source, { io: { isTTY: false }, now: new Date() }), /TTY/);
  await assert.rejects(collectDecisionReceipt({ ...source, findings: [source.findings[0]] }, { io: { isTTY: true, stdout: { write() {} }, async readLine() { return 'Tan'; } } }), /disposition|input ended/i);
  await assert.rejects(collectDecisionReceipt({ ...source, findings: [source.findings[0]] }, { io: { isTTY: true, stdout: { write() {} }, async readLine() { return null; } } }), /ended unexpectedly/);
  const badAnswers = ['Tan', '9'];
  await assert.rejects(collectDecisionReceipt({ ...source, findings: [source.findings[0]] }, { io: { isTTY: true, stdout: { write() {} }, async readLine() { return badAnswers.shift() ?? null; } } }), /invalid disposition/);
  const cancelAnswers = ['Tan', 'false-positive', 'checked', 'No action', 'n'];
  await assert.rejects(collectDecisionReceipt({ ...source, findings: [source.findings[0]] }, { io: { isTTY: true, stdout: { write() {} }, async readLine() { return cancelAnswers.shift() ?? null; } } }), /cancelled/);
});

test('proof CLI exposes verify output and rejects malformed proof invocations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-edge-'));
  try {
    const { bundle } = await makeBundle(root);
    const output = [];
    const io = { isTTY: false, stdout: { write(value) { output.push(value); } }, stderr: { write() {} } };
    const textArgs = parseArgv(['node', 'linmas', 'proof', 'verify', bundle]);
    assert.equal((await runProof(textArgs, { io })).exitCode, 0);
    assert.match(output.join(''), /LINMAS PROOF VERIFICATION/);
    output.length = 0;
    const jsonArgs = parseArgv(['node', 'linmas', 'proof', 'verify', bundle, '--output', 'json']);
    assert.equal((await runProof(jsonArgs, { io })).exitCode, 0);
    assert.match(output.join(''), /"integrity": "valid"/);
    await assert.rejects(runProof(parseArgv(['node', 'linmas', 'proof', 'verify', bundle, '--signing-key', 'key']), { io }), /only valid/);
    await assert.rejects(runProof({ proofErrors: ['unknown'] }, { io }), /unknown/);
    await assert.rejects(runProof({ proofAction: 'create', proofSource: 'x', proofBundle: null, proofErrors: [] }, { io }), /requires source/);
    await assert.rejects(runProof({ proofAction: 'verify', proofSource: null, proofErrors: [] }, { io }), /requires a bundle/);
    await assert.rejects(runProof({ proofAction: 'invalid', proofSource: null, proofErrors: [] }, { io }), /must be create or verify/);
    const cliErrors = [];
    const cliCode = await runCli(['node', 'linmas', 'proof', 'verify', '/definitely/missing-proof-bundle'], {
      stdout: { write() {} }, stderr: { write(value) { cliErrors.push(value); } }
    });
    assert.equal(cliCode, 4);
    assert.match(cliErrors.join(''), /proof bundle artifact is missing/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('receipt validation fails closed for malformed and contradictory fields', () => {
  const valid = buildDecisionReceipt({ subject: { kind: 'linmas-review-capsule', sha256: 'a'.repeat(64) }, reviewer: { label: 'Tan', principal: null }, findings: [], statement: 'No findings were reported.', now: new Date('2026-07-19T00:00:00.000Z') });
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.schemaVersion = 2; },
    (value) => { value.kind = 'other'; },
    (value) => { value.subject.kind = 'bad'; },
    (value) => { value.subject.sha256 = 'bad'; },
    (value) => { value.reviewer.label = ''; },
    (value) => { value.reviewer.principal = 3; },
    (value) => { value.decidedAt = 'bad'; },
    (value) => { value.findings = 'bad'; },
    (value) => { value.summary.overallDisposition = 'bad'; },
    (value) => { value.summary.statement = ''; },
    (value) => { value.safetyBoundary.statement = 'Review is optional.'; },
    (value) => { value.safetyBoundary.extra = true; }
  ];
  for (const mutate of mutations) assert.throws(() => validateDecisionReceipt(mutate(structuredClone(valid))), /proof receipt/);
  const withFinding = buildDecisionReceipt({ subject: valid.subject, reviewer: valid.reviewer, findings: [{ id: 'F', disposition: 'false-positive', rationale: 'checked' }], statement: 'No action is recorded.', now: new Date('2026-07-19T00:00:00.000Z') });
  const findingMutations = [
    (value) => { value.findings[0].id = ''; },
    (value) => { value.findings[0].disposition = 'bad'; },
    (value) => { value.findings[0].rationale = ''; },
    (value) => { value.findings.push(structuredClone(value.findings[0])); },
    (value) => { value.summary.overallDisposition = 'accepted-risk'; },
    (value) => { value.summary.statement = 'Approved.'; }
  ];
  for (const mutate of findingMutations) assert.throws(() => validateDecisionReceipt(mutate(structuredClone(withFinding))), /proof receipt/);
});

test('verifier rejects manifest shape and artifact binding changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-manifest-'));
  try {
    const { bundle } = await makeBundle(root);
    const manifestPath = path.join(bundle, 'manifest.json');
    const original = await fs.readFile(manifestPath, 'utf8');
    const mutations = [
      (value) => { value.kind = 'bad'; },
      (value) => { value.source.sha256 = 'bad'; },
      (value) => { value.receipt.path = '../secret'; },
      (value) => { value.reports = []; },
      (value) => { value.reports[0].path = 'other.md'; },
      (value) => { value.reports[0].sha256 = 'a'.repeat(64); },
      (value) => { value.artifacts = []; },
      (value) => { value.signature = { format: 'bad' }; },
      (value) => { value.safetyBoundary.satisfied = false; }
    ];
    for (const mutate of mutations) {
      const value = JSON.parse(original);
      mutate(value);
      await fs.writeFile(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
      await assert.rejects(verifyProofBundle(bundle), /manifest|integrity|artifact|report/i);
      await fs.writeFile(manifestPath, original);
    }
    await fs.symlink('..', path.join(bundle, 'evidence', 'link'));
    const symlinkManifest = JSON.parse(original);
    const sourceArtifact = symlinkManifest.artifacts.find((entry) => entry.path === 'evidence/review-capsule.json');
    symlinkManifest.artifacts.push({ ...sourceArtifact });
    sourceArtifact.path = 'evidence/link/review-capsule.json';
    await fs.writeFile(manifestPath, `${JSON.stringify(symlinkManifest, null, 2)}\n`);
    await assert.rejects(verifyProofBundle(bundle), /symlink|manifest path/i);
    await fs.writeFile(manifestPath, original);
    await fs.rm(path.join(bundle, 'report.md'));
    await assert.rejects(verifyProofBundle(bundle), /missing|artifact/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verifier rejects root, manifest, duplicate, and receipt contract failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-contract-'));
  try {
    const { bundle } = await makeBundle(root);
    await assert.rejects(verifyProofBundle(path.join(bundle, 'report.md')), /regular directory/);
    const bundleLink = path.join(root, 'bundle-link');
    await fs.symlink(bundle, bundleLink);
    await assert.rejects(verifyProofBundle(bundleLink), /regular directory/);

    const manifestPath = path.join(bundle, 'manifest.json');
    const originalManifest = await fs.readFile(manifestPath, 'utf8');
    await fs.writeFile(manifestPath, '{bad');
    await assert.rejects(verifyProofBundle(bundle), /invalid JSON/);
    await fs.writeFile(manifestPath, originalManifest);

    const duplicateManifest = JSON.parse(originalManifest);
    duplicateManifest.artifacts.push(structuredClone(duplicateManifest.artifacts[0]));
    await fs.writeFile(manifestPath, `${JSON.stringify(duplicateManifest, null, 2)}\n`);
    await assert.rejects(verifyProofBundle(bundle), /duplicate manifest artifact/);
    await fs.writeFile(manifestPath, originalManifest);

    const receiptPath = path.join(bundle, 'decision-receipt.json');
    const invalidReceiptBytes = Buffer.from('{bad\n');
    await fs.writeFile(receiptPath, invalidReceiptBytes);
    const invalidReceiptManifest = JSON.parse(originalManifest);
    const receiptArtifact = invalidReceiptManifest.artifacts.find((entry) => entry.path === 'decision-receipt.json');
    receiptArtifact.bytes = invalidReceiptBytes.byteLength;
    receiptArtifact.sha256 = sha256(invalidReceiptBytes);
    invalidReceiptManifest.receipt.sha256 = sha256(invalidReceiptBytes);
    await fs.writeFile(manifestPath, `${JSON.stringify(invalidReceiptManifest, null, 2)}\n`);
    await assert.rejects(verifyProofBundle(bundle), /receipt is invalid/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('bundle writer rejects preflight, binding, and unexpected filesystem failures', async () => {
  await assert.rejects(derivePublicKey('/definitely/missing-private-key'), /SSH signing key could not be inspected/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-write-'));
  try {
    const { bundle, source, receipt } = await makeBundle(root);
    await assert.rejects(writeProofBundle(bundle, source, receipt), /already exists/);
    await assert.rejects(writeProofBundle(path.join(root, 'capsule.json', 'child'), source, receipt), /parent must be a directory/);
    const mismatch = structuredClone(receipt);
    mismatch.subject.sha256 = 'c'.repeat(64);
    await assert.rejects(writeProofBundle(path.join(root, 'mismatch'), source, mismatch), /bind/);
    await assert.rejects(writeProofBundle(path.join(root, 'invalid'), null, receipt), /source is invalid/);
    const unsafeSource = { ...source, evidenceFiles: [...source.evidenceFiles, { relativePath: '../unsafe', bytes: Buffer.from('unsafe') }] };
    await assert.rejects(writeProofBundle(path.join(root, 'unsafe'), unsafeSource, receipt), /unsafe/);
    await assert.rejects(writeProofBundle(path.join(root, 'signing-without-principal'), source, receipt, { signingKey: '/definitely/missing-key' }), /signer principal/);
    const failingFs = { ...fs, async mkdir() { throw new Error('synthetic mkdir failure'); } };
    await assert.rejects(writeProofBundle(path.join(root, 'failure'), source, receipt, { fsApi: failingFs }), /could not be written/);
    assert.equal(await fs.stat(path.join(root, 'failure')).then(() => true, () => false), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
