import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PUBLIC_SKILL_IDS } from '../src/core/skill-catalog.mjs';
import { listTools } from '../mcp/server.mjs';
import {
  AUTHORITATIVE_COVERED_PATHS,
  CLEAN_IDENTITY_PATH,
  GENERATED_EVIDENCE_PATHS,
  PRIVATE_UNTRACKED_PREFIXES,
  gitTrackedPathUniverse
} from '../scripts/validate-evidence-binding.mjs';
import { createCompatibilityEvidenceFixture } from './helpers/compatibility-evidence-fixture.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD_PATH = 'docs/compatibility/evidence/v0.9.0-record.json';
const SNAPSHOT_PATH = 'docs/compatibility/evidence/v0.9.0-snapshot.json';
const BASELINE_COMMIT = '68a5cd175b16d26fd58834acd489ebcbe8a8ec57';
const BASELINE_TAG = 'v0.8.0';
const BASELINE_TAG_OBJECT = 'd03d7f4e5f63cf2c76a3e24f87854681ffac9959';
const EXPECTED_EVIDENCE_KINDS = new Set([
  'source-inspection',
  'deterministic-fixture',
  'actual-runtime-loading',
  'live-model-evaluation'
]);
const RESULT_STATUSES = new Set(['PASS', 'FAIL', 'UNSUPPORTED', 'UNKNOWN']);
const MCP_OPERATION_TESTS = Object.freeze({
  linmas_review_prepare: ['offline prepare is read-only and returns prepared plus human-review state'],
  linmas_review_compare: ['offline compare, policy evaluate, and proof verify return verified bounded results'],
  linmas_policy_evaluate: ['offline compare, policy evaluate, and proof verify return verified bounded results'],
  linmas_proof_verify: ['offline compare, policy evaluate, and proof verify return verified bounded results'],
  linmas_proof_create: ['proof create requires explicit write confirmation and verifies its own result'],
  linmas_review_execute: ['review execute is prepared without consent and only executes a mocked provider after consent'],
  linmas_review_decide: ['F-006 decision gate rejects tampered review references and uses immutable severity']
});
const MCP_TEST_PATH = 'tests/mcp-server.test.mjs';
const REQUIRED_RECORD_FIELDS = [
  'recordId',
  'runtimeProduct',
  'runtimeVersion',
  'osVersion',
  'adapterVersion',
  'operation',
  'capabilityProfile',
  'evidenceRevision',
  'collectionDate',
  'evidenceKind',
  'expectedResult',
  'observedResult',
  'evidenceLocation',
  'limitation'
];

const read = (name) => fs.readFileSync(path.join(REPOSITORY_ROOT, name), 'utf8');
let compatibilityFixture;
function fixture() {
  compatibilityFixture ??= createCompatibilityEvidenceFixture(REPOSITORY_ROOT);
  return compatibilityFixture;
}
after(() => compatibilityFixture?.cleanup());
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(
  name === RECORD_PATH || name === SNAPSHOT_PATH ? fixture().root : REPOSITORY_ROOT,
  name
), 'utf8'));

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

export function computeSnapshotDigest(snapshot) {
  const { snapshotDigest, ...material } = snapshot;
  void snapshotDigest;
  return sha256(Buffer.from(canonicalJson(material)));
}

