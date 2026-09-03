import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCodexSecurityEvidence } from '../src/proof/load-codex-scan.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { runProof } from '../src/proof/run-proof.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { verifyProofBundle } from '../src/proof/verify-bundle.mjs';

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function makeScan(root) {
  const scanRoot = path.join(root, 'scan');
  await fs.mkdir(scanRoot);
  const findings = {
    documentType: 'codex-security.findings', schemaVersion: '1.0', scanId: 'scan-1', findings: [{
      findingId: 'csf_0123456789abcdef01234567', occurrenceId: 'occ_0123456789abcdef01234567', ruleId: 'sql/injection',
      identity: { anchor: 'sql/injection' }, fingerprints: { algorithm: 'codex-security/v1', primary: `codex-security/v1:sha256:${'1'.repeat(64)}` },
      title: 'SQL injection', summary: 'User input reaches a query.', severity: { level: 'high' }, confidence: { level: 'high', rationale: 'Fixture.' },
      taxonomy: { category: 'injection', cwe: ['CWE-89'] }, locations: [{ path: 'src/db.js', startLine: 4 }], remediation: 'Use parameters.', provenance: { source: 'fixture' }
    }]
  };
  const coverage = {
    documentType: 'codex-security.coverage', schemaVersion: '1.0', scanId: 'scan-1', mode: 'repository', completeness: 'complete', inventoryStrategy: 'repository',
    includePaths: [], excludePaths: [], surfaces: [], explicitExclusions: [], deferred: []
  };
  const findingsBytes = Buffer.from(`${JSON.stringify(findings, null, 2)}\n`);
  const coverageBytes = Buffer.from(`${JSON.stringify(coverage, null, 2)}\n`);
  await fs.writeFile(path.join(scanRoot, 'findings.json'), findingsBytes);
  await fs.writeFile(path.join(scanRoot, 'coverage.json'), coverageBytes);
  const manifest = {
    documentType: 'codex-security.scan-manifest', schemaVersion: '1.0', scan: {
      id: 'scan-1', producer: { name: 'Codex Security', version: '1.0' }, status: 'completed',
      startedAt: '2026-07-19T00:00:00.000Z', completedAt: '2026-07-19T00:01:00.000Z', sealedAt: '2026-07-19T00:01:01.000Z',
      target: { kind: 'git_revision', targetId: 'repo', displayName: 'fixture', revision: 'abc123' },
      scope: { includePaths: [], excludePaths: [] }, coverageRef: 'coverage.json', findingsRef: 'findings.json',
      artifacts: [
        { path: 'findings.json', sha256: digest(findingsBytes), mediaType: 'application/json' },
        { path: 'coverage.json', sha256: digest(coverageBytes), mediaType: 'application/json' }
      ]
    }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(scanRoot, 'scan-manifest.json'), manifestBytes);
  return { scanRoot, manifestBytes };
}

test('imports a sealed Codex Security scan and verifies the resulting proof bundle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-codex-scan-'));
  try {
    const { scanRoot } = await makeScan(root);
    const source = await loadCodexSecurityEvidence(scanRoot);
    assert.equal(source.kind, 'codex-security-scan');
    assert.equal(source.findings[0].id, 'csf_0123456789abcdef01234567');
    const receipt = buildDecisionReceipt({
      subject: { kind: source.kind, sha256: source.sourceSha256 }, reviewer: { label: 'Tan', principal: null },
      findings: [{ id: source.findings[0].id, disposition: 'needs-more-evidence', rationale: 'Human validation is still needed.' }],
      statement: 'More evidence is needed before action.', now: new Date('2026-07-19T00:00:00.000Z')
    });
    const bundle = path.join(root, 'bundle');
    await writeProofBundle(bundle, source, receipt);
    const verified = await verifyProofBundle(bundle);
    assert.equal(verified.integrity, 'valid');
    assert.equal(verified.source.kind, 'codex-security-scan');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects a Codex scan when a listed artifact hash changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-codex-scan-'));
  try {
    const { scanRoot } = await makeScan(root);
    const changed = JSON.parse(await fs.readFile(path.join(scanRoot, 'findings.json'), 'utf8'));
    changed.findings[0].summary = 'tampered';
    await fs.writeFile(path.join(scanRoot, 'findings.json'), `${JSON.stringify(changed, null, 2)}\n`);
    await assert.rejects(loadCodexSecurityEvidence(scanRoot), /hash mismatch/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('F-004 rejects an additional sealed-scan artifact before any bundle is created', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-codex-extra-artifact-'));
  try {
    const { scanRoot } = await makeScan(root);
    const extraBytes = Buffer.from('synthetic extra evidence\n');
    await fs.writeFile(path.join(scanRoot, 'extra-evidence.txt'), extraBytes);
    const manifestPath = path.join(scanRoot, 'scan-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.scan.artifacts.push({
      path: 'extra-evidence.txt', sha256: digest(extraBytes), mediaType: 'text/plain'
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const answers = ['Synthetic reviewer', '4', 'More evidence is required.', 'Review remains required.', 'yes'];
    const io = { isTTY: true, stdout: { write() {} }, async readLine() { return answers.shift() ?? null; } };
    await assert.rejects(runProof({
      proofAction: 'create', proofSource: 'scan', proofBundle: 'bundle', proofErrors: [], signingKey: null
    }, { cwd: root, io }), /additional|noncanonical|unsupported/i);
    await assert.rejects(fs.lstat(path.join(root, 'bundle')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
