import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ProofError } from './errors.mjs';
import { MAX_PROOF_TEXT } from './constants.mjs';

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024;

export async function loadCodexSecurityEvidence(scanPath, { fsApi = fs } = {}) {
  const root = path.resolve(scanPath);
  const rootStat = await safeLstat(root, fsApi, 'Codex scan root');
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw inputError('Codex scan source must be a regular directory');
  const manifestBytes = await readJsonFile(root, 'scan-manifest.json', fsApi);
  const manifest = parseJson(manifestBytes, 'scan-manifest.json');
  validateManifest(manifest);
  const findingsBytes = await readJsonFile(root, manifest.scan.findingsRef, fsApi);
  const coverageBytes = await readJsonFile(root, manifest.scan.coverageRef, fsApi);
  const findings = parseJson(findingsBytes, 'findings.json');
  const coverage = parseJson(coverageBytes, 'coverage.json');
  validateFindings(findings, manifest.scan.id);
  validateCoverage(coverage, manifest.scan.id);
  const artifactByPath = new Map(manifest.scan.artifacts.map((artifact) => [artifact.path, artifact]));
  let total = 0;
  for (const artifact of manifest.scan.artifacts) {
    const bytes = await hashArtifact(root, artifact.path, artifact.sha256, fsApi);
    total += bytes;
    if (total > MAX_TOTAL_ARTIFACT_BYTES) throw contractError(`Codex scan artifacts exceed ${MAX_TOTAL_ARTIFACT_BYTES} bytes`);
  }
  for (const required of ['findings.json', 'coverage.json']) if (!artifactByPath.has(required)) throw contractError(`${required} is missing from scan manifest artifacts`);
  return {
    kind: 'codex-security-scan',
    sourcePath: root,
    sourceSha256: sha256(manifestBytes),
    findings: findings.findings.map((finding) => ({
      id: finding.findingId,
      title: finding.title,
      severity: finding.severity.level,
      evidence: finding.summary,
      remediation: finding.remediation,
      verification: finding.validation ? JSON.stringify(finding.validation) : 'Review the source finding validation.'
    })),
    scanId: manifest.scan.id,
    coverage,
    evidenceFiles: [
      { relativePath: 'evidence/codex-security/scan-manifest.json', bytes: manifestBytes },
      { relativePath: 'evidence/codex-security/findings.json', bytes: findingsBytes },
      { relativePath: 'evidence/codex-security/coverage.json', bytes: coverageBytes }
    ]
  };
}

function validateManifest(value) {
  object(value, 'scan-manifest');
  if (value.documentType !== 'codex-security.scan-manifest' || value.schemaVersion !== '1.0') throw contractError('unsupported Codex scan manifest schema');
  object(value.scan, 'scan-manifest.scan');
  for (const field of ['id', 'producer', 'status', 'startedAt', 'completedAt', 'sealedAt', 'target', 'scope', 'coverageRef', 'findingsRef', 'artifacts']) if (!Object.hasOwn(value.scan, field)) throw contractError(`scan-manifest.scan.${field} is required`);
  string(value.scan.id, 'scan.id');
  object(value.scan.producer, 'scan.producer');
  string(value.scan.producer.name, 'scan.producer.name');
  string(value.scan.producer.version, 'scan.producer.version');
  if (value.scan.status !== 'completed') throw contractError('Codex scan is not completed');
  for (const field of ['startedAt', 'completedAt', 'sealedAt']) if (Number.isNaN(Date.parse(value.scan[field]))) throw contractError(`scan.${field} is invalid`);
  if (value.scan.coverageRef !== 'coverage.json' || value.scan.findingsRef !== 'findings.json') throw contractError('Codex scan references must use canonical filenames');
  if (!Array.isArray(value.scan.artifacts) || value.scan.artifacts.length === 0) throw contractError('scan.artifacts must be a non-empty array');
  const paths = new Set();
  for (const artifact of value.scan.artifacts) {
    object(artifact, 'scan.artifact');
    string(artifact.path, 'scan.artifact.path');
    if (!safeRelativePath(artifact.path) || paths.has(artifact.path)) throw contractError('scan artifact path is unsafe or duplicated');
    paths.add(artifact.path);
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw contractError(`invalid hash for ${artifact.path}`);
    string(artifact.mediaType, 'scan.artifact.mediaType');
  }
}