export function validateCompatibilityEvidence({
  repositoryRoot = fixture().root,
  record,
  snapshot,
  currentRevision = gitHead(repositoryRoot)
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const candidate = record?.candidate;

  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('record must be an object');
  if (record?.schemaVersion !== 1) fail('record schemaVersion must be 1');
  if (record?.status !== 'UNRELEASED') fail('record status must be UNRELEASED');
  if (typeof record?.collectionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.collectionDate)) fail('record collectionDate is invalid');
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('candidate metadata is required');
  if (typeof candidate?.implementationHead !== 'string' || !/^[a-f0-9]{40}$/.test(candidate.implementationHead)) fail('candidate implementationHead is invalid');
  if (candidate?.implementationHead !== currentRevision) fail('record is stale: implementation HEAD does not match current HEAD');
  if (candidate?.baseline?.securityCommit !== BASELINE_COMMIT) fail('candidate baseline security commit is invalid');
  if (candidate?.workingTreeState !== 'dirty') fail('candidate workingTreeState must be dirty');
  validateCandidateMetadata(repositoryRoot, candidate, fail);
  validateBaselineIdentity(repositoryRoot, candidate?.baseline, fail);

  const expectedRevision = candidate?.snapshot?.digest
    ? `HEAD ${candidate.implementationHead} + dirty snapshot sha256:${candidate.snapshot.digest}`
    : null;
  if (candidate?.sourceRevision !== expectedRevision) fail('candidate sourceRevision is not bound to the snapshot digest');
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('snapshot manifest is required');
  if (snapshot?.schemaVersion !== 1) fail('snapshot schemaVersion must be 1');
  if (snapshot?.snapshotKind !== 'working-tree-overlay') fail('snapshot kind is invalid');
  if (snapshot?.baseImplementationHead !== candidate?.implementationHead) fail('snapshot base implementation HEAD is invalid');
  if (snapshot?.baseSecurityCommit !== BASELINE_COMMIT) fail('snapshot base security commit is invalid');
  if (candidate?.snapshot?.path !== SNAPSHOT_PATH) fail('record snapshot path is invalid');
  if (candidate?.snapshot?.digest !== snapshot?.snapshotDigest) fail('record snapshot digest does not match manifest');
  if (snapshot && typeof snapshot.snapshotDigest === 'string' && computeSnapshotDigest(snapshot) !== snapshot.snapshotDigest) fail('snapshot digest is stale');

  validateSnapshotFiles(repositoryRoot, snapshot, fail);
  validateEvidenceArtifacts(repositoryRoot, record, fail);

  const inventory = record?.inventory;
  if (!inventory || !Array.isArray(inventory.skills) || !Array.isArray(inventory.mcpTools)) {
    fail('record inventory is required');
  } else {
    assertExactSet(inventory.skills, PUBLIC_SKILL_IDS, 'skill inventory', fail);
    assertExactSet(inventory.mcpTools, listTools().map((tool) => tool.name), 'MCP tool inventory', fail);
  }

  const records = record?.records;
  if (!Array.isArray(records) || records.length === 0) {
    fail('evidence records are required');
  } else {
    const recordIds = new Set();
    const operations = new Set();
    for (const evidence of records) {
      validateEvidenceRecord(evidence, {
        expectedRevision: candidate?.sourceRevision,
        collectionDate: record?.collectionDate,
        repositoryRoot,
        fail
      });
      if (evidence && typeof evidence.recordId === 'string') {
        if (recordIds.has(evidence.recordId)) fail(`duplicate evidence record: ${evidence.recordId}`);
        recordIds.add(evidence.recordId);
      }
      if (evidence && typeof evidence.operation === 'string') {
        if (operations.has(evidence.operation)) fail(`duplicate evidence operation: ${evidence.operation}`);
        operations.add(evidence.operation);
      }
    }
    assertExactSet(
      records.filter((evidence) => typeof evidence?.operation === 'string' && evidence.operation.startsWith('skill:'))
        .map((evidence) => evidence.operation.slice('skill:'.length, -':catalog'.length)),
      PUBLIC_SKILL_IDS,
      'skill evidence records',
      fail
    );
    assertExactSet(
      records.filter((evidence) => typeof evidence?.operation === 'string' && evidence.operation.startsWith('mcp:'))
        .map((evidence) => evidence.operation.slice('mcp:'.length)),
      listTools().map((tool) => tool.name),
      'MCP evidence records',
      fail
    );
  }

  if (errors.length) throw new Error(`compatibility evidence invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  return true;
}

function validateCandidateMetadata(repositoryRoot, candidate, fail) {
  if (!candidate || typeof candidate !== 'object') return;
  const readJsonFile = (relativePath) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
    } catch (error) {
      fail(`candidate metadata file is unavailable: ${relativePath} (${error.message})`);
      return null;
    }
  };
  const packageJson = readJsonFile('package.json');
  const lockJson = readJsonFile('package-lock.json');
  const pluginPackage = readJsonFile('plugins/linmas/package.json');
  const pluginManifest = readJsonFile('plugins/linmas/.codex-plugin/plugin.json');
  if (packageJson && candidate.packageVersion !== packageJson.version) fail('candidate package version does not match package.json');
  if (lockJson && candidate.packageVersion !== lockJson.packages?.['']?.version) fail('candidate package version does not match package-lock.json');
  if (pluginPackage && candidate.pluginVersion !== pluginPackage.version) fail('candidate plugin version does not match plugin package metadata');
  if (pluginManifest && candidate.pluginVersion !== pluginManifest.version) fail('candidate plugin version does not match plugin manifest');
  if (packageJson && packageJson.name !== 'linmas') fail('package metadata name is invalid');
  if (pluginPackage && pluginPackage.name !== 'linmas') fail('plugin package metadata name is invalid');
  if (pluginManifest && pluginManifest.name !== 'linmas') fail('plugin manifest name is invalid');
  if (candidate.packageArtifact) {
    if (candidate.packageArtifact.filename !== 'linmas-0.9.0.tgz') fail('package artifact filename is invalid');
    if (candidate.packageArtifact.entryCount !== 151) fail('package artifact entry count is invalid');
    if (candidate.packageArtifact.bytes !== 1751129) fail('package artifact byte count is invalid');
    if (candidate.packageArtifact.sha256 !== 'e96ff656bc398485f60fd0062e995008539d5e93c37210c20851b22f90e2e3b0') fail('package artifact digest is invalid');
    if (candidate.packageArtifact.inventorySha256 !== 'd461b257d99f1cfde34653d12981f3486ab28e23e1864df7d94979bc575bcf21') fail('package artifact inventory digest is invalid');
    if (candidate.packageArtifact.published !== false) fail('package artifact publication state must remain false');
  } else {
    fail('package artifact evidence is required');
  }
  if (candidate.pluginParity?.byteIdentical !== true || candidate.pluginParity?.skillCount !== 11 || candidate.pluginParity?.fileCount !== 108 || candidate.pluginParity?.contentDigest !== 'd87bd98b8ce98a1f42df6ab1d1b6f8a033eea5ce800ca697bb0739b5ca34a586') fail('plugin parity evidence is incomplete');
}

function validateBaselineIdentity(repositoryRoot, baseline, fail) {
  if (!baseline || typeof baseline !== 'object') {
    fail('baseline metadata is required');
    return;
  }
  if (baseline.tag !== BASELINE_TAG) fail('baseline tag is invalid');
  if (baseline.tagObject !== BASELINE_TAG_OBJECT) fail('baseline tag object is invalid');
  if (baseline.peeledCommit !== BASELINE_COMMIT) fail('baseline peeled commit is invalid');
  if (baseline.signatureTrust !== 'UNVERIFIED') fail('baseline signature trust must remain UNVERIFIED');
  try {
    if (gitRef(repositoryRoot, `${baseline.tag}^{tag}`) !== baseline.tagObject) fail('baseline tag object does not match local Git');
    if (gitRef(repositoryRoot, `${baseline.tag}^{}`) !== baseline.peeledCommit) fail('baseline peeled commit does not match local Git');
  } catch (error) {
    fail(`baseline tag cannot be resolved locally (${error.message})`);
  }
}

function validateSnapshotFiles(repositoryRoot, snapshot, fail) {
  if (!Array.isArray(snapshot?.includedFiles) || snapshot.includedFiles.length === 0) {
    fail('snapshot includedFiles are required');
    return;
  }
  const paths = new Set();
  for (const file of snapshot.includedFiles) {
    if (!file || typeof file.path !== 'string' || !isSafeRelativePath(file.path)) {
      fail('snapshot contains an unsafe path');
      continue;
    }
    if (paths.has(file.path)) fail(`duplicate snapshot path: ${file.path}`);
    paths.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      fail(`snapshot file digest is invalid: ${file.path}`);
      continue;
    }
    const target = path.join(repositoryRoot, file.path);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      const bytes = fs.readFileSync(target);
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) fail(`snapshot file is stale: ${file.path}`);
    } catch (error) {
      fail(`snapshot file is unavailable: ${file.path} (${error.message})`);
    }
  }
  validateGitScope(repositoryRoot, snapshot, paths, fail);
  validateCoveredScope(repositoryRoot, snapshot, paths, fail);
  if (!Array.isArray(snapshot.excludedFromDigest) || snapshot.excludedFromDigest.length === 0) fail('snapshot exclusions are required');
  if (JSON.stringify([...snapshot.excludedFromDigest].sort()) !== JSON.stringify([RECORD_PATH, SNAPSHOT_PATH, CLEAN_IDENTITY_PATH].sort())) fail('snapshot exclusions are not verifier-owned');
  if (paths.has(RECORD_PATH) || paths.has(SNAPSHOT_PATH)) fail('snapshot is self-referential');
}

function validateGitScope(repositoryRoot, snapshot, listedPaths, fail) {
  const scope = snapshot?.gitScope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    fail('snapshot gitScope is required');
    return;
  }
  if (scope.schemaVersion !== 1 || scope.pathSource !== 'git-ls-tree') fail('snapshot gitScope schema is invalid');
  const safeList = (value, label) => {
    if (!Array.isArray(value) || new Set(value).size !== value.length || value.some((entry) => typeof entry !== 'string' || !isSafeRelativePath(entry))) {
      fail(`${label} is invalid`);
      return [];
    }
    return [...value].sort();
  };
  const generated = new Set(GENERATED_EVIDENCE_PATHS);
  const expectedTracked = gitTrackedPathUniverse(repositoryRoot, snapshot.baseImplementationHead).filter((entry) => !generated.has(entry)).sort();
  const tracked = safeList(scope.trackedPaths, 'snapshot gitScope trackedPaths');
  if (JSON.stringify(tracked) !== JSON.stringify(expectedTracked)) fail('snapshot gitScope tracked path universe is incomplete or stale');
  const expectedClassified = gitTrackedPathUniverse(repositoryRoot, snapshot.baseImplementationHead)
    .filter((entry) => generated.has(entry))
    .map((entry) => ({ path: entry, classification: 'generated-evidence' }));
  if (JSON.stringify(scope.classifiedTrackedPaths) !== JSON.stringify(expectedClassified)) fail('snapshot gitScope tracked classification is invalid');
  if (JSON.stringify(scope.privateUntrackedPrefixes) !== JSON.stringify([...PRIVATE_UNTRACKED_PREFIXES])) fail('snapshot gitScope private untracked rules are invalid');
  const overlays = new Set(safeList(scope.overlayPaths, 'snapshot gitScope overlayPaths'));
  const generatedUntracked = new Set(safeList(scope.generatedUntrackedPaths, 'snapshot gitScope generatedUntrackedPaths'));
  const actualOverlays = [];
  const actualGenerated = [];
  const raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repositoryRoot, encoding: 'buffer' });
  for (const relativePath of raw.toString('utf8').split('\0').filter(Boolean)) {
    if (generated.has(relativePath)) actualGenerated.push(relativePath);
    else if (PRIVATE_UNTRACKED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) continue;
    else if (AUTHORITATIVE_COVERED_PATHS.some((covered) => relativePath === covered || relativePath.startsWith(`${covered}/`))) actualOverlays.push(relativePath);
    else fail(`snapshot gitScope contains an unclassified untracked path: ${relativePath}`);
  }
  if (JSON.stringify(actualOverlays.sort()) !== JSON.stringify([...overlays].sort())) fail('snapshot gitScope overlay paths are stale');
  if (JSON.stringify(actualGenerated.sort()) !== JSON.stringify([...generatedUntracked].sort())) fail('snapshot gitScope generated paths are stale');
  for (const relativePath of [...tracked, ...actualOverlays]) if (!listedPaths.has(relativePath)) fail(`snapshot gitScope path is missing from includedFiles: ${relativePath}`);
}

function validateCoveredScope(repositoryRoot, snapshot, listedPaths, fail) {
  if (!Array.isArray(snapshot?.coveredPaths) || snapshot.coveredPaths.length === 0) {
    fail('snapshot coveredPaths are required');
    return;
  }
  const discovered = new Set();
  const excluded = new Set(snapshot.excludedFromDigest || []);
  const walk = (relativePath) => {
    const target = path.join(repositoryRoot, relativePath);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      fail(`snapshot covered path is unavailable: ${relativePath} (${error.message})`);
      return;
    }
    if (stat.isSymbolicLink()) {
      fail(`snapshot covered path contains a symlink: ${relativePath}`);
      return;
    }
    if (stat.isFile()) {
      if (!excluded.has(relativePath)) discovered.add(relativePath);
      return;
    }
    if (!stat.isDirectory()) {
      fail(`snapshot covered path is not a regular file or directory: ${relativePath}`);
      return;
    }
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      walk(path.posix.join(relativePath, entry.name));
    }
  };
  const declaredRoots = new Set();
  const roots = new Set();
  const scopeRoots = [
    ...snapshot.coveredPaths,
    ...(snapshot.gitScope?.trackedPaths || []).filter((relativePath) => !snapshot.coveredPaths.some((coveredPath) => relativePath === coveredPath || relativePath.startsWith(`${coveredPath}/`)))
  ];
  for (const relativePath of scopeRoots) {
    const isDeclaredRoot = snapshot.coveredPaths.includes(relativePath);
    if (typeof relativePath !== 'string' || !isSafeRelativePath(relativePath) || (isDeclaredRoot && declaredRoots.has(relativePath)) || (!isDeclaredRoot && roots.has(relativePath))) {
      fail(`snapshot covered path is invalid or duplicated: ${relativePath}`);
      continue;
    }
    if (isDeclaredRoot) declaredRoots.add(relativePath);
    roots.add(relativePath);
    walk(relativePath);
  }
  if (JSON.stringify([...declaredRoots].sort()) !== JSON.stringify([...AUTHORITATIVE_COVERED_PATHS].sort())) fail('snapshot coveredPaths are not verifier-owned');
  const listed = [...listedPaths].sort();
  const actual = [...discovered].sort();
  if (JSON.stringify(actual) !== JSON.stringify(listed)) fail('snapshot covered scope does not exactly match includedFiles');
}

function validateEvidenceArtifacts(repositoryRoot, record, fail) {
  if (!Array.isArray(record?.evidenceArtifacts) || record.evidenceArtifacts.length === 0) {
    fail('evidenceArtifacts are required');
    return;
  }
  const paths = new Set();
  for (const artifact of record.evidenceArtifacts) {
    if (!artifact || typeof artifact.path !== 'string' || !isSafeRelativePath(artifact.path) || paths.has(artifact.path)) {
      fail('evidence artifact path is invalid or duplicated');
      continue;
    }
    paths.add(artifact.path);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      fail(`evidence artifact digest is invalid: ${artifact.path}`);
      continue;
    }
    try {
      const target = path.join(repositoryRoot, artifact.path);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      const bytes = fs.readFileSync(target);
      if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) fail(`evidence artifact is stale: ${artifact.path}`);
    } catch (error) {
      fail(`evidence artifact is unavailable: ${artifact.path} (${error.message})`);
    }
  }
}

function validateEvidenceRecord(evidence, { expectedRevision, collectionDate, repositoryRoot, fail }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('each evidence record must be an object');
    return;
  }
  for (const field of REQUIRED_RECORD_FIELDS) if (!Object.hasOwn(evidence, field)) fail(`${evidence.recordId ?? 'unknown'} missing required field ${field}`);
  for (const field of ['recordId', 'runtimeProduct', 'runtimeVersion', 'osVersion', 'adapterVersion', 'operation', 'capabilityProfile', 'evidenceRevision', 'limitation']) {
    if (typeof evidence[field] !== 'string' || !evidence[field].trim()) fail(`${evidence.recordId ?? 'unknown'} field ${field} must be non-empty`);
  }
  if (evidence.evidenceRevision !== expectedRevision) fail(`${evidence.recordId ?? 'unknown'} evidence revision is stale`);
  if (evidence.collectionDate !== collectionDate || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.collectionDate ?? '')) fail(`${evidence.recordId ?? 'unknown'} collection date is invalid`);
  if (!EXPECTED_EVIDENCE_KINDS.has(evidence.evidenceKind)) fail(`${evidence.recordId ?? 'unknown'} evidence kind is invalid`);
  validateResult(evidence.expectedResult, `${evidence.recordId ?? 'unknown'} expectedResult`, fail, { allowClaimFields: false });
  validateResult(evidence.observedResult, `${evidence.recordId ?? 'unknown'} observedResult`, fail, { allowClaimFields: true });
  if (evidence.observedResult?.claimLevel !== evidence.evidenceKind) fail(`${evidence.recordId ?? 'unknown'} claim level does not match evidence kind`);
  const runtimeEvidence = evidence.evidenceKind === 'actual-runtime-loading' || evidence.evidenceKind === 'live-model-evaluation';
  if (evidence.observedResult?.runtimeObserved !== true && evidence.observedResult?.runtimeObserved !== false) fail(`${evidence.recordId ?? 'unknown'} runtimeObserved must be boolean`);
  if (!runtimeEvidence && evidence.observedResult?.runtimeObserved === true) fail(`${evidence.recordId ?? 'unknown'} fixture/source evidence was promoted to runtime evidence`);
  if (runtimeEvidence && evidence.observedResult?.status === 'PASS' && evidence.observedResult?.runtimeObserved !== true) fail(`${evidence.recordId ?? 'unknown'} actual runtime PASS lacks runtime observation`);
  if (runtimeEvidence && evidence.observedResult?.status === 'PASS') {
    validateActualRuntimePass(evidence, fail);
  }
  for (const field of ['runtimeVersion', 'osVersion', 'adapterVersion']) {
    const value = evidence[field];
    if (/^(UNKNOWN|N\/A)(?:\s|$)/.test(value)) {
      const reasonField = value.startsWith('N/A') ? 'notApplicableReason' : 'unknownReason';
      if (typeof evidence[reasonField] !== 'string' || !evidence[reasonField].trim()) fail(`${evidence.recordId ?? 'unknown'} ${field} requires ${reasonField}`);
    }
  }
  if (!Array.isArray(evidence.evidenceLocation) || evidence.evidenceLocation.length === 0) {
    fail(`${evidence.recordId ?? 'unknown'} evidenceLocation is required`);
  } else {
    if (evidence.operation.startsWith('mcp:')) {
      const testLocations = evidence.evidenceLocation.filter((location) => location?.locator?.startsWith('test: '));
      if (testLocations.length !== 1) fail(`${evidence.recordId ?? 'unknown'} MCP evidence requires exactly one operation-bound test locator`);
    }
    for (const location of evidence.evidenceLocation) {
      if (!location || typeof location.path !== 'string' || !isSafeRelativePath(location.path) || typeof location.locator !== 'string' || !location.locator.trim()) {
        fail(`${evidence.recordId ?? 'unknown'} evidenceLocation is invalid`);
        continue;
      }
      try {
        const stat = fs.lstatSync(path.join(repositoryRoot, location.path));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
        validateEvidenceLocator(repositoryRoot, evidence, location, fail);
      } catch (error) {
        fail(`${evidence.recordId ?? 'unknown'} evidenceLocation is unavailable: ${location.path} (${error.message})`);
      }
    }
  }
}

function validateEvidenceLocator(repositoryRoot, evidence, location, fail) {
  const locator = location.locator;
  const filePath = path.join(repositoryRoot, location.path);
  const text = fs.readFileSync(filePath, 'utf8');
  if (locator.startsWith('test: ')) {
    const title = locator.slice('test: '.length);
    if (!extractTestNames(text).includes(title)) fail(`${evidence.recordId} evidence test locator does not exist: ${title}`);
    if (evidence.operation.startsWith('mcp:')) {
      const operation = evidence.operation.slice('mcp:'.length);
      if (location.path !== MCP_TEST_PATH) fail(`${evidence.recordId} MCP test evidence must use ${MCP_TEST_PATH}`);
      if (!MCP_OPERATION_TESTS[operation]?.includes(title)) fail(`${evidence.recordId} test locator does not support operation: ${operation}`);
    }
    return;
  }
  if (locator.startsWith('tool: ')) {
    const tool = locator.slice('tool: '.length);
    if (evidence.operation !== `mcp:${tool}`) fail(`${evidence.recordId} evidence locator does not match operation: ${tool}`);
    if (!new RegExp(`^\\d+\\. ${escapeRegExp(tool)}$`, 'm').test(text)) fail(`${evidence.recordId} evidence tool locator does not exist: ${tool}`);
    return;
  }
  if (locator.startsWith('heading: ')) {
    const heading = locator.slice('heading: '.length);
    if (!new RegExp(`^#+ ${escapeRegExp(heading)}$`, 'm').test(text)) fail(`${evidence.recordId} evidence heading locator does not exist: ${heading}`);
    return;
  }
  if (locator.startsWith('json: ')) {
    const pointer = locator.slice('json: '.length);
    let value;
    try {
      value = JSON.parse(text);
      const normalizedPointer = pointer.startsWith('$.') ? pointer.slice(2) : pointer.startsWith('$') ? pointer.slice(1) : pointer;
      for (const part of normalizedPointer.split('.').filter(Boolean)) value = value[part];
    } catch {
      value = undefined;
    }
    if (value === undefined) fail(`${evidence.recordId} evidence JSON locator does not exist: ${pointer}`);
    return;
  }
  if (locator.startsWith('text: ')) {
    const literal = locator.slice('text: '.length);
    if (!text.includes(literal)) fail(`${evidence.recordId} evidence text locator does not exist: ${literal}`);
    return;
  }
  if (locator.startsWith('file: ')) {
    const expectedName = locator.slice('file: '.length);
    if (path.basename(location.path) !== expectedName) fail(`${evidence.recordId} evidence file locator does not match: ${expectedName}`);
    return;
  }
  fail(`${evidence.recordId} evidence locator scheme is unsupported: ${locator}`);
}

