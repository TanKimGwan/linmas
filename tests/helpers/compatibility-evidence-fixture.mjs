import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { PUBLIC_SKILL_IDS } from '../../src/core/skill-catalog.mjs';
import { listTools } from '../../mcp/server.mjs';
import {
  AUTHORITATIVE_COVERED_PATHS,
  CLEAN_IDENTITY_PATH,
  GENERATED_EVIDENCE_PATHS,
  PRIVATE_UNTRACKED_PREFIXES,
  REQUIRED_EVIDENCE_RECORDS
} from '../../scripts/validate-evidence-binding.mjs';

const RECORD_PATH = 'docs/compatibility/evidence/v0.9.0-record.json';
const SNAPSHOT_PATH = 'docs/compatibility/evidence/v0.9.0-snapshot.json';
const EXCLUDED = new Set(GENERATED_EVIDENCE_PATHS);
const COLLECTION_DATE = '2026-09-08';
const inheritedPath = process.env.PATH ?? process.env.Path;
if (!inheritedPath) throw new Error('Git executable PATH is unavailable');
const GIT_ENV = {
  PATH: inheritedPath,
  HOME: os.tmpdir(),
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0'
};
if (process.platform === 'win32') {
  for (const name of ['SystemRoot', 'PATHEXT', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) GIT_ENV[name] = value;
  }
}
const GIT_EXECUTABLE = 'git';

const MCP_TESTS = Object.freeze({
  linmas_review_prepare: 'offline prepare is read-only and returns prepared plus human-review state',
  linmas_review_compare: 'offline compare, policy evaluate, and proof verify return verified bounded results',
  linmas_policy_evaluate: 'offline compare, policy evaluate, and proof verify return verified bounded results',
  linmas_proof_verify: 'offline compare, policy evaluate, and proof verify return verified bounded results',
  linmas_proof_create: 'proof create requires explicit write confirmation and verifies its own result',
  linmas_review_execute: 'review execute is prepared without consent and only executes a mocked provider after consent',
  linmas_review_decide: 'F-006 decision gate rejects tampered review references and uses immutable severity'
});