function validateFindings(value, scanId) {
  object(value, 'findings');
  if (value.documentType !== 'codex-security.findings' || value.schemaVersion !== '1.0' || value.scanId !== scanId || !Array.isArray(value.findings)) throw contractError('Codex findings document is invalid');
  const ids = new Set();
  for (const finding of value.findings) {
    object(finding, 'finding');
    for (const field of ['findingId', 'occurrenceId', 'ruleId', 'identity', 'fingerprints', 'title', 'summary', 'severity', 'confidence', 'taxonomy', 'locations', 'remediation', 'provenance']) if (!Object.hasOwn(finding, field)) throw contractError(`Codex finding.${field} is required`);
    if (typeof finding.findingId !== 'string' || !/^csf_[a-f0-9]{24}$/.test(finding.findingId) || ids.has(finding.findingId)) throw contractError('Codex finding ID is invalid or duplicated');
    ids.add(finding.findingId);
    string(finding.title, 'finding.title');
    string(finding.summary, 'finding.summary');
    object(finding.severity, 'finding.severity');
    if (!['critical', 'high', 'medium', 'low', 'informational'].includes(finding.severity.level)) throw contractError('Codex finding severity is invalid');
    string(finding.remediation, 'finding.remediation');
    if (!Array.isArray(finding.locations) || finding.locations.length === 0) throw contractError('Codex finding locations are required');
  }
}

function validateCoverage(value, scanId) {
  object(value, 'coverage');
  if (value.documentType !== 'codex-security.coverage' || value.schemaVersion !== '1.0' || value.scanId !== scanId) throw contractError('Codex coverage document is invalid');
  if (!['complete', 'partial', 'unknown'].includes(value.completeness)) throw contractError('Codex coverage completeness is invalid');
  if (!Array.isArray(value.surfaces) || !Array.isArray(value.deferred)) throw contractError('Codex coverage surfaces/deferred are invalid');
}

async function hashArtifact(root, relativePath, expected, fsApi) {
  await assertNoSymlinkPath(root, relativePath, fsApi);
  const target = path.join(root, ...relativePath.split('/'));
  const stat = await safeLstat(target, fsApi, `Codex artifact ${relativePath}`);
  if (stat.isSymbolicLink() || !stat.isFile()) throw contractError(`Codex artifact is not a regular file: ${relativePath}`);
  const hash = createHash('sha256');
  let total = 0;
  const stream = fsApi.createReadStream ? fsApi.createReadStream(target) : (await import('node:fs')).createReadStream(target);
  for await (const chunk of stream) { total += chunk.byteLength; hash.update(chunk); }
  if (hash.digest('hex') !== expected) throw contractError(`Codex artifact hash mismatch: ${relativePath}`);
  return total;
}

async function readJsonFile(root, relativePath, fsApi) {
  if (!safeRelativePath(relativePath)) throw contractError(`unsafe Codex JSON path: ${relativePath}`);
  await assertNoSymlinkPath(root, relativePath, fsApi);
  const target = path.join(root, ...relativePath.split('/'));
  const stat = await safeLstat(target, fsApi, relativePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw contractError(`${relativePath} must be a regular file`);
  if (stat.size > MAX_JSON_BYTES) throw contractError(`${relativePath} exceeds ${MAX_JSON_BYTES} bytes`);
  return fsApi.readFile(target);
}

function parseJson(bytes, label) { try { return JSON.parse(bytes.toString('utf8')); } catch (cause) { throw contractError(`${label} contains invalid JSON`, cause); } }
function safeRelativePath(value) { return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'); }
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError(`${field} must be an object`); }
function string(value, field) { if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROOF_TEXT) throw contractError(`${field} is invalid`); }
async function safeLstat(target, fsApi, label) { try { return await fsApi.lstat(target); } catch (cause) { throw inputError(`${label} could not be read`, cause); } }
async function assertNoSymlinkPath(root, relativePath, fsApi) {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const stat = await safeLstat(current, fsApi, relativePath);
    if (stat.isSymbolicLink()) throw contractError(`Codex artifact path contains a symlink: ${relativePath}`);
  }
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function inputError(message, cause) { const error = new ProofError(message, 'input', 2); if (cause) error.cause = cause; return error; }
function contractError(message, cause) { const error = new ProofError(message, 'contract', 4); if (cause) error.cause = cause; return error; }
