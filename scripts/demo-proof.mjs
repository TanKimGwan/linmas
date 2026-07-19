#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapsuleEvidence } from '../src/proof/load-evidence.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { verifyProofBundle } from '../src/proof/verify-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'examples', 'build-week', 'expected-offline-capsule.json');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-proof-demo-'));
try {
  const source = await loadCapsuleEvidence(sourcePath);
  const receipt = buildDecisionReceipt({
    subject: { kind: source.kind, sha256: source.sourceSha256 },
    reviewer: { label: 'offline-demo-reviewer', principal: null },
    findings: source.findings.map((finding) => ({ id: finding.id, disposition: 'remediation-required', rationale: 'Synthetic judge evidence requires remediation review.' })),
    statement: 'Remediation is required before release.',
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  const bundle = path.join(tempRoot, 'proof-bundle');
  await writeProofBundle(bundle, source, receipt, { now: new Date('2026-07-19T00:00:00.000Z') });
  const result = await verifyProofBundle(bundle);
  console.log('LINMAS PROOF DEMO');
  console.log('Execution   OFFLINE FIXTURE — NO MODEL CALL');
  console.log(`Findings    ${source.findings.length}`);
  console.log(`Disposition ${result.receipt.summary.overallDisposition}`);
  console.log(`Integrity   ${result.integrity}`);
  console.log('Safety      Human review remains required.');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