const UNKNOWN_RUNTIME_OPERATIONS = Object.freeze([
  ['R090-HOST-CHATGPT', 'host-loading:chatgpt', 'actual-runtime-loading'],
  ['R090-HOST-CLAUDE', 'host-loading:claude-code', 'actual-runtime-loading'],
  ['R090-HOST-CODEX', 'host-loading:codex', 'actual-runtime-loading'],
  ['R090-HOST-FILESYSTEM', 'host-loading:generic-filesystem-agent', 'actual-runtime-loading'],
  ['R090-HOST-HERMES', 'format-loading:hermes', 'actual-runtime-loading'],
  ['R090-HOST-MCP-CLIENT', 'host-loading:generic-mcp-client', 'actual-runtime-loading'],
  ['R090-HOST-OPENCLAW', 'host-loading:openclaw', 'actual-runtime-loading'],
  ['R090-LIVE-CODEX', 'live-evaluation:codex', 'live-model-evaluation']
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(root, ...args) {
  return execFileSync(GIT_EXECUTABLE, args, { cwd: root, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function isIgnoredByGit(root, relativePath) {
  const result = spawnSync(GIT_EXECUTABLE, ['check-ignore', '--no-index', '--quiet', '--', relativePath], {
    cwd: root,
    env: GIT_ENV,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = result.stderr.trim();
  throw new Error(`git check-ignore failed for generated evidence path ${relativePath} (exit ${result.status})${detail ? `: ${detail}` : ''}`);
}

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function evidenceLocations(recordId, operation) {
  if (operation.startsWith('mcp:')) {
    const tool = operation.slice('mcp:'.length);
    return [
      { path: 'tests/mcp-server.test.mjs', locator: `test: ${MCP_TESTS[tool]}` },
      { path: 'docs/linmas-mcp-validation-runbook.md', locator: `tool: ${tool}` }
    ];
  }
  if (operation.startsWith('skill:')) {
    const skill = operation.slice('skill:'.length, -':catalog'.length);
    return [
      { path: `skills/${skill}/SKILL.md`, locator: 'file: SKILL.md' },
      { path: 'src/core/skill-catalog.mjs', locator: 'text: PUBLIC_SKILL_IDS' }
    ];
  }
  if (recordId === 'R090-PROVIDER-CLAUDE') return [{ path: 'tests/claude-provider.test.mjs', locator: 'test: Claude runner sends explicit headers/model and returns usage' }];
  if (recordId === 'R090-WINDOWS-001') return [{ path: 'src/core/uninstall-skills.mjs', locator: 'text: SAFE_FILESYSTEM_OPERATION_UNAVAILABLE' }];
  if (recordId === 'R090-PLUGIN-001') return [{ path: 'scripts/build-codex-plugin.mjs', locator: 'text: buildPlugin' }];
  return [{ path: 'package.json', locator: 'json: $.name' }];
}

function eligibleRecord(recordId, required, sourceRevision) {
  const summary = recordId === 'R090-WINDOWS-001'
    ? 'Synthetic Windows denial: SAFE_FILESYSTEM_OPERATION_UNAVAILABLE.'
    : `Synthetic source or deterministic fixture for ${recordId}.`;
  return {
    recordId,
    runtimeProduct: 'Disposable compatibility fixture',
    runtimeVersion: 'fixture-1',
    osVersion: process.platform,
    adapterVersion: '0.9.0 fixture',
    operation: required.operation,
    capabilityProfile: required.evidenceKind,
    evidenceRevision: sourceRevision,
    collectionDate: COLLECTION_DATE,
    evidenceKind: required.evidenceKind,
    expectedResult: { status: required.status, summary: `Expected ${summary}` },
    observedResult: { status: required.status, summary, claimLevel: required.evidenceKind, runtimeObserved: false },
    evidenceLocation: evidenceLocations(recordId, required.operation),
    limitation: 'Synthetic fixture; it is not historical or runtime observation evidence.'
  };
}

function unknownRuntimeRecord([recordId, operation, kind], sourceRevision) {
  const reason = 'No runtime or live model was observed in this disposable fixture.';
  return {
    recordId,
    runtimeProduct: 'Disposable compatibility fixture',
    runtimeVersion: 'UNKNOWN',
    osVersion: 'UNKNOWN',
    adapterVersion: 'UNKNOWN',
    unknownReason: reason,
    operation,
    capabilityProfile: kind,
    evidenceRevision: sourceRevision,
    collectionDate: COLLECTION_DATE,
    evidenceKind: kind,
    expectedResult: { status: 'UNKNOWN', summary: reason },
    observedResult: { status: 'UNKNOWN', summary: reason, claimLevel: kind, runtimeObserved: false },
    evidenceLocation: [{ path: 'docs/compatibility/COMPATIBILITY.md', locator: 'heading: Runtime matrix' }],
    limitation: reason
  };
}

export function createCompatibilityEvidenceFixture(repositoryRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-v090-compatibility-fixture-'));
  const root = path.join(temporaryRoot, 'checkout');
  try {
    execFileSync(GIT_EXECUTABLE, ['clone', '--shared', '--quiet', repositoryRoot, root], { env: GIT_ENV, stdio: 'pipe' });
    const changed = git(repositoryRoot, 'diff', '--name-only', '-z').split('\0').filter(Boolean);
    const untracked = git(repositoryRoot, 'ls-files', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean);
    const overlayPaths = [...changed, ...untracked.filter((relativePath) =>
      !relativePath.startsWith('.local-agent/') && !EXCLUDED.has(relativePath))];
    for (const relativePath of overlayPaths) {
      const source = path.join(repositoryRoot, relativePath);
      const target = path.join(root, relativePath);
      if (!fs.lstatSync(source).isFile()) throw new Error(`fixture overlay is not regular: ${relativePath}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.writeFileSync(path.join(root, '.fixture-marker'), 'Disposable compatibility fixture; no runtime claim.\n');
    git(root, 'add', '-f', '--', ...overlayPaths, '.fixture-marker');
    git(root, '-c', 'user.name=Compatibility Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'bind disposable compatibility fixture');
    const implementationHead = git(root, 'rev-parse', 'HEAD');
    if (git(root, 'status', '--porcelain=v1', '--untracked-files=all') !== '') throw new Error('fixture source commit is not clean');

    const treePaths = git(root, 'ls-tree', '-r', '--full-tree', '--name-only', 'HEAD').split('\n').filter(Boolean);
    const includedFiles = treePaths.filter((relativePath) => !EXCLUDED.has(relativePath)).map((relativePath) => {
      const bytes = fs.readFileSync(path.join(root, relativePath));
      return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const trackedPaths = treePaths.filter((relativePath) => !EXCLUDED.has(relativePath)).sort();
    const classifiedTrackedPaths = treePaths.filter((relativePath) => EXCLUDED.has(relativePath))
      .map((relativePath) => ({ path: relativePath, classification: 'generated-evidence' }));
    if (!treePaths.includes(CLEAN_IDENTITY_PATH)) {
      writeJson(root, CLEAN_IDENTITY_PATH, {
        schemaVersion: 1,
        identityKind: 'disposable-link-target',
        limitation: 'This fixture file is not a clean candidate identity.'
      });
    }
    const intendedGeneratedPaths = [RECORD_PATH, SNAPSHOT_PATH,
      ...(!treePaths.includes(CLEAN_IDENTITY_PATH) ? [CLEAN_IDENTITY_PATH] : [])].sort();
    const generatedPathVisibility = new Map(intendedGeneratedPaths.map((relativePath) => [
      relativePath,
      !isIgnoredByGit(root, relativePath)
    ]));
    const generatedUntrackedPaths = intendedGeneratedPaths
      .filter((relativePath) => generatedPathVisibility.get(relativePath))
      .sort((left, right) => left.localeCompare(right));
    const baselineCommit = git(root, 'rev-parse', 'v0.8.0^{}');
    const snapshot = {
      schemaVersion: 1,
      snapshotKind: 'working-tree-overlay',
      baseImplementationHead: implementationHead,
      baseSecurityCommit: baselineCommit,
      generatedAt: '2026-09-08T00:00:00.000Z',
      scopeDescription: 'Disposable revision-bound compatibility fixture.',
      coveredPaths: [...AUTHORITATIVE_COVERED_PATHS],
      excludedFromDigest: [RECORD_PATH, SNAPSHOT_PATH, CLEAN_IDENTITY_PATH],
      gitScope: {
        schemaVersion: 1,
        pathSource: 'git-ls-tree',
        trackedPaths,
        classifiedTrackedPaths,
        overlayPaths: [],
        generatedUntrackedPaths,
        privateUntrackedPrefixes: [...PRIVATE_UNTRACKED_PREFIXES]
      },
      includedFiles,
      snapshotDigest: ''
    };
    const { snapshotDigest: ignored, ...material } = snapshot;
    void ignored;
    snapshot.snapshotDigest = sha256(Buffer.from(JSON.stringify(material)));
    const sourceRevision = `HEAD ${implementationHead} + dirty snapshot sha256:${snapshot.snapshotDigest}`;
    const packageBytes = fs.readFileSync(path.join(root, 'package.json'));
    const eligible = Object.entries(REQUIRED_EVIDENCE_RECORDS)
      .map(([recordId, required]) => eligibleRecord(recordId, required, sourceRevision));
    const record = {
      schemaVersion: 1,
      recordId: 'SYNTHETIC-COMPATIBILITY-TEST-001',
      collectionDate: COLLECTION_DATE,
      status: 'UNRELEASED',
      candidate: {
        packageVersion: '0.9.0',
        pluginVersion: '0.9.0',
        implementationHead,
        workingTreeState: 'dirty',
        baseline: {
          tag: 'v0.8.0',
          tagObject: git(root, 'rev-parse', 'v0.8.0^{tag}'),
          securityCommit: baselineCommit,
          peeledCommit: baselineCommit,
          signatureTrust: 'UNVERIFIED',
          identityVerification: 'disposable-fixture'
        },
        sourceRevision,
        snapshot: { path: SNAPSHOT_PATH, digest: snapshot.snapshotDigest },
        packageArtifact: {
          filename: 'linmas-0.9.0.tgz',
          entryCount: 151,
          bytes: 1751129,
          sha256: 'e96ff656bc398485f60fd0062e995008539d5e93c37210c20851b22f90e2e3b0',
          inventorySha256: 'd461b257d99f1cfde34653d12981f3486ab28e23e1864df7d94979bc575bcf21',
          published: false
        },
        pluginParity: {
          byteIdentical: true,
          skillCount: 11,
          fileCount: 108,
          contentDigest: 'd87bd98b8ce98a1f42df6ab1d1b6f8a033eea5ce800ca697bb0739b5ca34a586',
          published: false
        }
      },
      environment: { osVersion: process.platform, nodeVersion: process.versions.node, npmVersion: 'fixture' },
      inventory: { skills: [...PUBLIC_SKILL_IDS], mcpTools: listTools().map((tool) => tool.name) },
      evidenceArtifacts: [{ path: 'package.json', source: 'synthetic-fixture', bytes: packageBytes.byteLength, sha256: sha256(packageBytes) }],
      records: [...eligible, ...UNKNOWN_RUNTIME_OPERATIONS.map((row) => unknownRuntimeRecord(row, sourceRevision))]
    };
    writeJson(root, SNAPSHOT_PATH, snapshot);
    writeJson(root, RECORD_PATH, record);
    const actualUntracked = new Set(git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean));
    const actualGeneratedUntrackedPaths = intendedGeneratedPaths.filter((relativePath) => actualUntracked.has(relativePath))
      .sort((left, right) => left.localeCompare(right));
    const ignoredGeneratedPaths = intendedGeneratedPaths.filter((relativePath) => !generatedPathVisibility.get(relativePath));
    if (JSON.stringify(actualGeneratedUntrackedPaths) !== JSON.stringify(generatedUntrackedPaths)) {
      throw new Error('generated evidence untracked paths do not match effective Git visibility');
    }
    if (ignoredGeneratedPaths.some((relativePath) => actualUntracked.has(relativePath)
      || generatedUntrackedPaths.includes(relativePath))) {
      throw new Error('ignored generated evidence path was incorrectly classified as visible untracked evidence');
    }
    return { root, record, snapshot, implementationHead, cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
