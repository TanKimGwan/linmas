import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCodexSecurityEvidence } from '../src/proof/load-codex-scan.mjs';

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function validScan(root) {
  const scan = path.join(root, 'scan');
  await fs.mkdir(scan);
  const findings = { documentType: 'codex-security.findings', schemaVersion: '1.0', scanId: 'S', findings: [{ findingId: 'csf_0123456789abcdef01234567', occurrenceId: 'occ_0123456789abcdef01234567', ruleId: 'rule', identity: { anchor: 'rule' }, fingerprints: { algorithm: 'codex-security/v1', primary: `codex-security/v1:sha256:${'2'.repeat(64)}` }, title: 'title', summary: 'summary', severity: { level: 'low' }, confidence: { level: 'low', rationale: 'rationale' }, taxonomy: { category: 'category', cwe: [] }, locations: [{ path: 'a.js', startLine: 1 }], remediation: 'fix', provenance: { source: 'fixture' } }] };
  const coverage = { documentType: 'codex-security.coverage', schemaVersion: '1.0', scanId: 'S', mode: 'repository', completeness: 'partial', inventoryStrategy: 'repository', includePaths: [], excludePaths: [], surfaces: [], explicitExclusions: [], deferred: [] };
  const findingBytes = Buffer.from(`${JSON.stringify(findings)}\n`);
  const coverageBytes = Buffer.from(`${JSON.stringify(coverage)}\n`);
  await fs.writeFile(path.join(scan, 'findings.json'), findingBytes);
  await fs.writeFile(path.join(scan, 'coverage.json'), coverageBytes);
  const manifest = { documentType: 'codex-security.scan-manifest', schemaVersion: '1.0', scan: { id: 'S', producer: { name: 'Codex', version: '1' }, status: 'completed', startedAt: '2026-07-19T00:00:00Z', completedAt: '2026-07-19T00:01:00Z', sealedAt: '2026-07-19T00:02:00Z', target: {}, scope: {}, coverageRef: 'coverage.json', findingsRef: 'findings.json', artifacts: [{ path: 'findings.json', sha256: digest(findingBytes), mediaType: 'application/json' }, { path: 'coverage.json', sha256: digest(coverageBytes), mediaType: 'application/json' }] } };
  await fs.writeFile(path.join(scan, 'scan-manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { scan, manifest };
}

async function writeManifest(scan, manifest) { await fs.writeFile(path.join(scan, 'scan-manifest.json'), `${JSON.stringify(manifest)}\n`); }

test('Codex manifest validation rejects every incomplete sealed-scan condition', async () => {
  await assert.rejects(loadCodexSecurityEvidence('/definitely/missing-codex-scan'), /could not be read/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-codex-branches-'));
  try {
    const { scan, manifest: original } = await validScan(root);
    const mutations = [
      (value) => { value.documentType = 'bad'; },
      (value) => { value.schemaVersion = '2.0'; },
      (value) => { value.scan = null; },
      (value) => { delete value.scan.id; },
      (value) => { value.scan.id = ''; },
      (value) => { value.scan.producer = []; },
      (value) => { value.scan.producer.name = ''; },
      (value) => { value.scan.producer.version = ''; },
      (value) => { value.scan.status = 'running'; },
      (value) => { value.scan.startedAt = 'bad'; },
      (value) => { value.scan.coverageRef = '../coverage.json'; },
      (value) => { value.scan.findingsRef = 'other.json'; },
      (value) => { value.scan.artifacts = []; },
      (value) => { value.scan.artifacts[0].path = '/findings.json'; },
      (value) => { value.scan.artifacts[0].path = 'a\\b'; },
      (value) => { value.scan.artifacts[0].path = '../findings.json'; },
      (value) => { value.scan.artifacts.push(structuredClone(value.scan.artifacts[0])); },
      (value) => { value.scan.artifacts[0].sha256 = 'bad'; },
      (value) => { value.scan.artifacts[0].mediaType = ''; }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const value = structuredClone(original);
      mutate(value);
      await writeManifest(scan, value);
      await assert.rejects(loadCodexSecurityEvidence(scan), /Codex|scan|artifact|manifest|hash/i, `manifest mutation ${index}`);
    }
    await writeManifest(scan, original);
    await fs.rm(path.join(scan, 'coverage.json'));
    await assert.rejects(loadCodexSecurityEvidence(scan), /coverage|could not be read/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Codex findings and coverage validators reject malformed documents after hash refresh', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-codex-docs-'));
  try {
    const { scan, manifest: original } = await validScan(root);
    const originalFindingBytes = await fs.readFile(path.join(scan, 'findings.json'));
    const findingMutations = [
      (value) => { value.documentType = 'bad'; },
      (value) => { value.schemaVersion = '2.0'; },
      (value) => { value.scanId = 'other'; },
      (value) => { value.findings[0].findingId = 'bad'; },
      (value) => { value.findings[0].findingId = 'csf_0123456789abcdef01234567'; value.findings.push(structuredClone(value.findings[0])); },
      (value) => { delete value.findings[0].title; },
      (value) => { value.findings[0].severity.level = 'bad'; },
      (value) => { value.findings[0].locations = []; },
      (value) => { value.findings[0].remediation = ''; }
    ];
    for (const mutate of findingMutations) {
      const value = JSON.parse(await fs.readFile(path.join(scan, 'findings.json'), 'utf8'));
      mutate(value);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      await fs.writeFile(path.join(scan, 'findings.json'), bytes);
      const manifest = structuredClone(original);
      manifest.scan.artifacts[0].sha256 = digest(bytes);
      await writeManifest(scan, manifest);
      await assert.rejects(loadCodexSecurityEvidence(scan), /finding|Codex|invalid|duplicated/i);
      await fs.writeFile(path.join(scan, 'findings.json'), originalFindingBytes);
      await writeManifest(scan, original);
    }
    const coverageMutations = [
      (value) => { value.documentType = 'bad'; },
      (value) => { value.schemaVersion = '2.0'; },
      (value) => { value.scanId = 'other'; },
      (value) => { value.completeness = 'bad'; },
      (value) => { value.surfaces = null; },
      (value) => { value.deferred = null; }
    ];
    for (const mutate of coverageMutations) {
      const value = { documentType: 'codex-security.coverage', schemaVersion: '1.0', scanId: 'S', mode: 'repository', completeness: 'partial', inventoryStrategy: 'repository', includePaths: [], excludePaths: [], surfaces: [], explicitExclusions: [], deferred: [] };
      mutate(value);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      await fs.writeFile(path.join(scan, 'coverage.json'), bytes);
      const manifest = structuredClone(original);
      manifest.scan.artifacts[1].sha256 = digest(bytes);
      await writeManifest(scan, manifest);
      await assert.rejects(loadCodexSecurityEvidence(scan), /coverage|Codex|invalid/i);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
