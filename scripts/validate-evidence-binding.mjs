#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureReleaseArtifacts } from './artifact-integrity.mjs';
import { assertTrustedGitAvailable, createExplicitChildEnvironment } from './child-environment.mjs';
import {
  collectFreshEvidence,
  computeArtifactBindingDigest,
  EVIDENCE_PRODUCER_EXECUTION,
  formatHistoricalSummary,
  formatObservedSummary,
  getEvidenceContract,
  validateOperationLocations,
  validateOperationResult
} from './evidence-operations.mjs';

export const CLEAN_IDENTITY_PATH = 'compatibility/evidence/v0.9.0-content-identity.json';
export const HISTORICAL_RECORD_PATH = 'docs/compatibility/evidence/v0.9.0-record.json';
export const HISTORICAL_SNAPSHOT_PATH = 'docs/compatibility/evidence/v0.9.0-snapshot.json';
export const HISTORICAL_EXCLUDED_PATHS = Object.freeze([HISTORICAL_RECORD_PATH, HISTORICAL_SNAPSHOT_PATH, CLEAN_IDENTITY_PATH]);
export const AUTHORITATIVE_COVERED_PATHS = Object.freeze([
  '.agents/plugins/marketplace.json',
  '.mcp.json',
  'OPENAI_BUILD_WEEK_2026.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'TRADEMARK.md',
  'USAGE.md',
  'PANDUAN-PENGGUNAAN.md',
  'assets',
  'bin',
  'docs',
  '.github',
  'evaluations',
  'examples',
  'mcp',
  'package-lock.json',
  'package.json',
  'plugin',
  'plugins/linmas',
  'policies',
  'releases/0.9.0.md',
  'scripts',
  'skills',
  'src',
  'tests'
]);
export const DEFAULT_COVERED_PATHS = AUTHORITATIVE_COVERED_PATHS;
export const PRIVATE_UNTRACKED_PREFIXES = Object.freeze(['.local-agent/']);
export const GENERATED_EVIDENCE_PATHS = Object.freeze([
  HISTORICAL_RECORD_PATH,
  HISTORICAL_SNAPSHOT_PATH,
  CLEAN_IDENTITY_PATH
]);
export const EVIDENCE_CLASS = 'source-and-deterministic-fixture-v1';