function validateActualRuntimePass(evidence, fail) {
  const label = evidence.recordId ?? 'unknown';
  if (evidence.observedResult.runtimeObserved !== true) fail(`${label} actual runtime PASS lacks runtime observation`);
  const observation = evidence.observedResult.actualObservation;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    fail(`${label} actual runtime PASS lacks independently addressable observation evidence`);
    return;
  }
  for (const field of ['productVersion', 'observedAt', 'observationId']) {
    if (typeof observation[field] !== 'string' || observation[field].trim() !== observation[field] || !observation[field].trim() || /^(UNKNOWN|N\/A)$/i.test(observation[field])) {
      fail(`${label} actual runtime PASS requires concrete observation ${field}`);
    }
  }
  if (typeof evidence.runtimeVersion !== 'string' || evidence.runtimeVersion.trim() !== evidence.runtimeVersion || !evidence.runtimeVersion.trim() || /^(UNKNOWN|N\/A)$/i.test(evidence.runtimeVersion)) {
    fail(`${label} actual runtime PASS requires concrete runtimeVersion`);
  }
  if (typeof evidence.osVersion !== 'string' || evidence.osVersion.trim() !== evidence.osVersion || !evidence.osVersion.trim() || /^(UNKNOWN|N\/A)$/i.test(evidence.osVersion)) {
    fail(`${label} actual runtime PASS requires concrete osVersion`);
  }
  if (typeof observation.productVersion === 'string' && observation.productVersion.trim() && observation.productVersion !== evidence.runtimeVersion) {
    fail(`${label} actual runtime observation productVersion does not match runtimeVersion`);
  }
  if (typeof observation.observedAt === 'string' && observation.observedAt.trim() && !isValidObservationTimestamp(observation.observedAt)) {
    fail(`${label} actual runtime PASS requires a valid observedAt timestamp`);
  }
  if (!Array.isArray(observation.evidenceLocation) || observation.evidenceLocation.length === 0) {
    fail(`${label} actual runtime PASS requires resolvable observation evidence`);
  }
  fail(`${label} actual runtime PASS is unsupported until an authorized, resolvable observation is available`);
}

function isValidObservationTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateResult(value, label, fail, { allowClaimFields }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !RESULT_STATUSES.has(value.status) || typeof value.summary !== 'string' || !value.summary.trim()) {
    fail(`${label} must contain a status and summary`);
    return;
  }
  if (allowClaimFields && (typeof value.claimLevel !== 'string' || typeof value.runtimeObserved !== 'boolean')) fail(`${label} must contain claimLevel and runtimeObserved`);
  if (!allowClaimFields && (Object.hasOwn(value, 'claimLevel') || Object.hasOwn(value, 'runtimeObserved'))) fail(`${label} must remain separate from observed evidence`);
}

function assertExactSet(actual, expected, label, fail) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) fail(`${label} does not exactly match the source catalog`);
}

function extractTestNames(text) {
  return [
    ...text.matchAll(/^\s*test\(\s*'([^']+)'/gm),
    ...text.matchAll(/^\s*test\(\s*"([^"]+)"/gm),
    ...text.matchAll(/^\s*test\(\s*`([^`]+)`/gm)
  ].map((match) => match[1]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRunbookTools(text) {
  return [...text.matchAll(/^\d+\. (linmas_\w+)$/gm)].map((match) => match[1]);
}

function assertRunbookInventory(text, expectedTools) {
  assert.deepEqual(extractRunbookTools(text).sort(), [...expectedTools].sort());
}

function assertWindowsEvidenceBoundary(record) {
  const evidence = record.records.find((item) => item.operation === 'windows:destructive-uninstall');
  assert.ok(evidence, 'Windows destructive-uninstall evidence must exist');
  assert.equal(evidence.expectedResult.status, 'UNSUPPORTED');
  assert.equal(evidence.observedResult.status, 'UNSUPPORTED');
  assert.match(evidence.observedResult.summary, /SAFE_FILESYSTEM_OPERATION_UNAVAILABLE/);
}

function isSafeRelativePath(value) {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..');
}

function gitHead(repositoryRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

function gitRef(repositoryRoot, reference) {
  return execFileSync('git', ['rev-parse', reference], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

test('compatibility evidence covers the exact canonical skill and MCP inventories', () => {
  const record = readJson(RECORD_PATH);
  const snapshot = readJson(SNAPSHOT_PATH);
  assert.doesNotThrow(() => validateCompatibilityEvidence({ record, snapshot }));
  assert.deepEqual(record.inventory.skills.sort(), [...PUBLIC_SKILL_IDS].sort());
  assert.deepEqual(record.inventory.mcpTools.sort(), listTools().map((tool) => tool.name).sort());
  const runbook = read('docs/linmas-mcp-validation-runbook.md');
  assertRunbookInventory(runbook, record.inventory.mcpTools);
});

test('each MCP operation uses an operation-bound semantic testcase', () => {
  const record = readJson(RECORD_PATH);
  const snapshot = readJson(SNAPSHOT_PATH);
  const expectedTests = new Map([
    ['linmas_review_prepare', 'offline prepare is read-only and returns prepared plus human-review state'],
    ['linmas_review_compare', 'offline compare, policy evaluate, and proof verify return verified bounded results'],
    ['linmas_policy_evaluate', 'offline compare, policy evaluate, and proof verify return verified bounded results'],
    ['linmas_proof_verify', 'offline compare, policy evaluate, and proof verify return verified bounded results'],
    ['linmas_proof_create', 'proof create requires explicit write confirmation and verifies its own result'],
    ['linmas_review_execute', 'review execute is prepared without consent and only executes a mocked provider after consent'],
    ['linmas_review_decide', 'F-006 decision gate rejects tampered review references and uses immutable severity']
  ]);
  for (const [tool, title] of expectedTests) {
    const evidence = record.records.find((item) => item.operation === `mcp:${tool}`);
    assert.ok(evidence, `missing evidence for ${tool}`);
    const testLocations = evidence.evidenceLocation.filter((location) => location.locator?.startsWith('test: '));
    assert.deepEqual(testLocations, [{ path: MCP_TEST_PATH, locator: `test: ${title}` }]);
  }
  assert.doesNotThrow(() => validateCompatibilityEvidence({ record, snapshot }));
});

test('candidate compatibility evidence is revision-bound and semantically complete', () => {
  const record = readJson(RECORD_PATH);
  const snapshot = readJson(SNAPSHOT_PATH);
  for (const evidence of record.records) {
    assert.ok(evidence.expectedResult, evidence.recordId);
    assert.ok(evidence.observedResult, evidence.recordId);
    assert.notDeepEqual(evidence.expectedResult, evidence.observedResult, evidence.recordId);
  }
  assert.equal(record.candidate.sourceRevision, `HEAD ${record.candidate.implementationHead} + dirty snapshot sha256:${snapshot.snapshotDigest}`);
  assert.equal(snapshot.snapshotDigest, computeSnapshotDigest(snapshot));
  assert.equal(record.records.find((evidence) => evidence.operation === 'host-loading:codex').observedResult.status, 'UNKNOWN');
  assert.equal(record.records.find((evidence) => evidence.operation === 'live-evaluation:codex').observedResult.status, 'UNKNOWN');
});

test('compatibility evidence rejects missing fields, duplicate inventory, stale revisions, and fixture promotion', () => {
  const record = readJson(RECORD_PATH);
  const snapshot = readJson(SNAPSHOT_PATH);
  const sourcePath = path.join(REPOSITORY_ROOT, 'src/core/skill-catalog.mjs');
  const sourceBefore = fs.readFileSync(sourcePath, 'utf8');

  const missingField = structuredClone(record);
  delete missingField.records[0].expectedResult;
  assert.throws(() => validateCompatibilityEvidence({ record: missingField, snapshot }), /missing required field expectedResult/);

  const duplicateInventory = structuredClone(record);
  duplicateInventory.inventory.skills.pop();
  assert.throws(() => validateCompatibilityEvidence({ record: duplicateInventory, snapshot }), /skill inventory does not exactly match/);

  const repeatedInventory = structuredClone(record);
  repeatedInventory.inventory.mcpTools.push(repeatedInventory.inventory.mcpTools[0]);
  assert.throws(() => validateCompatibilityEvidence({ record: repeatedInventory, snapshot }), /MCP tool inventory does not exactly match/);

  const staleRevision = structuredClone(record);
  staleRevision.records[0].evidenceRevision = 'HEAD 0000000000000000000000000000000000000000 + dirty snapshot sha256:0000000000000000000000000000000000000000000000000000000000000000';
  assert.throws(() => validateCompatibilityEvidence({ record: staleRevision, snapshot }), /evidence revision is stale/);

  const staleSnapshot = structuredClone(snapshot);
  staleSnapshot.includedFiles[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateCompatibilityEvidence({ record, snapshot: staleSnapshot }), /snapshot digest is stale|snapshot file is stale/);

  const mismatchedClaim = structuredClone(record);
  mismatchedClaim.records[0].observedResult.claimLevel = mismatchedClaim.records[0].evidenceKind === 'source-inspection'
    ? 'deterministic-fixture' : 'source-inspection';
  assert.throws(() => validateCompatibilityEvidence({ record: mismatchedClaim, snapshot }), /claim level does not match evidence kind/);

  const promotedFixture = structuredClone(record);
  const fixture = promotedFixture.records.find((evidence) => evidence.evidenceKind === 'deterministic-fixture');
  fixture.evidenceKind = 'actual-runtime-loading';
  fixture.observedResult.claimLevel = 'actual-runtime-loading';
  fixture.observedResult.status = 'PASS';
  assert.throws(() => validateCompatibilityEvidence({ record: promotedFixture, snapshot }), /actual runtime PASS lacks runtime observation/);

  const booleanOnlyRuntime = structuredClone(record);
  const runtimeFixture = booleanOnlyRuntime.records.find((evidence) => evidence.evidenceKind === 'deterministic-fixture');
  runtimeFixture.evidenceKind = 'actual-runtime-loading';
  runtimeFixture.observedResult.claimLevel = 'actual-runtime-loading';
  runtimeFixture.observedResult.status = 'PASS';
  runtimeFixture.observedResult.runtimeObserved = true;
  assert.throws(() => validateCompatibilityEvidence({ record: booleanOnlyRuntime, snapshot }), /independently addressable observation evidence/);

  const emptyHostRuntime = structuredClone(record);
  const hostRuntime = emptyHostRuntime.records.find((evidence) => evidence.operation === 'host-loading:codex');
  hostRuntime.observedResult.status = 'PASS';
  hostRuntime.observedResult.runtimeObserved = true;
  hostRuntime.observedResult.actualObservation = { productVersion: '', observedAt: '', observationId: '' };
  assert.throws(() => validateCompatibilityEvidence({ record: emptyHostRuntime, snapshot }), /requires concrete runtimeVersion|requires concrete observation/);

  const invalidObservation = structuredClone(record);
  const invalidHost = invalidObservation.records.find((evidence) => evidence.operation === 'host-loading:codex');
  invalidHost.runtimeVersion = 'Codex Desktop 1.0';
  invalidHost.osVersion = 'Fedora Linux 44';
  invalidHost.observedResult.status = 'PASS';
  invalidHost.observedResult.runtimeObserved = true;
  invalidHost.observedResult.actualObservation = {
    productVersion: 'Other Product 1.0',
    observedAt: 'not-a-date',
    observationId: 'observation-001',
    evidenceLocation: [{ path: 'docs/compatibility/COMPATIBILITY.md', locator: 'heading: Runtime matrix' }]
  };
  assert.throws(() => validateCompatibilityEvidence({ record: invalidObservation, snapshot }), /does not match runtimeVersion|valid observedAt/);

  const otherwiseValidRuntime = structuredClone(record);
  const validHost = otherwiseValidRuntime.records.find((evidence) => evidence.operation === 'host-loading:codex');
  validHost.runtimeVersion = 'Codex Desktop 1.0';
  validHost.osVersion = 'Fedora Linux 44';
  validHost.observedResult.status = 'PASS';
  validHost.observedResult.runtimeObserved = true;
  validHost.observedResult.actualObservation = {
    productVersion: 'Codex Desktop 1.0',
    observedAt: '2026-09-08T00:00:00.000Z',
    observationId: 'observation-001',
    evidenceLocation: [{ path: 'docs/compatibility/COMPATIBILITY.md', locator: 'heading: Runtime matrix' }]
  };
  assert.throws(() => validateCompatibilityEvidence({ record: otherwiseValidRuntime, snapshot }), /actual runtime PASS is unsupported/);

  assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBefore);
});

test('compatibility evidence rejects stale metadata, invalid Git identity, and unresolvable references', () => {
  const record = readJson(RECORD_PATH);
  const snapshot = readJson(SNAPSHOT_PATH);

  const wrongPackage = structuredClone(record);
  wrongPackage.candidate.packageVersion = '9.9.9';
  assert.throws(() => validateCompatibilityEvidence({ record: wrongPackage, snapshot }), /package version does not match/);

  const wrongPlugin = structuredClone(record);
  wrongPlugin.candidate.pluginVersion = '9.9.9';
  assert.throws(() => validateCompatibilityEvidence({ record: wrongPlugin, snapshot }), /plugin version does not match/);

  const wrongTagObject = structuredClone(record);
  wrongTagObject.candidate.baseline.tagObject = '0'.repeat(40);
  assert.throws(() => validateCompatibilityEvidence({ record: wrongTagObject, snapshot }), /baseline tag object/);

  const wrongPeeledCommit = structuredClone(record);
  wrongPeeledCommit.candidate.baseline.peeledCommit = '0'.repeat(40);
  assert.throws(() => validateCompatibilityEvidence({ record: wrongPeeledCommit, snapshot }), /baseline peeled commit/);

  const missingReference = structuredClone(record);
  missingReference.records.find((evidence) => evidence.operation === 'mcp:linmas_review_decide').evidenceLocation[0].locator = 'test: missing MCP case';
  assert.throws(() => validateCompatibilityEvidence({ record: missingReference, snapshot }), /evidence test locator does not exist/);

  const wrongOperationReference = structuredClone(record);
  wrongOperationReference.records.find((evidence) => evidence.operation === 'mcp:linmas_review_decide').evidenceLocation[1].locator = 'tool: linmas_review_prepare';
  assert.throws(() => validateCompatibilityEvidence({ record: wrongOperationReference, snapshot }), /locator does not match operation/);

  const unrelatedTestReference = structuredClone(record);
  unrelatedTestReference.records.find((evidence) => evidence.operation === 'mcp:linmas_review_decide').evidenceLocation[0].locator = 'test: offline prepare is read-only and returns prepared plus human-review state';
  assert.throws(() => validateCompatibilityEvidence({ record: unrelatedTestReference, snapshot }), /test locator does not support operation/);

  const genericTestReference = structuredClone(record);
  genericTestReference.records.find((evidence) => evidence.operation === 'mcp:linmas_review_decide').evidenceLocation[0].locator = 'file: mcp-server.test.mjs';
  assert.throws(() => validateCompatibilityEvidence({ record: genericTestReference, snapshot }), /requires exactly one operation-bound test locator/);

  const staleDependency = structuredClone(snapshot);
  const dependency = staleDependency.includedFiles.find((entry) => entry.path === 'tests/claude-provider.test.mjs');
  assert.ok(dependency, 'expanded snapshot must include Claude provider tests');
  dependency.sha256 = '0'.repeat(64);
  staleDependency.snapshotDigest = computeSnapshotDigest(staleDependency);
  const staleDependencyRecord = structuredClone(record);
  staleDependencyRecord.candidate.snapshot.digest = staleDependency.snapshotDigest;
  staleDependencyRecord.candidate.sourceRevision = `HEAD ${staleDependencyRecord.candidate.implementationHead} + dirty snapshot sha256:${staleDependency.snapshotDigest}`;
  for (const evidence of staleDependencyRecord.records) evidence.evidenceRevision = staleDependencyRecord.candidate.sourceRevision;
  assert.throws(() => validateCompatibilityEvidence({ record: staleDependencyRecord, snapshot: staleDependency }), /snapshot file is stale/);
});

test('v0.9 compatibility documentation links resolve from their actual Markdown locations', () => {
  const fixtureRoot = fixture().root;
  for (const relativePath of [
    'docs/implementation/v0.9.0.md',
    'docs/compatibility/COMPATIBILITY.md',
    'docs/linmas-mcp-validation-runbook.md'
  ]) {
    const text = fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8');
    for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
      const target = decodeURIComponent(match[1].split('#')[0]);
      assert.equal(fs.existsSync(path.resolve(fixtureRoot, path.dirname(relativePath), target)), true, `missing local link from ${relativePath}: ${target}`);
    }
  }
});

test('each v0.9 roadmap outcome has a positive case and an applicable invalid case', () => {
  const record = readJson(RECORD_PATH);
  const snapshot = readJson(SNAPSHOT_PATH);
  const tools = listTools().map((tool) => tool.name);
  const runbook = read('docs/linmas-mcp-validation-runbook.md');

  // Outcome 1: provenance is valid, but a candidate bound to another HEAD is rejected.
  assert.doesNotThrow(() => validateCompatibilityEvidence({ record, snapshot }));
  const staleHead = structuredClone(record);
  staleHead.candidate.implementationHead = '0'.repeat(40);
  assert.throws(() => validateCompatibilityEvidence({ record: staleHead, snapshot }), /implementation HEAD does not match current HEAD/);

  // Outcome 2: complete evidence is valid, but a missing required field is rejected.
  assert.ok(record.records.every((evidence) => evidence.expectedResult && evidence.observedResult));
  const missingObserved = structuredClone(record);
  delete missingObserved.records[0].observedResult;
  assert.throws(() => validateCompatibilityEvidence({ record: missingObserved, snapshot }), /missing required field observedResult/);

  // Outcome 3: the source catalog and runbook contain the exact inventories.
  assert.deepEqual(record.inventory.skills.sort(), [...PUBLIC_SKILL_IDS].sort());
  assertRunbookInventory(runbook, tools);
  const missingTool = runbook.replace(/^7\. linmas_review_decide$/m, '7. linmas_review_missing');
  assert.throws(() => assertRunbookInventory(missingTool, tools));

  // Outcome 4: the Windows destructive boundary remains a deliberate denial.
  assertWindowsEvidenceBoundary(record);
  const enabledWindows = structuredClone(record);
  enabledWindows.records.find((evidence) => evidence.operation === 'windows:destructive-uninstall').observedResult.status = 'PASS';
  assert.throws(() => assertWindowsEvidenceBoundary(enabledWindows), /UNSUPPORTED/);

  // Outcome 5: documentation names all seven tools, and a drifted list is rejected.
  assert.equal(extractRunbookTools(runbook).length, 7);
  const duplicateTool = runbook.replace(/^7\. linmas_review_decide$/m, '7. linmas_review_prepare');
  assert.throws(() => assertRunbookInventory(duplicateTool, tools));
});

test('candidate compatibility evidence retains platform and actual-runtime limitations', () => {
  const record = readJson(RECORD_PATH);
  const text = read('docs/compatibility/COMPATIBILITY.md');
  assert.equal(record.records.find((evidence) => evidence.operation === 'windows:destructive-uninstall').observedResult.status, 'UNSUPPORTED');
  assert.equal(record.records.find((evidence) => evidence.operation === 'host-loading:codex').observedResult.status, 'UNKNOWN');
  assert.equal(record.records.find((evidence) => evidence.operation === 'host-loading:claude-code').observedResult.status, 'UNKNOWN');
  assert.equal(record.records.find((evidence) => evidence.operation === 'format-loading:hermes').observedResult.status, 'UNKNOWN');
  assert.match(text, /SAFE_FILESYSTEM_OPERATION_UNAVAILABLE/);
  assert.match(text, /machine-readable|revision-bound/i);
  assertWindowsEvidenceBoundary(record);
});