export const REQUIRED_EVIDENCE_RECORDS = Object.freeze({
  'R090-PROVENANCE': Object.freeze({ operation: 'baseline:provenance', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-PACKAGE-001': Object.freeze({ operation: 'package:inventory', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-PLUGIN-001': Object.freeze({ operation: 'plugin:canonical-parity', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-PROVIDER-CLAUDE': Object.freeze({ operation: 'provider-fixture:claude-api', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-WINDOWS-001': Object.freeze({ operation: 'windows:destructive-uninstall', evidenceKind: 'deterministic-fixture', status: 'UNSUPPORTED' }),
  'R090-MCP-01': Object.freeze({ operation: 'mcp:linmas_review_prepare', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-MCP-02': Object.freeze({ operation: 'mcp:linmas_review_compare', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-MCP-03': Object.freeze({ operation: 'mcp:linmas_policy_evaluate', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-MCP-04': Object.freeze({ operation: 'mcp:linmas_proof_verify', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-MCP-05': Object.freeze({ operation: 'mcp:linmas_proof_create', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-MCP-06': Object.freeze({ operation: 'mcp:linmas_review_execute', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-MCP-07': Object.freeze({ operation: 'mcp:linmas_review_decide', evidenceKind: 'deterministic-fixture', status: 'PASS' }),
  'R090-SKILL-01': Object.freeze({ operation: 'skill:linmas-security-operations-lead:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-02': Object.freeze({ operation: 'skill:linmas-smart-contract-reviewer:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-03': Object.freeze({ operation: 'skill:linmas-exploit-validation-specialist:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-04': Object.freeze({ operation: 'skill:linmas-threat-research-analyst:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-05': Object.freeze({ operation: 'skill:linmas-detection-rules-engineer:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-06': Object.freeze({ operation: 'skill:linmas-incident-triage-lead:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-07': Object.freeze({ operation: 'skill:linmas-controls-compliance-reviewer:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-08': Object.freeze({ operation: 'skill:linmas-cloud-hardening-architect:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-09': Object.freeze({ operation: 'skill:linmas-secure-systems-architect:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-10': Object.freeze({ operation: 'skill:linmas-secure-code-reviewer:catalog', evidenceKind: 'source-inspection', status: 'PASS' }),
  'R090-SKILL-11': Object.freeze({ operation: 'skill:linmas-security-domain-router:catalog', evidenceKind: 'source-inspection', status: 'PASS' })
});
export const REQUIRED_EVIDENCE_RECORD_IDS = Object.freeze(Object.keys(REQUIRED_EVIDENCE_RECORDS).sort());
export const REQUIRED_EVIDENCE_OPERATIONS = Object.freeze(Object.values(REQUIRED_EVIDENCE_RECORDS).map((entry) => entry.operation).sort());

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function isSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || /[\u0000-\u001f\u007f]/u.test(relativePath)) return false;
  if (path.posix.isAbsolute(relativePath)) return false;
  const segments = relativePath.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function assertSafeRelativePath(relativePath, label) {
  if (!isSafeRelativePath(relativePath)) throw new Error(`${label} contains an unsafe path: ${relativePath}`);
}

function resolveInside(rootDir, relativePath) {
  assertSafeRelativePath(relativePath, 'path');
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...relativePath.split('/'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes repository root: ${relativePath}`);
  return target;
}

function readActualFileDigest(repositoryRoot, relativePath, label = 'tracked file') {
  const target = resolveInside(repositoryRoot, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${relativePath} (${error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${relativePath}`);
  const bytes = fs.readFileSync(target);
  return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export function gitTrackedPathUniverse(repositoryRoot, revision = gitHead(repositoryRoot)) {
  if (typeof revision !== 'string' || !COMMIT_SHA.test(revision)) throw new Error('authorized Git revision must be a full lowercase commit SHA');
  const childEnvironment = createExplicitChildEnvironment('git-tree');
  let raw;
  try {
    raw = execFileSync(assertTrustedGitAvailable(), ['ls-tree', '-r', '-z', '--full-tree', revision], { cwd: repositoryRoot, env: childEnvironment.env, encoding: 'buffer' });
  } finally {
    childEnvironment.cleanup();
  }
  const paths = [];
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('authorized Git tree returned an invalid record');
    const [mode, type, objectId] = record.slice(0, separator).split(' ');
    const relativePath = record.slice(separator + 1);
    if (type !== 'blob' || !/^(?:100644|100755)$/u.test(mode) || !/^[a-f0-9]{40}$/u.test(objectId)) {
      throw new Error(`authorized Git tree contains an unsupported tracked entry: ${relativePath}`);
    }
    assertSafeRelativePath(relativePath, 'authorized Git tracked path');
    paths.push(relativePath);
  }
  const unique = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== paths.length) throw new Error('authorized Git tree contains duplicate paths');
  return unique;
}

function gitUntrackedPathUniverse(repositoryRoot) {
  const childEnvironment = createExplicitChildEnvironment('git-untracked');
  let raw;
  try {
    raw = execFileSync(assertTrustedGitAvailable(), ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repositoryRoot, env: childEnvironment.env, encoding: 'buffer' });
  } finally {
    childEnvironment.cleanup();
  }
  const paths = [...new Set(raw.toString('utf8').split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
  for (const relativePath of paths) assertSafeRelativePath(relativePath, 'Git untracked path');
  return paths;
}

function isUnderCoveredPath(relativePath, coveredPaths) {
  return coveredPaths.some((coveredPath) => relativePath === coveredPath || relativePath.startsWith(`${coveredPath}/`));
}

function classifyUntrackedPath(relativePath, coveredPaths, identityPath) {
  if (PRIVATE_UNTRACKED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) return 'private-untracked';
  if (GENERATED_EVIDENCE_PATHS.includes(relativePath) || relativePath === identityPath) return 'generated-evidence';
  if (isUnderCoveredPath(relativePath, coveredPaths)) return 'dirty-candidate-overlay';
  return null;
}

function regularFileMap(rootDir, coveredPaths, excludedPaths) {
  const root = path.resolve(rootDir);
  const excluded = new Set(excludedPaths);
  const discovered = new Map();
  const visit = (relativePath) => {
    const target = resolveInside(root, relativePath);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      throw new Error(`covered path is unavailable: ${relativePath} (${error.message})`);
    }
    if (stat.isSymbolicLink()) throw new Error(`covered path contains a symlink: ${relativePath}`);
    if (stat.isFile()) {
      if (!excluded.has(relativePath)) {
        const bytes = fs.readFileSync(target);
        discovered.set(relativePath, { bytes: bytes.byteLength, sha256: sha256(bytes) });
      }
      return;
    }
    if (!stat.isDirectory()) throw new Error(`covered path is not regular: ${relativePath}`);
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.posix.join(relativePath, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`covered path contains a symlink: ${child}`);
      visit(child);
    }
  };
  for (const relativePath of coveredPaths) visit(relativePath);
  return discovered;
}

function validatePathList(paths, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(paths) || (!allowEmpty && paths.length === 0)) throw new Error(`${label} must be a${allowEmpty ? 'n' : ' non-empty'} array`);
  const seen = new Set();
  for (const relativePath of paths) {
    assertSafeRelativePath(relativePath, label);
    if (seen.has(relativePath)) throw new Error(`${label} contains a duplicate path: ${relativePath}`);
    seen.add(relativePath);
  }
  return seen;
}

function validateDigestEntry(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} must be an object`);
  assertSafeRelativePath(entry.path, label);
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`${label} has invalid byte count: ${entry.path}`);
  if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) throw new Error(`${label} has invalid SHA-256: ${entry.path}`);
}

function identityMaterial(identity) {
  const { contentDigest, generatedAt, ...material } = identity;
  void contentDigest;
  void generatedAt;
  return material;
}

export function computeContentIdentityDigest(identity) {
  return sha256(Buffer.from(canonicalJson(identityMaterial(identity))));
}

function collectIdentityFiles({ repositoryRoot, coveredPaths, excludedPaths, identityPath, authorizedRevision }) {
  const discovered = regularFileMap(repositoryRoot, coveredPaths, excludedPaths);
  const trackedPaths = gitTrackedPathUniverse(repositoryRoot, authorizedRevision);
  const generatedPaths = new Set(GENERATED_EVIDENCE_PATHS);
  for (const relativePath of trackedPaths) {
    if (generatedPaths.has(relativePath) || relativePath === identityPath) continue;
    const actual = readActualFileDigest(repositoryRoot, relativePath);
    const existing = discovered.get(relativePath);
    if (existing && (existing.bytes !== actual.bytes || existing.sha256 !== actual.sha256)) throw new Error(`identity discovered conflicting bytes for tracked path: ${relativePath}`);
    discovered.set(relativePath, actual);
  }

  const overlayPaths = [];
  const generatedUntrackedPaths = [];
  for (const relativePath of gitUntrackedPathUniverse(repositoryRoot)) {
    const classification = classifyUntrackedPath(relativePath, coveredPaths, identityPath);
    if (!classification) throw new Error(`unclassified untracked path is outside the verifier-owned scope: ${relativePath}`);
    if (classification === 'dirty-candidate-overlay') {
      if (!discovered.has(relativePath)) throw new Error(`untracked candidate path is not represented in identity: ${relativePath}`);
      overlayPaths.push(relativePath);
    } else if (classification === 'generated-evidence') {
      generatedUntrackedPaths.push(relativePath);
    }
  }

  const gitScope = {
    schemaVersion: 1,
    pathSource: 'git-ls-tree',
    trackedPaths: trackedPaths.filter((relativePath) => !generatedPaths.has(relativePath) && relativePath !== identityPath),
    classifiedTrackedPaths: trackedPaths
      .filter((relativePath) => generatedPaths.has(relativePath) || relativePath === identityPath)
      .map((relativePath) => ({ path: relativePath, classification: 'generated-evidence' })),
    overlayPaths: overlayPaths.sort((left, right) => left.localeCompare(right)),
    generatedUntrackedPaths: generatedUntrackedPaths.sort((left, right) => left.localeCompare(right)),
    privateUntrackedPrefixes: [...PRIVATE_UNTRACKED_PREFIXES]
  };
  return { discovered, gitScope };
}

function validateGitScope({ repositoryRoot, identity, coveredPaths, identityPath, authorizedRevision, listedPaths }) {
  const scope = identity.gitScope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('content identity gitScope is required');
  if (scope.schemaVersion !== 1 || scope.pathSource !== 'git-ls-tree') throw new Error('content identity gitScope schema is invalid');
  const trackedPaths = validatePathList(scope.trackedPaths, 'gitScope trackedPaths', { allowEmpty: true });
  const classifiedTrackedPaths = scope.classifiedTrackedPaths;
  if (!Array.isArray(classifiedTrackedPaths)) {
    throw new Error('gitScope tracked path classification is not verifier-owned');
  }
  const generatedPaths = new Set(GENERATED_EVIDENCE_PATHS);
  const expectedTree = gitTrackedPathUniverse(repositoryRoot, authorizedRevision);
  const expectedTrackedPaths = expectedTree.filter((relativePath) => !generatedPaths.has(relativePath) && relativePath !== identityPath);
  const expectedClassifiedTrackedPaths = expectedTree
    .filter((relativePath) => generatedPaths.has(relativePath) || relativePath === identityPath)
    .map((relativePath) => ({ path: relativePath, classification: 'generated-evidence' }));
  if (JSON.stringify(classifiedTrackedPaths) !== JSON.stringify(expectedClassifiedTrackedPaths)) {
    throw new Error('gitScope tracked path classification is not verifier-owned');
  }
  if (JSON.stringify([...trackedPaths].sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expectedTrackedPaths)) {
    const actualSet = new Set(trackedPaths);
    const expectedSet = new Set(expectedTrackedPaths);
    const missing = expectedTrackedPaths.filter((relativePath) => !actualSet.has(relativePath)).slice(0, 3);
    const extra = [...actualSet].filter((relativePath) => !expectedSet.has(relativePath)).slice(0, 3);
    throw new Error(`gitScope tracked path universe is incomplete or stale (missing=${missing.join(',')}; extra=${extra.join(',')})`);
  }
  if (!Array.isArray(scope.overlayPaths) || !Array.isArray(scope.generatedUntrackedPaths) || !Array.isArray(scope.privateUntrackedPrefixes)) throw new Error('gitScope untracked classifications are invalid');
  if (JSON.stringify([...scope.privateUntrackedPrefixes].sort()) !== JSON.stringify([...PRIVATE_UNTRACKED_PREFIXES].sort())) throw new Error('gitScope private untracked rules are not verifier-owned');
  const overlayPaths = validatePathList(scope.overlayPaths, 'gitScope overlayPaths', { allowEmpty: true });
  const generatedUntrackedPaths = validatePathList(scope.generatedUntrackedPaths, 'gitScope generatedUntrackedPaths', { allowEmpty: true });
  const actualOverlayPaths = [];
  const actualGeneratedPaths = [];
  for (const relativePath of gitUntrackedPathUniverse(repositoryRoot)) {
    const classification = classifyUntrackedPath(relativePath, coveredPaths, identityPath);
    if (!classification) throw new Error(`unclassified untracked path is outside the verifier-owned scope: ${relativePath}`);
    if (classification === 'dirty-candidate-overlay') actualOverlayPaths.push(relativePath);
    if (classification === 'generated-evidence') actualGeneratedPaths.push(relativePath);
  }
  if (JSON.stringify(actualOverlayPaths.sort((left, right) => left.localeCompare(right))) !== JSON.stringify([...overlayPaths].sort((left, right) => left.localeCompare(right)))) throw new Error('gitScope overlay paths are stale');
  if (JSON.stringify(actualGeneratedPaths.sort((left, right) => left.localeCompare(right))) !== JSON.stringify([...generatedUntrackedPaths].sort((left, right) => left.localeCompare(right)))) throw new Error('gitScope generated evidence paths are stale');
  for (const relativePath of expectedTrackedPaths) {
    if (!listedPaths.has(relativePath)) throw new Error(`tracked Git path is missing from identity: ${relativePath}`);
  }
  for (const relativePath of actualOverlayPaths) {
    if (!listedPaths.has(relativePath)) throw new Error(`untracked candidate overlay is missing from identity: ${relativePath}`);
  }
  return true;
}

export function buildContentIdentity({
  repositoryRoot,
  identityPath = CLEAN_IDENTITY_PATH,
  coveredPaths = AUTHORITATIVE_COVERED_PATHS,
  excludedFromDigest = [identityPath],
  authorizedRevision = gitHead(repositoryRoot),
  generatedAt = new Date().toISOString()
}) {
  const normalizedCoveredPaths = [...coveredPaths];
  const normalizedExcludedPaths = [...excludedFromDigest];
  validatePathList(normalizedCoveredPaths, 'coveredPaths');
  validatePathList(normalizedExcludedPaths, 'excludedFromDigest');
  assertSafeRelativePath(identityPath, 'identityPath');
  if (identityPath !== CLEAN_IDENTITY_PATH) throw new Error(`identityPath must be ${CLEAN_IDENTITY_PATH}`);
  if (JSON.stringify([...normalizedCoveredPaths].sort()) !== JSON.stringify([...AUTHORITATIVE_COVERED_PATHS].sort())) throw new Error('coveredPaths must match the verifier-owned authoritative scope');
  if (normalizedExcludedPaths.length !== 1 || normalizedExcludedPaths[0] !== identityPath) throw new Error('excludedFromDigest must contain only identityPath');
  if (!COMMIT_SHA.test(authorizedRevision)) throw new Error('authorizedRevision must be a full lowercase commit SHA');

  const { discovered, gitScope } = collectIdentityFiles({
    repositoryRoot,
    coveredPaths: normalizedCoveredPaths,
    excludedPaths: [...new Set([...normalizedExcludedPaths, ...GENERATED_EVIDENCE_PATHS])],
    identityPath,
    authorizedRevision
  });
  const includedFiles = [...discovered.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, digest]) => ({ path: filePath, ...digest }));
  const identity = {
    schemaVersion: 1,
    identityKind: 'repository-content',
    identityPath,
    generatedAt,
    scopeDescription: 'Exact regular-file identity for a clean candidate. The identity file is excluded from its own content digest; an external acceptance record binds its full SHA-256 to the final commit.',
    coveredPaths: normalizedCoveredPaths,
    excludedFromDigest: normalizedExcludedPaths,
    gitScope,
    includedFiles,
    contentDigest: ''
  };
  identity.contentDigest = computeContentIdentityDigest(identity);
  return identity;
}

export function validateContentIdentity({ repositoryRoot, identity, expectedIdentityPath = identity?.identityPath, authorizedRevision = gitHead(repositoryRoot) }) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('content identity must be an object');
  if (identity.schemaVersion !== 1) throw new Error('content identity schemaVersion must be 1');
  if (identity.identityKind !== 'repository-content') throw new Error('content identity kind is invalid');
  assertSafeRelativePath(identity.identityPath, 'identityPath');
  if (identity.identityPath !== CLEAN_IDENTITY_PATH) throw new Error(`identityPath must be ${CLEAN_IDENTITY_PATH}`);
  if (expectedIdentityPath !== identity.identityPath) throw new Error('content identity path does not match the expected path');
  if (!COMMIT_SHA.test(authorizedRevision)) throw new Error('authorizedRevision must be a full lowercase commit SHA');
  const coveredPaths = validatePathList(identity.coveredPaths, 'coveredPaths');
  const excludedPaths = validatePathList(identity.excludedFromDigest, 'excludedFromDigest');
  if (JSON.stringify([...coveredPaths].sort()) !== JSON.stringify([...AUTHORITATIVE_COVERED_PATHS].sort())) throw new Error('content identity coveredPaths do not match the verifier-owned authoritative scope');
  if (excludedPaths.size !== 1 || !excludedPaths.has(identity.identityPath)) throw new Error('content identity excludedFromDigest is not the verifier-owned minimal exclusion');
  if (typeof identity.contentDigest !== 'string' || !SHA256.test(identity.contentDigest)) throw new Error('content identity digest is invalid');
  if (computeContentIdentityDigest(identity) !== identity.contentDigest) throw new Error('content identity digest is stale');

  if (!Array.isArray(identity.includedFiles) || identity.includedFiles.length === 0) throw new Error('content identity includedFiles are required');
  const listed = new Map();
  for (const entry of identity.includedFiles) {
    validateDigestEntry(entry, 'included file');
    if (listed.has(entry.path)) throw new Error(`content identity contains a duplicate path: ${entry.path}`);
    if (entry.path === identity.identityPath) throw new Error('content identity includes its own identity file');
    listed.set(entry.path, { bytes: entry.bytes, sha256: entry.sha256 });
  }

  validateGitScope({ repositoryRoot, identity, coveredPaths: [...coveredPaths], identityPath: identity.identityPath, authorizedRevision, listedPaths: listed });
  const { discovered } = collectIdentityFiles({
    repositoryRoot,
    coveredPaths: [...coveredPaths],
    excludedPaths: [...new Set([...excludedPaths, ...GENERATED_EVIDENCE_PATHS])],
    identityPath: identity.identityPath,
    authorizedRevision
  });
  if (JSON.stringify([...discovered.keys()].sort()) !== JSON.stringify([...listed.keys()].sort())) {
    throw new Error('content identity covered scope does not exactly match includedFiles');
  }
  for (const [relativePath, expected] of listed) {
    const actual = discovered.get(relativePath);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`content identity file is stale: ${relativePath}`);
  }
  return true;
}

function gitOutput(repositoryRoot, args, label) {
  const childEnvironment = createExplicitChildEnvironment('git-output');
  try {
    return execFileSync(assertTrustedGitAvailable(), args, { cwd: repositoryRoot, env: childEnvironment.env, encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`);
  } finally {
    childEnvironment.cleanup();
  }
}

export function gitHead(repositoryRoot) {
  const head = gitOutput(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], 'git HEAD lookup');
  if (!COMMIT_SHA.test(head)) throw new Error('git HEAD is not a full lowercase commit SHA');
  return head;
}

export function workingTreeStatus(repositoryRoot) {
  return gitOutput(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'git working-tree status');
}

function assertMeasuredField(actual, expected, field, label) {
  if (actual !== expected) throw new Error(`${label} ${field} does not match the measured artifact`);
}

function validateArtifactBinding({ repositoryRoot, artifactRoot, artifactBinding, expectedVersion }) {
  if (!artifactBinding || typeof artifactBinding !== 'object' || Array.isArray(artifactBinding)) throw new Error('artifactBinding is required');
  const packageArtifact = artifactBinding.package;
  if (!packageArtifact || typeof packageArtifact !== 'object') throw new Error('artifactBinding.package is required');
  if (typeof packageArtifact.path !== 'string' || !isSafeRelativePath(packageArtifact.path)) throw new Error('artifactBinding package path is invalid');
  if (typeof packageArtifact.filename !== 'string' || !/^linmas-\d+\.\d+\.\d+\.tgz$/u.test(packageArtifact.filename)) throw new Error('artifactBinding package filename is invalid');
  if (packageArtifact.path !== packageArtifact.filename) throw new Error('artifactBinding package path must equal its filename');
  if (!Number.isSafeInteger(packageArtifact.bytes) || packageArtifact.bytes <= 0) throw new Error('artifactBinding package byte count is invalid');
  if (!Number.isSafeInteger(packageArtifact.entryCount) || packageArtifact.entryCount <= 0) throw new Error('artifactBinding package entry count is invalid');
  if (typeof packageArtifact.sha256 !== 'string' || !SHA256.test(packageArtifact.sha256)) throw new Error('artifactBinding package digest is invalid');
  if (typeof packageArtifact.inventorySha256 !== 'string' || !SHA256.test(packageArtifact.inventorySha256)) throw new Error('artifactBinding package inventory digest is invalid');
  if (packageArtifact.packageName !== 'linmas' || packageArtifact.packageVersion !== expectedVersion) throw new Error('artifactBinding package metadata is invalid');
  if (packageArtifact.published !== false) throw new Error('artifactBinding package must remain unpublished');
  const plugin = artifactBinding.plugin;
  if (!plugin || typeof plugin !== 'object') throw new Error('artifactBinding.plugin is required');
  if (typeof plugin.path !== 'string' || !isSafeRelativePath(plugin.path)) throw new Error('artifactBinding plugin path is invalid');
  if (!Number.isSafeInteger(plugin.fileCount) || plugin.fileCount <= 0) throw new Error('artifactBinding plugin file count is invalid');
  if (typeof plugin.contentDigest !== 'string' || !SHA256.test(plugin.contentDigest)) throw new Error('artifactBinding plugin digest is invalid');
  if (plugin.packageName !== 'linmas' || plugin.packageVersion !== expectedVersion) throw new Error('artifactBinding plugin metadata is invalid');
  if (plugin.published !== false) throw new Error('artifactBinding plugin must remain unpublished');

  const measured = measureReleaseArtifacts({
    repositoryRoot,
    artifactRoot,
    packagePath: packageArtifact.path,
    pluginPath: plugin.path,
    expectedVersion
  });
  for (const field of ['filename', 'bytes', 'entryCount', 'sha256', 'inventorySha256', 'packageName', 'packageVersion']) assertMeasuredField(measured.package[field], packageArtifact[field], field, 'package artifact');
  for (const field of ['fileCount', 'contentDigest', 'packageName', 'packageVersion']) assertMeasuredField(measured.plugin[field], plugin[field], field, 'plugin artifact');
}

const EVIDENCE_KINDS = new Set(['source-inspection', 'deterministic-fixture', 'actual-runtime-loading', 'live-model-evaluation']);
const RESULT_STATUSES = new Set(['PASS', 'FAIL', 'UNSUPPORTED', 'UNKNOWN']);
const REQUIRED_SKILL_IDS = Object.freeze([
  'linmas-security-operations-lead',
  'linmas-smart-contract-reviewer',
  'linmas-exploit-validation-specialist',
  'linmas-threat-research-analyst',
  'linmas-detection-rules-engineer',
  'linmas-incident-triage-lead',
  'linmas-controls-compliance-reviewer',
  'linmas-cloud-hardening-architect',
  'linmas-secure-systems-architect',
  'linmas-secure-code-reviewer',
  'linmas-security-domain-router'
]);
const REQUIRED_MCP_TOOL_NAMES = Object.freeze([
  'linmas_review_decide',
  'linmas_review_prepare',
  'linmas_review_compare',
  'linmas_policy_evaluate',
  'linmas_proof_verify',
  'linmas_proof_create',
  'linmas_review_execute'
]);
const STRICT_VERSION = /^\d+\.\d+\.\d+$/u;
const HISTORICAL_IDENTITY_SCHEMA_LEGACY = 1;
const HISTORICAL_IDENTITY_SCHEMA_EXPLICIT = 2;
const HISTORICAL_CANDIDATE_KEYS = new Set([
  'packageVersion',
  'pluginVersion',
  'implementationHead',
  'workingTreeState',
  'baseline',
  'sourceRevision',
  'snapshot',
  'packageArtifact',
  'pluginParity',
  'identitySchemaVersion'
]);
const HISTORICAL_PACKAGE_ARTIFACT_KEYS = new Set([
  'filename',
  'entryCount',
  'bytes',
  'sha256',
  'inventorySha256',
  'repeatability',
  'destination',
  'published',
  'verification',
  'packageName',
  'packageVersion'
]);
const HISTORICAL_PLUGIN_PARITY_KEYS = new Set([
  'byteIdentical',
  'skillCount',
  'fileCount',
  'contentDigest',
  'target',
  'canonical',
  'published',
  'pluginName',
  'pluginVersion'
]);

function computeSnapshotDigest(snapshot) {
  const { snapshotDigest, ...material } = snapshot;
  void snapshotDigest;
  return sha256(Buffer.from(JSON.stringify(material)));
}

function parseRevision(revision) {
  const match = /^HEAD ([a-f0-9]{40}) \+ dirty snapshot sha256:([a-f0-9]{64})$/u.exec(revision || '');
  if (!match) throw new Error('historical source revision has an unsupported format');
  return { implementationHead: match[1], snapshotDigest: match[2] };
}

function relevantIdentityEntries(identity) {
  const generated = new Set(HISTORICAL_EXCLUDED_PATHS);
  return identity.includedFiles
    .filter((entry) => !generated.has(entry.path))
    .map(({ path: entryPath, bytes, sha256: digest }) => ({ path: entryPath, bytes, sha256: digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function relevantContentDigest(entries) {
  return sha256(Buffer.from(canonicalJson({
    schemaVersion: 1,
    evidenceClass: EVIDENCE_CLASS,
    entries
  })));
}

function requireText(value, label, minimum = 1) {
  if (typeof value !== 'string' || value.trim().length < minimum) throw new Error(`${label} is required`);
  return value;
}

function assertExactSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== 'string')) throw new Error(`${label} must be an array of strings`);
  if (new Set(actual).size !== actual.length) throw new Error(`${label} contains duplicates`);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} is not verifier-owned`);
}

function validateResult(result, label, { expectedStatus, claimLevel, allowUnknown = false, requireClaim = true } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${label} is required`);
  if (!RESULT_STATUSES.has(result.status)) throw new Error(`${label} status is invalid`);
  if (expectedStatus && result.status !== expectedStatus) throw new Error(`${label} status is not verifier-owned`);
  if (!allowUnknown && result.status === 'UNKNOWN') throw new Error(`${label} cannot be UNKNOWN for eligible evidence`);
  requireText(result.summary, `${label} summary`, 8);
  if (requireClaim && (typeof result.claimLevel !== 'string' || result.claimLevel !== claimLevel)) throw new Error(`${label} claim level is invalid`);
  if (requireClaim && typeof result.runtimeObserved !== 'boolean') throw new Error(`${label} runtimeObserved is invalid`);
}

export { computeArtifactBindingDigest };

function freshEvidenceDigestMaterial(disposition) {
  return {
    schemaVersion: disposition.schemaVersion,
    evidenceClass: disposition.evidenceClass,
    sourceRevision: disposition.sourceRevision,
    contentIdentityDigest: disposition.contentIdentityDigest,
    artifactBindingDigest: disposition.artifactBindingDigest,
    records: [...disposition.records].sort((left, right) => left.recordId.localeCompare(right.recordId))
  };
}

export function computeFreshEvidenceDigest(disposition) {
  return sha256(Buffer.from(canonicalJson(freshEvidenceDigestMaterial(disposition))));
}

function historicalEvidenceDigestMaterial({ sourceRevision, snapshotDigest, relevantDigest, artifactBindingDigest, normalizedHistoricalIdentity, records }) {
  return {
    schemaVersion: 1,
    evidenceClass: EVIDENCE_CLASS,
    sourceRevision,
    snapshotDigest,
    relevantContentDigest: relevantDigest,
    artifactBindingDigest,
    normalizedHistoricalIdentity,
    records: [...records].sort((left, right) => left.recordId.localeCompare(right.recordId))
  };
}

function computeHistoricalEvidenceDigest(input) {
  return sha256(Buffer.from(canonicalJson(historicalEvidenceDigestMaterial(input))));
}

function readJsonObject(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function validateEvidenceFile(repositoryRoot, identity, file, label, { allowGenerated = false } = {}) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`${label} must be an object`);
  assertSafeRelativePath(file.path, label);
  if (!allowGenerated && GENERATED_EVIDENCE_PATHS.includes(file.path)) throw new Error(`${label} cannot reference generated evidence manifests: ${file.path}`);
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw new Error(`${label} byte binding is invalid: ${file.path}`);
  const listed = new Map((identity.includedFiles || []).map((entry) => [entry.path, entry]));
  const expected = listed.get(file.path);
  if (!expected) throw new Error(`${label} is outside the content identity: ${file.path}`);
  const target = resolveInside(repositoryRoot, file.path);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${file.path} (${error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file.path}`);
  const bytes = fs.readFileSync(target);
  const actual = { bytes: bytes.byteLength, sha256: sha256(bytes) };
  if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`${label} is stale: ${file.path}`);
  if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) throw new Error(`${label} is not bound to the current identity: ${file.path}`);
}

function validateHistoricalRecord({ repositoryRoot, identity, evidence, sourceRevision, collectionDate, identityFiles, artifactBinding }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('historical evidence record must be an object');
  for (const field of ['recordId', 'runtimeProduct', 'runtimeVersion', 'osVersion', 'adapterVersion', 'operation', 'capabilityProfile', 'evidenceRevision', 'collectionDate', 'evidenceKind', 'limitation']) requireText(evidence[field], `historical evidence ${field}`);
  if (evidence.evidenceRevision !== sourceRevision) throw new Error(`historical evidence revision is stale: ${evidence.recordId}`);
  if (evidence.collectionDate !== collectionDate || !/^\d{4}-\d{2}-\d{2}$/u.test(evidence.collectionDate)) throw new Error(`historical evidence collection date is invalid: ${evidence.recordId}`);
  if (!EVIDENCE_KINDS.has(evidence.evidenceKind)) throw new Error(`historical evidence kind is invalid: ${evidence.recordId}`);
  if (!Array.isArray(evidence.evidenceLocation) || evidence.evidenceLocation.length === 0) throw new Error(`historical evidence locations are required: ${evidence.recordId}`);
  for (const location of evidence.evidenceLocation) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) throw new Error(`historical evidence location is invalid: ${evidence.recordId}`);
    requireText(location.path, `historical evidence location path: ${evidence.recordId}`);
    requireText(location.locator, `historical evidence locator: ${evidence.recordId}`);
    validateEvidenceFile(repositoryRoot, identity, { path: location.path, bytes: identityFiles.get(location.path)?.bytes, sha256: identityFiles.get(location.path)?.sha256 }, `historical evidence location ${evidence.recordId}`);
  }
  if (evidence.evidenceArtifacts !== null && evidence.evidenceArtifacts !== undefined) {
    if (!Array.isArray(evidence.evidenceArtifacts) || evidence.evidenceArtifacts.length === 0) throw new Error(`historical evidence artifacts are invalid: ${evidence.recordId}`);
    for (const artifact of evidence.evidenceArtifacts) validateEvidenceFile(repositoryRoot, identity, artifact, `historical evidence artifact ${evidence.recordId}`);
  }
  validateResult(evidence.expectedResult, `historical expected result ${evidence.recordId}`, { allowUnknown: true, claimLevel: evidence.evidenceKind, requireClaim: false });
  validateResult(evidence.observedResult, `historical observed result ${evidence.recordId}`, { allowUnknown: true, claimLevel: evidence.evidenceKind });
  if (evidence.evidenceKind === 'source-inspection' || evidence.evidenceKind === 'deterministic-fixture') {
    const required = REQUIRED_EVIDENCE_RECORDS[evidence.recordId];
    const operationContract = getEvidenceContract(evidence.recordId);
    if (!required || !operationContract || required.operation !== evidence.operation || required.evidenceKind !== evidence.evidenceKind) throw new Error(`historical eligible evidence is outside the verifier-owned set: ${evidence.recordId}`);
    if (evidence.expectedResult.status !== required.status || evidence.observedResult.status !== required.status) throw new Error(`historical eligible evidence status is invalid: ${evidence.recordId}`);
    if (evidence.expectedResult.resultSchema !== operationContract.resultSchema || evidence.observedResult.resultSchema !== operationContract.resultSchema) throw new Error(`historical eligible evidence result schema is invalid: ${evidence.recordId}`);
    if (evidence.expectedResult.summary !== operationContract.expectedSummary) throw new Error(`historical eligible evidence expected semantics are invalid: ${evidence.recordId}`);
    if (!evidence.observedResult.result || typeof evidence.observedResult.result !== 'object' || Array.isArray(evidence.observedResult.result)) throw new Error(`historical eligible evidence machine result is missing: ${evidence.recordId}`);
    validateOperationResult(operationContract, evidence.observedResult.result, { artifactBinding, requireTrustedPackager: false });
    if (evidence.observedResult.summary !== formatObservedSummary(operationContract, evidence.observedResult.result)) throw new Error(`historical eligible evidence summary is not derived from its result: ${evidence.recordId}`);
    validateOperationLocations(repositoryRoot, operationContract, evidence.evidenceLocation);
    if (evidence.observedResult.runtimeObserved !== false) throw new Error(`historical eligible evidence claims runtime observation: ${evidence.recordId}`);
  } else {
    if (evidence.observedResult.status !== 'UNKNOWN' || evidence.observedResult.runtimeObserved !== false) throw new Error(`historical runtime evidence is promoted: ${evidence.recordId}`);
  }
  for (const field of ['runtimeVersion', 'osVersion', 'adapterVersion']) {
    if (/^(UNKNOWN|N\/A)(?:\s|$)/u.test(evidence[field])) {
      const reasonField = evidence[field].startsWith('N/A') ? 'notApplicableReason' : 'unknownReason';
      requireText(evidence[reasonField], `historical evidence ${reasonField}: ${evidence.recordId}`);
    }
  }
}

function assertKnownObjectKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unknown identity field: ${key}`);
  }
}

function historicalIdentitySchemaVersion(candidate) {
  const value = candidate.identitySchemaVersion ?? HISTORICAL_IDENTITY_SCHEMA_LEGACY;
  if (!Number.isInteger(value) || ![HISTORICAL_IDENTITY_SCHEMA_LEGACY, HISTORICAL_IDENTITY_SCHEMA_EXPLICIT].includes(value)) throw new Error('historical identity schema version is unsupported');
  return value;
}

function normalizedHistoricalIdentity(candidate, artifactBinding) {
  assertKnownObjectKeys(candidate, HISTORICAL_CANDIDATE_KEYS, 'historical candidate');
  assertKnownObjectKeys(candidate.packageArtifact, HISTORICAL_PACKAGE_ARTIFACT_KEYS, 'historical package artifact');
  assertKnownObjectKeys(candidate.pluginParity, HISTORICAL_PLUGIN_PARITY_KEYS, 'historical plugin parity');
  const sourceSchemaVersion = historicalIdentitySchemaVersion(candidate);
  const measuredPackage = artifactBinding.package;
  const measuredPlugin = artifactBinding.plugin;
  const explicitPackageName = candidate.packageArtifact.packageName;
  const explicitPackageVersion = candidate.packageArtifact.packageVersion;
  const explicitPluginName = candidate.pluginParity.pluginName;
  const explicitPluginVersion = candidate.pluginParity.pluginVersion;
  if (explicitPackageName !== undefined && explicitPackageName !== measuredPackage.packageName) throw new Error('historical package name does not match the actual artifact binding');
  if (explicitPackageVersion !== undefined && explicitPackageVersion !== measuredPackage.packageVersion) throw new Error('historical package identity version does not match the actual artifact binding');
  if (explicitPluginName !== undefined && explicitPluginName !== measuredPlugin.packageName) throw new Error('historical plugin name does not match the actual artifact binding');
  if (explicitPluginVersion !== undefined && explicitPluginVersion !== measuredPlugin.packageVersion) throw new Error('historical plugin identity version does not match the actual artifact binding');
  if (sourceSchemaVersion === HISTORICAL_IDENTITY_SCHEMA_EXPLICIT && (typeof explicitPackageName !== 'string' || typeof explicitPackageVersion !== 'string' || typeof explicitPluginName !== 'string' || typeof explicitPluginVersion !== 'string')) {
    throw new Error('historical identity schema 2 requires explicit package and plugin names and versions');
  }
  return {
    schemaVersion: 1,
    sourceSchemaVersion,
    normalization: 'measured-artifact-v1',
    package: {
      name: measuredPackage.packageName,
      version: measuredPackage.packageVersion
    },
    plugin: {
      name: measuredPlugin.packageName,
      version: measuredPlugin.packageVersion
    }
  };
}

function validateHistoricalArtifactRelationship(candidate, artifactBinding) {
  if (!artifactBinding || typeof artifactBinding !== 'object' || Array.isArray(artifactBinding)) throw new Error('historical artifact binding is required');
  const packageArtifact = candidate.packageArtifact;
  const measuredPackage = artifactBinding.package;
  if (candidate.packageVersion !== measuredPackage.packageVersion) throw new Error('historical package version does not match the actual artifact binding');
  if (candidate.pluginVersion !== artifactBinding.plugin.packageVersion) throw new Error('historical plugin version does not match the actual artifact binding');
  const packageFields = ['filename', 'bytes', 'entryCount', 'sha256', 'inventorySha256'];
  for (const field of packageFields) {
    if (packageArtifact[field] !== measuredPackage[field]) throw new Error(`historical package artifact ${field} does not match the actual artifact binding`);
  }
  if (packageArtifact.published !== false || measuredPackage.published !== false) throw new Error('historical package artifact publication state is invalid');
  const pluginParity = candidate.pluginParity;
  const measuredPlugin = artifactBinding.plugin;
  for (const field of ['fileCount', 'contentDigest']) {
    if (pluginParity[field] !== measuredPlugin[field]) throw new Error(`historical plugin parity ${field} does not match the actual artifact binding`);
  }
  if (pluginParity.byteIdentical !== true || pluginParity.published !== false || pluginParity.skillCount !== 11) throw new Error('historical plugin parity metadata is invalid');
  return normalizedHistoricalIdentity(candidate, artifactBinding);
}

function deriveHistoricalEvidenceRecord({ repositoryRoot, sourceBytes, identity, artifactBinding }) {
  const sourceRecord = readJsonObjectFromBytes(sourceBytes, 'historical source record');
  if (sourceRecord.schemaVersion !== 1 || sourceRecord.status !== 'UNRELEASED' || typeof sourceRecord.recordId !== 'string') throw new Error('historical source record schema/status is not eligible');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sourceRecord.collectionDate)) throw new Error('historical source record collectionDate is invalid');
  const candidate = sourceRecord.candidate;
  if (!candidate || typeof candidate !== 'object' || candidate.workingTreeState !== 'dirty' || !COMMIT_SHA.test(candidate.implementationHead)) throw new Error('historical source record candidate identity is not eligible');
  if (!STRICT_VERSION.test(candidate.packageVersion) || !STRICT_VERSION.test(candidate.pluginVersion)) throw new Error('historical source record candidate versions are invalid');
  if (!candidate.baseline || typeof candidate.baseline !== 'object' || Array.isArray(candidate.baseline)) throw new Error('historical source baseline metadata is missing');
  for (const field of ['tag', 'tagObject', 'securityCommit', 'peeledCommit', 'signatureTrust', 'identityVerification']) requireText(candidate.baseline[field], `historical source baseline ${field}`);
  if (!candidate.packageArtifact || typeof candidate.packageArtifact !== 'object' || !STRICT_VERSION.test(candidate.packageVersion) || candidate.packageArtifact.published !== false || typeof candidate.packageArtifact.filename !== 'string' || !Number.isSafeInteger(candidate.packageArtifact.bytes) || !Number.isSafeInteger(candidate.packageArtifact.entryCount) || !SHA256.test(candidate.packageArtifact.sha256) || !SHA256.test(candidate.packageArtifact.inventorySha256)) throw new Error('historical source package artifact metadata is incomplete');
  if (!candidate.pluginParity || typeof candidate.pluginParity !== 'object' || candidate.pluginParity.byteIdentical !== true || !Number.isSafeInteger(candidate.pluginParity.skillCount) || !Number.isSafeInteger(candidate.pluginParity.fileCount) || !SHA256.test(candidate.pluginParity.contentDigest) || candidate.pluginParity.published !== false) throw new Error('historical source plugin parity metadata is incomplete');
  const normalizedIdentity = validateHistoricalArtifactRelationship(candidate, artifactBinding);
  if (!sourceRecord.environment || typeof sourceRecord.environment !== 'object' || Array.isArray(sourceRecord.environment)) throw new Error('historical source environment is missing');
  for (const field of ['osVersion', 'nodeVersion', 'npmVersion']) requireText(sourceRecord.environment[field], `historical source environment ${field}`);
  if (!Array.isArray(sourceRecord.evidenceArtifacts) || sourceRecord.evidenceArtifacts.length === 0) throw new Error('historical source evidenceArtifacts are missing');
  const sourceRevision = parseRevision(candidate.sourceRevision);
  if (sourceRevision.implementationHead !== candidate.implementationHead) throw new Error('historical source revision does not match candidate HEAD');
  if (candidate.snapshot?.path !== HISTORICAL_SNAPSHOT_PATH || candidate.snapshot?.digest !== sourceRevision.snapshotDigest) throw new Error('historical source snapshot linkage is invalid');

  const snapshotPath = resolveInside(repositoryRoot, HISTORICAL_SNAPSHOT_PATH);
  const snapshot = readJsonObject(snapshotPath, 'historical snapshot');
  if (snapshot.schemaVersion !== 1 || snapshot.snapshotKind !== 'working-tree-overlay') throw new Error('historical snapshot schema/kind is not eligible');
  if (snapshot.baseImplementationHead !== candidate.implementationHead || snapshot.snapshotDigest !== sourceRevision.snapshotDigest) throw new Error('historical snapshot identity is not bound to the source record');
  if (computeSnapshotDigest(snapshot) !== snapshot.snapshotDigest) throw new Error('historical snapshot digest is stale');
  if (JSON.stringify([...snapshot.excludedFromDigest].sort()) !== JSON.stringify([...HISTORICAL_EXCLUDED_PATHS].sort())) throw new Error('historical snapshot exclusions are not canonical');
  if (!Array.isArray(snapshot.coveredPaths) || JSON.stringify([...snapshot.coveredPaths].sort()) !== JSON.stringify([...AUTHORITATIVE_COVERED_PATHS].sort())) throw new Error('historical snapshot covered scope is not verifier-owned');
  if (JSON.stringify(snapshot.gitScope) !== JSON.stringify(identity.gitScope)) throw new Error('historical snapshot Git scope differs from current verifier-owned scope');
  if (!Array.isArray(snapshot.includedFiles) || snapshot.includedFiles.length === 0) throw new Error('historical snapshot files are missing');

  if (!sourceRecord.inventory || !Array.isArray(sourceRecord.inventory.skills) || !Array.isArray(sourceRecord.inventory.mcpTools)) throw new Error('historical source inventory is missing');
  assertExactSet(sourceRecord.inventory.skills, REQUIRED_SKILL_IDS, 'historical skill inventory');
  assertExactSet(sourceRecord.inventory.mcpTools, REQUIRED_MCP_TOOL_NAMES, 'historical MCP inventory');
  if (!Array.isArray(sourceRecord.records) || sourceRecord.records.length === 0) throw new Error('historical source evidence records are missing');
  const identityFiles = new Map(identity.includedFiles.map((entry) => [entry.path, entry]));
  for (const artifact of sourceRecord.evidenceArtifacts) {
    requireText(artifact.source, 'historical source evidence artifact source');
    validateEvidenceFile(repositoryRoot, identity, artifact, 'historical source evidence artifact');
  }
  const recordIds = new Set();
  const operations = new Set();
  const eligibleRecords = [];
  for (const evidence of sourceRecord.records) {
    validateHistoricalRecord({ repositoryRoot, identity, evidence, sourceRevision: candidate.sourceRevision, collectionDate: sourceRecord.collectionDate, identityFiles, artifactBinding });
    if (recordIds.has(evidence.recordId)) throw new Error(`historical source contains duplicate record: ${evidence.recordId}`);
    if (operations.has(evidence.operation)) throw new Error(`historical source contains duplicate operation: ${evidence.operation}`);
    recordIds.add(evidence.recordId);
    operations.add(evidence.operation);
    if (evidence.evidenceKind === 'source-inspection' || evidence.evidenceKind === 'deterministic-fixture') eligibleRecords.push(evidence);
  }
  const eligibleIds = eligibleRecords.map((evidence) => evidence.recordId).sort();
  const eligibleOperations = eligibleRecords.map((evidence) => evidence.operation).sort();
  if (JSON.stringify(eligibleIds) !== JSON.stringify(REQUIRED_EVIDENCE_RECORD_IDS) || JSON.stringify(eligibleOperations) !== JSON.stringify(REQUIRED_EVIDENCE_OPERATIONS)) throw new Error('historical source eligible evidence set is incomplete or caller-selected');

  const historicalEntries = snapshot.includedFiles
    .map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }))
    .filter((entry) => !HISTORICAL_EXCLUDED_PATHS.includes(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const currentEntries = relevantIdentityEntries(identity);
  if (JSON.stringify(historicalEntries.map((entry) => entry.path)) !== JSON.stringify(currentEntries.map((entry) => entry.path))) throw new Error('historical evidence relevant scope does not match current authoritative identity');
  if (JSON.stringify(historicalEntries) !== JSON.stringify(currentEntries)) throw new Error('historical evidence relevant content differs from current authoritative identity');

  const evidenceDigest = computeHistoricalEvidenceDigest({
    sourceRevision: candidate.sourceRevision,
    snapshotDigest: snapshot.snapshotDigest,
    relevantDigest: relevantContentDigest(historicalEntries),
    artifactBindingDigest: computeArtifactBindingDigest(artifactBinding),
    normalizedHistoricalIdentity: normalizedIdentity,
    records: eligibleRecords
  });

  return {
    evidenceClass: EVIDENCE_CLASS,
    sourceRevision: candidate.sourceRevision,
    snapshotPath: HISTORICAL_SNAPSHOT_PATH,
    snapshotDigest: snapshot.snapshotDigest,
    relevantContentDigest: relevantContentDigest(historicalEntries),
    artifactBindingDigest: computeArtifactBindingDigest(artifactBinding),
    normalizedHistoricalIdentity: normalizedIdentity,
    eligibleRecordIds: eligibleIds,
    eligibleOperations,
    evidenceDigest
  };
}

function readJsonObjectFromBytes(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be an object');
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateInputIdentity(repositoryRoot, identity, inputIdentity, label) {
  if (!Array.isArray(inputIdentity) || inputIdentity.length === 0) throw new Error(`${label} input identity is missing`);
  const seen = new Set();
  for (const input of inputIdentity) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.path !== 'string' || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) throw new Error(`${label} input identity is invalid`);
    if (seen.has(input.path)) throw new Error(`${label} input identity contains a duplicate path: ${input.path}`);
    seen.add(input.path);
    if (input.path.startsWith('<fixture>/')) continue;
    validateEvidenceFile(repositoryRoot, identity, input, `${label} input identity`);
  }
}

function validateFreshOutput(evidence, contractItem) {
  if (!evidence.output || typeof evidence.output !== 'object' || Array.isArray(evidence.output)) throw new Error(`fresh evidence output is missing: ${evidence.recordId}`);
  const output = evidence.output;
  if (output.schemaVersion !== 1 || output.contentType !== 'application/json' || !Number.isSafeInteger(output.bytes) || output.bytes < 0 || typeof output.sha256 !== 'string' || !SHA256.test(output.sha256)) throw new Error(`fresh evidence output descriptor is invalid: ${evidence.recordId}`);
  const resultBytes = Buffer.from(canonicalJson(evidence.observedResult.result));
  if (!Object.prototype.hasOwnProperty.call(output, 'value') || canonicalJson(output.value) !== canonicalJson(evidence.observedResult.result)) throw new Error(`fresh evidence output is unrelated to the observed result: ${evidence.recordId}`);
  if (output.bytes !== resultBytes.byteLength || output.sha256 !== sha256(resultBytes)) throw new Error(`fresh evidence output digest is stale: ${evidence.recordId}`);
  if (!evidence.producer || typeof evidence.producer !== 'object' || Array.isArray(evidence.producer) || evidence.producer.id !== contractItem.producerId || evidence.producer.version !== '1' || evidence.producer.entrypoint !== 'scripts/evidence-operations.mjs' || evidence.producer.execution !== EVIDENCE_PRODUCER_EXECUTION || evidence.producer.attestation !== 'external-outer-launch-required') throw new Error(`fresh evidence producer is invalid: ${evidence.recordId}`);
  if (!Array.isArray(evidence.inputIdentity) || evidence.inputIdentity.length === 0) throw new Error(`fresh evidence input identity is missing: ${evidence.recordId}`);
  for (const input of evidence.inputIdentity) {
    if (!input || typeof input !== 'object' || typeof input.path !== 'string' || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) throw new Error(`fresh evidence input identity is invalid: ${evidence.recordId}`);
  }
}

function validateFreshEvidenceDisposition({ repositoryRoot, identity, disposition, artifactBinding, artifactRoot, currentRevision }) {
  if (disposition.schemaVersion !== 1 || disposition.evidenceClass !== EVIDENCE_CLASS) throw new Error('fresh evidence schema/class is invalid');
  if (disposition.sourceRevision !== currentRevision) throw new Error('fresh evidence source revision is stale');
  if (disposition.contentIdentityDigest !== identity.contentDigest) throw new Error('fresh evidence content identity binding is stale');
  if (typeof disposition.artifactBindingDigest !== 'string' || !SHA256.test(disposition.artifactBindingDigest)) throw new Error('fresh evidence artifact binding digest is invalid');
  if (disposition.artifactBindingDigest !== computeArtifactBindingDigest(artifactBinding)) throw new Error('fresh evidence artifact binding is stale');
  if (JSON.stringify(disposition.producer) !== JSON.stringify({ id: 'linmas.irsa003.local-operations', version: '1', execution: EVIDENCE_PRODUCER_EXECUTION, attestation: 'external-outer-launch-required', childEnvironmentPolicy: 'explicit-allowlist-v1' })) throw new Error('fresh evidence producer is not verifier-owned');
  if (!Array.isArray(disposition.records) || disposition.records.length !== REQUIRED_EVIDENCE_RECORD_IDS.length) throw new Error('fresh evidence records are incomplete');
  const records = new Map();
  for (const evidence of disposition.records) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('fresh evidence record must be an object');
    const required = REQUIRED_EVIDENCE_RECORDS[evidence.recordId];
    if (!required) throw new Error(`fresh evidence record is unrelated: ${evidence.recordId}`);
    if (records.has(evidence.recordId)) throw new Error(`fresh evidence record is duplicated: ${evidence.recordId}`);
    const operationContract = getEvidenceContract(evidence.recordId);
    if (!operationContract || evidence.operation !== operationContract.operation || evidence.evidenceKind !== operationContract.evidenceKind) throw new Error(`fresh evidence linkage is invalid: ${evidence.recordId}`);
    if (evidence.expectedResult?.status !== operationContract.expectedStatus || evidence.observedResult?.status !== operationContract.expectedStatus) throw new Error(`fresh evidence result is invalid: ${evidence.recordId}`);
    if (evidence.expectedResult?.summary !== operationContract.expectedSummary || evidence.expectedResult?.resultSchema !== operationContract.resultSchema) throw new Error(`fresh evidence expected semantics are invalid: ${evidence.recordId}`);
    validateResult(evidence.expectedResult, `fresh expected result ${evidence.recordId}`, { expectedStatus: operationContract.expectedStatus, claimLevel: operationContract.evidenceKind, requireClaim: false });
    validateResult(evidence.observedResult, `fresh observed result ${evidence.recordId}`, { expectedStatus: operationContract.expectedStatus, claimLevel: operationContract.evidenceKind });
    if (evidence.observedResult.runtimeObserved !== false) throw new Error(`fresh evidence runtimeObserved must be false: ${evidence.recordId}`);
    if (evidence.observedResult.resultSchema !== operationContract.resultSchema || !evidence.observedResult.result || typeof evidence.observedResult.result !== 'object' || Array.isArray(evidence.observedResult.result)) throw new Error(`fresh evidence machine result is invalid: ${evidence.recordId}`);
    validateOperationResult(operationContract, evidence.observedResult.result, { artifactBinding });
    if (evidence.observedResult.summary !== formatObservedSummary(operationContract, evidence.observedResult.result)) throw new Error(`fresh evidence summary is not derived from its result: ${evidence.recordId}`);
    validateOperationLocations(repositoryRoot, operationContract, evidence.evidenceLocation);
    validateFreshOutput(evidence, operationContract);
    validateInputIdentity(repositoryRoot, identity, evidence.inputIdentity, `fresh evidence ${evidence.recordId}`);
    records.set(evidence.recordId, evidence);
  }
  if (JSON.stringify([...records.keys()].sort()) !== JSON.stringify(REQUIRED_EVIDENCE_RECORD_IDS)) throw new Error('fresh evidence record IDs are incomplete');
  if (JSON.stringify([...records.values()].map((entry) => entry.operation).sort()) !== JSON.stringify(REQUIRED_EVIDENCE_OPERATIONS)) throw new Error('fresh evidence operations are incomplete');
  const trusted = collectFreshEvidence({
    repositoryRoot,
    artifactRoot,
    packagePath: artifactBinding.package.path,
    pluginPath: artifactBinding.plugin.path
  });
  if (!trusted || typeof trusted !== 'object' || !trusted.disposition || !trusted.artifactBinding) throw new Error('fresh evidence trusted operation output is invalid');
  if (computeArtifactBindingDigest(trusted.artifactBinding) !== computeArtifactBindingDigest(artifactBinding)) throw new Error('fresh evidence trusted artifact binding is stale');
  const trustedDisposition = structuredClone(trusted.disposition);
  trustedDisposition.contentIdentityDigest = identity.contentDigest;
  trustedDisposition.evidenceDigest = computeFreshEvidenceDigest(trustedDisposition);
  if (trustedDisposition.sourceRevision !== currentRevision || trustedDisposition.artifactBindingDigest !== disposition.artifactBindingDigest) throw new Error('fresh evidence trusted operation revision or artifact binding is stale');
  const suppliedRecords = [...records.values()].sort((left, right) => left.recordId.localeCompare(right.recordId));
  const trustedRecords = [...trustedDisposition.records].sort((left, right) => left.recordId.localeCompare(right.recordId));
  if (canonicalJson(suppliedRecords) !== canonicalJson(trustedRecords)) throw new Error('fresh evidence records are not the output of the trusted verifier-owned operations');
  if (typeof disposition.evidenceDigest !== 'string' || !SHA256.test(disposition.evidenceDigest) || disposition.evidenceDigest !== computeFreshEvidenceDigest({ ...disposition, records: suppliedRecords })) throw new Error('fresh evidence digest is stale');
  return true;
}

export function deriveHistoricalEvidence({ repositoryRoot, sourceBytes, identity, artifactBinding }) {
  return deriveHistoricalEvidenceRecord({ repositoryRoot, sourceBytes, identity, artifactBinding });
}

function validateEvidenceDisposition({ repositoryRoot, identity, disposition, artifactBinding, artifactRoot, currentRevision }) {
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) throw new Error('evidenceDisposition is required');
  if (!['fresh', 'historical-reuse'].includes(disposition.mode)) throw new Error('evidenceDisposition mode is invalid');
  if (typeof disposition.applicability !== 'string' || !disposition.applicability.trim()) throw new Error('evidenceDisposition applicability is required');
  if (disposition.mode === 'fresh') return validateFreshEvidenceDisposition({ repositoryRoot, identity, disposition, artifactBinding, artifactRoot, currentRevision });

  if (disposition.sourceRecordPath !== HISTORICAL_RECORD_PATH) throw new Error('historical source record path is not the canonical v0.9.0 evidence record');
  if (typeof disposition.sourceRecordSha256 !== 'string' || !SHA256.test(disposition.sourceRecordSha256)) throw new Error('historical source record digest is invalid');
  const sourcePath = resolveInside(repositoryRoot, disposition.sourceRecordPath);
  let sourceBytes;
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    sourceBytes = fs.readFileSync(sourcePath);
  } catch (error) {
    throw new Error(`historical source record is unavailable: ${disposition.sourceRecordPath} (${error.message})`);
  }
  if (sha256(sourceBytes) !== disposition.sourceRecordSha256) throw new Error('historical source record is stale');
  const derived = deriveHistoricalEvidence({ repositoryRoot, sourceBytes, identity, artifactBinding });
  if (typeof disposition.artifactBindingDigest !== 'string' || !SHA256.test(disposition.artifactBindingDigest) || disposition.artifactBindingDigest !== computeArtifactBindingDigest(artifactBinding)) throw new Error('historical evidence artifact binding is stale');
  for (const field of ['evidenceClass', 'sourceRevision', 'snapshotPath', 'snapshotDigest', 'relevantContentDigest', 'artifactBindingDigest', 'evidenceDigest']) {
    if (disposition[field] !== derived[field]) throw new Error(`historical evidence ${field} is not derived from the source record`);
  }
  if (canonicalJson(disposition.normalizedHistoricalIdentity) !== canonicalJson(derived.normalizedHistoricalIdentity)) throw new Error('historical evidence normalized identity is not derived from the source record');
  if (JSON.stringify(disposition.eligibleRecordIds) !== JSON.stringify(derived.eligibleRecordIds) || JSON.stringify(disposition.eligibleOperations) !== JSON.stringify(derived.eligibleOperations)) throw new Error('historical evidence eligible subset is not verifier-derived');
  return true;
}

function validateBoundEvidencePayload({ repositoryRoot, identity, acceptance, artifactRoot, currentRevision }) {
  if (!COMMIT_SHA.test(acceptance.implementationHead)) throw new Error('clean acceptance implementationHead is invalid');
  if (acceptance.implementationHead !== currentRevision) throw new Error('clean acceptance is stale: implementation HEAD does not match current HEAD');

  const contentIdentity = acceptance.contentIdentity;
  if (!contentIdentity || typeof contentIdentity !== 'object' || Array.isArray(contentIdentity)) throw new Error('clean acceptance contentIdentity is required');
  validateContentIdentity({ repositoryRoot, identity, expectedIdentityPath: contentIdentity.path, authorizedRevision: currentRevision });
  if (contentIdentity.contentDigest !== identity.contentDigest) throw new Error('clean acceptance content digest does not match identity');
  if (typeof contentIdentity.sha256 !== 'string' || !SHA256.test(contentIdentity.sha256)) throw new Error('clean acceptance identity file digest is invalid');
  const identityBytes = fs.readFileSync(resolveInside(repositoryRoot, identity.identityPath));
  if (sha256(identityBytes) !== contentIdentity.sha256) throw new Error('clean acceptance identity file is stale');

  if (typeof acceptance.packageVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(acceptance.packageVersion)) throw new Error('clean acceptance packageVersion is invalid');
  const packageJson = JSON.parse(fs.readFileSync(resolveInside(repositoryRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== acceptance.packageVersion) throw new Error('clean acceptance packageVersion does not match package.json');

  if (typeof artifactRoot !== 'string') throw new Error('artifactRoot is required for actual artifact validation');
  validateArtifactBinding({
    repositoryRoot,
    artifactRoot,
    artifactBinding: acceptance.artifactBinding,
    expectedVersion: acceptance.packageVersion
  });
  validateEvidenceDisposition({ repositoryRoot, identity, disposition: acceptance.evidenceDisposition, artifactBinding: acceptance.artifactBinding, artifactRoot, currentRevision });
  return true;
}

export function validateCleanEvidenceBinding({
  repositoryRoot,
  identity,
  acceptance,
  artifactRoot,
  currentRevision = gitHead(repositoryRoot),
  requireClean = true
}) {
  if (requireClean !== true) throw new Error('requireClean:false is not a clean-acceptance operation; use diagnostic evidence');
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) throw new Error('clean acceptance record must be an object');
  if (acceptance.schemaVersion !== 1) throw new Error('clean acceptance schemaVersion must be 1');
  if (acceptance.bindingKind !== 'clean-candidate-evidence') throw new Error('clean acceptance binding kind is invalid');
  if (acceptance.status !== 'UNRELEASED') throw new Error('clean acceptance status must be UNRELEASED');
  if (acceptance.workingTreeState !== 'clean') throw new Error('clean acceptance workingTreeState must be clean');
  if (workingTreeStatus(repositoryRoot) !== '') throw new Error('working tree must be clean for clean acceptance');
  return validateBoundEvidencePayload({ repositoryRoot, identity, acceptance, artifactRoot, currentRevision });
}

export function buildDiagnosticEvidenceBinding({ repositoryRoot, acceptance, currentRevision = gitHead(repositoryRoot) }) {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) throw new Error('diagnostic source record must be an object');
  const gitStatus = workingTreeStatus(repositoryRoot);
  return {
    schemaVersion: 1,
    bindingKind: 'diagnostic-candidate-evidence',
    status: 'PREPARATION_ONLY',
    packageVersion: acceptance.packageVersion,
    implementationHead: currentRevision,
    workingTreeState: gitStatus === '' ? 'clean' : 'dirty',
    gitStatus,
    contentIdentity: acceptance.contentIdentity,
    artifactBinding: acceptance.artifactBinding,
    evidenceDisposition: acceptance.evidenceDisposition
  };
}

export function validateDiagnosticEvidenceBinding({
  repositoryRoot,
  identity,
  diagnostic,
  artifactRoot,
  currentRevision = gitHead(repositoryRoot)
}) {
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) throw new Error('diagnostic evidence record must be an object');
  const expectedKeys = ['artifactBinding', 'bindingKind', 'contentIdentity', 'evidenceDisposition', 'gitStatus', 'implementationHead', 'packageVersion', 'schemaVersion', 'status', 'workingTreeState'];
  if (JSON.stringify(Object.keys(diagnostic).sort()) !== JSON.stringify(expectedKeys)) throw new Error('diagnostic evidence schema is not exact');
  if (diagnostic.schemaVersion !== 1 || diagnostic.bindingKind !== 'diagnostic-candidate-evidence' || diagnostic.status !== 'PREPARATION_ONLY') throw new Error('diagnostic evidence kind or status is invalid');
  const actualStatus = workingTreeStatus(repositoryRoot);
  if (diagnostic.gitStatus !== actualStatus) throw new Error('diagnostic evidence Git status is stale');
  if (diagnostic.workingTreeState !== (actualStatus === '' ? 'clean' : 'dirty')) throw new Error('diagnostic evidence workingTreeState is stale');
  return validateBoundEvidencePayload({ repositoryRoot, identity, acceptance: diagnostic, artifactRoot, currentRevision });
}

function parseArgs(argv) {
  const allowed = new Set(['--mode', '--root-dir', '--identity-path', '--output', '--identity-file', '--acceptance-file', '--artifact-root']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || values.has(key)) throw new Error('invalid evidence-binding arguments');
    values.set(key, value);
  }
  return values;
}

function main(argv) {
  const args = parseArgs(argv);
  const mode = args.get('--mode');
  const repositoryRoot = path.resolve(args.get('--root-dir') || process.cwd());
  if (mode === 'identity') {
    const identityPath = args.get('--identity-path') || CLEAN_IDENTITY_PATH;
    const output = path.resolve(repositoryRoot, args.get('--output') || identityPath);
    const identity = buildContentIdentity({ repositoryRoot, identityPath });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ output, contentDigest: identity.contentDigest, fileCount: identity.includedFiles.length }, null, 2)}\n`);
    return;
  }
  if (mode === 'clean' || mode === 'diagnostic') {
    const identityFile = path.resolve(repositoryRoot, args.get('--identity-file') || CLEAN_IDENTITY_PATH);
    const acceptanceFile = path.resolve(args.get('--acceptance-file') || path.join(repositoryRoot, '.local-agent', 'clean-acceptance.json'));
    const artifactRoot = args.get('--artifact-root');
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    const acceptance = JSON.parse(fs.readFileSync(acceptanceFile, 'utf8'));
    if (mode === 'clean') {
      validateCleanEvidenceBinding({ repositoryRoot, identity, acceptance, artifactRoot });
      process.stdout.write(`${JSON.stringify({ valid: true, implementationHead: acceptance.implementationHead, contentDigest: identity.contentDigest }, null, 2)}\n`);
      return;
    }
    const diagnostic = buildDiagnosticEvidenceBinding({ repositoryRoot, acceptance });
    validateDiagnosticEvidenceBinding({ repositoryRoot, identity, diagnostic, artifactRoot });
    const output = args.get('--output');
    if (!output) throw new Error('diagnostic mode requires --output');
    fs.writeFileSync(path.resolve(output), `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ valid: true, bindingKind: diagnostic.bindingKind, workingTreeState: diagnostic.workingTreeState }, null, 2)}\n`);
    return;
  }
  throw new Error('mode must be identity, diagnostic, or clean');
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`evidence binding validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
