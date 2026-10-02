import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AUTHORITATIVE_COVERED_PATHS,
  CLEAN_IDENTITY_PATH,
  REQUIRED_EVIDENCE_RECORDS,
  REQUIRED_EVIDENCE_RECORD_IDS,
  buildContentIdentity,
  computeContentIdentityDigest,
  computeArtifactBindingDigest,
  computeFreshEvidenceDigest,
  deriveHistoricalEvidence,
  buildDiagnosticEvidenceBinding,
  validateCleanEvidenceBinding,
  validateDiagnosticEvidenceBinding
} from '../scripts/validate-evidence-binding.mjs';
import {
  measurePackageArtifact,
  measureReleaseArtifacts
} from '../scripts/artifact-integrity.mjs';
import { collectFreshEvidence } from '../scripts/evidence-operations.mjs';
import { resolveTrustedGitPath } from '../scripts/child-environment.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_VERSION = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
const CURRENT_PACKAGE_FILENAME = `linmas-${CURRENT_VERSION}.tgz`;
const RECORD_PATH = 'docs/compatibility/evidence/v0.9.0-record.json';
const SNAPSHOT_PATH = 'docs/compatibility/evidence/v0.9.0-snapshot.json';
const HISTORICAL_EXCLUSIONS = [RECORD_PATH, SNAPSHOT_PATH, CLEAN_IDENTITY_PATH];

test('trusted Git discovery resolves one validated POSIX PATH executable without a shell', () => {
  const root = '/fixture/posix-bin';
  const executable = '/fixture/posix-bin/git';
  const canonical = '/canonical/git';
  const fakeFs = {
    lstatSync(value) {
      if (value !== executable && value !== canonical) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
      return { isFile: () => true, isSymbolicLink: () => false, mode: 0o100755 };
    },
    realpathSync(value) {
      if (value !== executable) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
      return canonical;
    }
  };
  const invocations = [];
  const resolved = resolveTrustedGitPath({
    platform: 'linux',
    env: { PATH: root },
    fsImpl: fakeFs,
    run(command, args, options) {
      invocations.push({ command, args, options });
      if (command === canonical) return 'git version 2.45.1\n';
      throw new Error('unexpected discovery invocation');
    }
  });
  assert.equal(resolved, canonical);
  assert.deepEqual(invocations.map(({ command, args }) => ({ command, args })), [
    { command: canonical, args: ['--version'] }
  ]);
  assert.equal(invocations[0].options.shell, false);
  const moduleSource = fs.readFileSync(new URL('../scripts/child-environment.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(moduleSource, /\/usr\/bin\/git/u);
  assert.doesNotMatch(moduleSource, /\b(?:which|where(?:\.exe)?)\b|execSync\s*\(|shell\s*:\s*true/u);
});

test('CI binds namespace-capable Linux and a unique Windows Git PATH without weakening sandbox policy', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  assert.match(workflow, /verify:\n\s+# [^\n]*\n\s+runs-on:\s*ubuntu-22\.04/u);
  assert.match(workflow, /Verify required Linux bubblewrap namespaces[\s\S]*--unshare-all[\s\S]*--unshare-user[\s\S]*--disable-userns[\s\S]*\/proc\/self\/ns\/net[\s\S]*lo:[\s\S]*npm test/u);
  assert.match(workflow, /Normalize unique trusted Git PATH for Windows tests[\s\S]*Get-Command git\.exe[\s\S]*GITHUB_ENV[\s\S]*exactly one canonical Git executable/u);
  assert.doesNotMatch(workflow, /apparmor|sysctl|--share-net|sudo\s+(?:npm\s+test|node)|C:\\\\Program Files\\\\Git/iu);
});

test('trusted Git discovery uses the Windows PATH resolution boundary', () => {
  const candidate = 'C:\\fixture\\Git\\cmd\\git.exe';
  const fakeFs = {
    lstatSync(value) {
      if (value.toLowerCase() !== candidate.toLowerCase()) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
      return { isFile: () => true, isSymbolicLink: () => false, mode: 0o100755 };
    },
    realpathSync(value) {
      if (value.toLowerCase() !== candidate.toLowerCase()) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
      return candidate;
    }
  };
  const invocations = [];
  const resolved = resolveTrustedGitPath({
    platform: 'win32',
    env: { PATH: 'C:\\fixture\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' },
    fsImpl: fakeFs,
    run(command, args, options) {
      invocations.push({ command, args, options });
      if (command === candidate) return 'git version 2.45.1.windows.1\r\n';
      throw new Error('unexpected discovery invocation');
    }
  });
  assert.equal(resolved, candidate);
  assert.equal(invocations[0].command, candidate);
  assert.deepEqual(invocations[0].args, ['--version']);
  assert.equal(invocations[0].options.shell, false);
  assert.equal(invocations[0].options.env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.throws(() => resolveTrustedGitPath({
    platform: 'win32',
    env: { PATH: 'C:\\missing', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows' },
    fsImpl: {
      lstatSync: () => { throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' }); },
      realpathSync: (value) => value
    },
    run: () => { throw new Error('version must not run'); }
  }), /not found on PATH/u);
});

test('trusted Git discovery fails closed when PATH or its result is missing', () => {
  assert.throws(() => resolveTrustedGitPath({ platform: 'linux', env: { PATH: '' } }), /PATH is unavailable/u);
  assert.throws(() => resolveTrustedGitPath({
    platform: 'linux', env: { PATH: '/fixture' },
    fsImpl: {
      lstatSync: () => { throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' }); },
      realpathSync: (value) => value
    }
  }), /not found on PATH/u);
});

test('trusted Git discovery deduplicates aliases and rejects ambiguous or non-file results', () => {
  const paths = ['/fixture/one/git', '/fixture/two/git'];
  const fakeFs = {
    lstatSync(value) {
      if (!paths.includes(value)) throw new Error('missing fixture file');
      return { isFile: () => true, isSymbolicLink: () => false, mode: 0o100755 };
    },
    realpathSync(value) {
      if (!paths.includes(value)) throw new Error('missing fixture file');
      return value;
    }
  };
  assert.throws(() => resolveTrustedGitPath({
    platform: 'linux', env: { PATH: '/fixture/one:/fixture/two' }, fsImpl: fakeFs,
    run: () => 'git version 2.45.1\n'
  }), /ambiguous/u);
  const canonical = '/canonical/git';
  assert.equal(resolveTrustedGitPath({
    platform: 'linux', env: { PATH: '/fixture/one:/fixture/two' },
    fsImpl: {
      ...fakeFs,
      lstatSync(value) {
        if (value === canonical) return { isFile: () => true, isSymbolicLink: () => false, mode: 0o100755 };
        return fakeFs.lstatSync(value);
      },
      realpathSync(value) {
        fakeFs.lstatSync(value);
        return canonical;
      }
    },
    run: () => 'git version 2.45.1\n'
  }), canonical);
  assert.throws(() => resolveTrustedGitPath({
    platform: 'linux', env: { PATH: '/fixture' },
    fsImpl: { lstatSync: () => ({ isFile: () => false, isSymbolicLink: () => false, mode: 0o040755 }), realpathSync: (value) => value },
    run: () => 'git version 2.45.1\n'
  }), /invalid file/u);
});

function validateDiagnosticSource({ repositoryRoot, identity, acceptance, artifactRoot }) {
  const diagnostic = buildDiagnosticEvidenceBinding({ repositoryRoot, acceptance });
  return validateDiagnosticEvidenceBinding({ repositoryRoot, identity, diagnostic, artifactRoot });
}

const npmExecPath = process.env.npm_execpath;
assert.equal(typeof npmExecPath, 'string', 'tests must run under npm with npm_execpath set');
assert.notEqual(npmExecPath.trim(), '', 'npm_execpath must not be empty');
assert.equal(path.isAbsolute(npmExecPath), true);
assert.equal(fs.statSync(npmExecPath).isFile(), true);
const approvedNpmCli = fs.realpathSync(npmExecPath);
assert.equal(fs.lstatSync(approvedNpmCli).isFile(), true);
const previousApprovedNpmCli = process.env.LINMAS_APPROVED_NPM_CLI;
process.env.LINMAS_APPROVED_NPM_CLI = approvedNpmCli;
after(() => {
  if (previousApprovedNpmCli === undefined) delete process.env.LINMAS_APPROVED_NPM_CLI;
  else process.env.LINMAS_APPROVED_NPM_CLI = previousApprovedNpmCli;
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectFiles(repositoryRoot, coveredPaths, excludedPaths = []) {
  const excluded = new Set(excludedPaths);
  const entries = new Map();
  const visit = (relativePath) => {
    const target = path.join(repositoryRoot, ...relativePath.split('/'));
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`fixture source contains symlink: ${relativePath}`);
    if (stat.isFile()) {
      if (!excluded.has(relativePath)) {
        const bytes = fs.readFileSync(target);
        entries.set(relativePath, { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
      }
      return;
    }
    if (!stat.isDirectory()) throw new Error(`fixture source contains non-regular path: ${relativePath}`);
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      visit(path.posix.join(relativePath, entry.name));
    }
  };
  for (const coveredPath of coveredPaths) visit(coveredPath);
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function collectGitFiles(repositoryRoot, revision, excludedPaths = []) {
  const excluded = new Set(excludedPaths);
  const output = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', revision], { cwd: repositoryRoot, encoding: 'buffer' });
  return output.toString('utf8').split('\0').filter(Boolean).filter((relativePath) => !excluded.has(relativePath)).map((relativePath) => {
    const bytes = fs.readFileSync(path.join(repositoryRoot, ...relativePath.split('/')));
    return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function snapshotDigest(snapshot) {
  const { snapshotDigest: ignored, ...material } = snapshot;
  void ignored;
  return sha256(Buffer.from(JSON.stringify(material)));
}

function historicalRecords(sourceRevision) {
  const eligible = REQUIRED_EVIDENCE_RECORD_IDS.map((recordId) => {
    const required = REQUIRED_EVIDENCE_RECORDS[recordId];
    const summary = `Synthetic verifier-owned evidence for ${recordId}.`;
    return {
      recordId,
      runtimeProduct: 'Synthetic local verifier fixture',
      runtimeVersion: 'fixture-1',
      osVersion: process.platform,
      adapterVersion: '0.9.0 fixture',
      operation: required.operation,
      capabilityProfile: required.evidenceKind,
      evidenceRevision: sourceRevision,
      collectionDate: '2026-09-08',
      evidenceKind: required.evidenceKind,
      expectedResult: { status: required.status, summary },
      observedResult: {
        status: required.status,
        summary,
        claimLevel: required.evidenceKind,
        runtimeObserved: false
      },
      evidenceLocation: [{ path: 'package.json', locator: `fixture:${recordId}` }],
      evidenceArtifacts: null,
      limitation: 'Synthetic local fixture; it does not assert external runtime behavior.'
    };
  });
  const runtimeOperations = [
    ['R090-HOST-CHATGPT', 'host-loading:chatgpt', 'actual-runtime-loading'],
    ['R090-HOST-CLAUDE', 'host-loading:claude-code', 'actual-runtime-loading'],
    ['R090-HOST-CODEX', 'host-loading:codex', 'actual-runtime-loading'],
    ['R090-HOST-FILESYSTEM', 'host-loading:generic-filesystem-agent', 'actual-runtime-loading'],
    ['R090-HOST-HERMES', 'format-loading:hermes', 'actual-runtime-loading'],
    ['R090-HOST-MCP-CLIENT', 'host-loading:generic-mcp-client', 'actual-runtime-loading'],
    ['R090-HOST-OPENCLAW', 'host-loading:openclaw', 'actual-runtime-loading'],
    ['R090-LIVE-CODEX', 'live-evaluation:codex', 'live-model-evaluation']
  ];
  const runtime = runtimeOperations.map(([recordId, operation, evidenceKind]) => {
    const reason = 'No actual runtime or live model observation was authorized for this disposable fixture.';
    return {
      recordId,
      runtimeProduct: 'Synthetic local verifier fixture',
      runtimeVersion: 'UNKNOWN',
      osVersion: 'UNKNOWN',
      adapterVersion: 'UNKNOWN',
      unknownReason: reason,
      operation,
      capabilityProfile: evidenceKind,
      evidenceRevision: sourceRevision,
      collectionDate: '2026-09-08',
      evidenceKind,
      expectedResult: { status: 'UNKNOWN', summary: reason },
      observedResult: { status: 'UNKNOWN', summary: reason, claimLevel: evidenceKind, runtimeObserved: false },
      evidenceLocation: [{ path: 'docs/compatibility/COMPATIBILITY.md', locator: 'heading: Runtime matrix' }],
      limitation: reason
    };
  });
  return [...eligible, ...runtime];
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-clean-evidence-'));
  fs.cpSync(rootDir, root, {
    recursive: true,
    filter(sourcePath) {
      const relative = path.relative(rootDir, sourcePath).split(path.sep).join('/');
      if (!relative) return true;
      if (relative === '.git' || relative.startsWith('.git/')) return false;
      if (relative === '.local-agent' || relative.startsWith('.local-agent/')) return false;
      if (relative === 'node_modules' || relative.startsWith('node_modules/')) return false;
      if (relative === 'compatibility' || relative.startsWith('compatibility/')) return false;
      if (relative === RECORD_PATH || relative === SNAPSHOT_PATH) return false;
      if (path.basename(relative).startsWith('.env')) return false;
      return true;
    }
  });
  fs.writeFileSync(path.join(root, '.npmrc'), '# synthetic fixture npm control\n', 'utf8');
  fs.writeFileSync(path.join(root, '.npmignore'), '# synthetic fixture package control\n', 'utf8');
  fs.writeFileSync(path.join(root, 'UNEXPECTED-ROOT-CONFIG.toml'), 'fixture = true\n', 'utf8');
  fs.writeFileSync(path.join(root, '.github/workflows/reusable-fixture.yml'), 'name: synthetic reusable fixture\n', 'utf8');

  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Clean Evidence Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'clean-evidence@example.invalid'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '-f', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture source baseline'], { cwd: root, stdio: 'ignore' });
  const baseImplementationHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const snapshot = {
    schemaVersion: 1,
    snapshotKind: 'working-tree-overlay',
    baseImplementationHead,
    baseSecurityCommit: '6'.repeat(40),
    generatedAt: '2026-09-08T00:00:00.000Z',
    scopeDescription: 'Synthetic historical source snapshot for deterministic validator tests.',
    coveredPaths: [...AUTHORITATIVE_COVERED_PATHS],
    excludedFromDigest: [...HISTORICAL_EXCLUSIONS],
    gitScope: null,
    includedFiles: collectGitFiles(root, baseImplementationHead, HISTORICAL_EXCLUSIONS),
    snapshotDigest: ''
  };
  snapshot.snapshotDigest = snapshotDigest(snapshot);
  writeJson(path.join(root, SNAPSHOT_PATH), snapshot);

  const sourceRevision = `HEAD ${baseImplementationHead} + dirty snapshot sha256:${snapshot.snapshotDigest}`;
  const packageBytes = fs.readFileSync(path.join(root, 'package.json'));
  writeJson(path.join(root, RECORD_PATH), {
    schemaVersion: 1,
    recordId: 'SYNTHETIC-HISTORICAL-001',
    collectionDate: '2026-09-08',
    status: 'UNRELEASED',
    candidate: {
      packageVersion: CURRENT_VERSION,
      pluginVersion: CURRENT_VERSION,
      implementationHead: baseImplementationHead,
      workingTreeState: 'dirty',
      baseline: {
        tag: 'v0.8.0',
        tagObject: '1'.repeat(40),
        securityCommit: '2'.repeat(40),
        peeledCommit: '2'.repeat(40),
        signatureTrust: 'UNVERIFIED',
        identityVerification: 'synthetic-fixture'
      },
      sourceRevision,
      snapshot: { path: SNAPSHOT_PATH, digest: snapshot.snapshotDigest },
      packageArtifact: {
        filename: CURRENT_PACKAGE_FILENAME,
        entryCount: 1,
        bytes: 1,
        sha256: '3'.repeat(64),
        inventorySha256: '4'.repeat(64),
        published: false
      },
      pluginParity: {
        byteIdentical: true,
        skillCount: 11,
        fileCount: 1,
        contentDigest: '5'.repeat(64),
        published: false
      }
    },
    environment: { osVersion: process.platform, nodeVersion: process.versions.node, npmVersion: 'fixture' },
    inventory: {
      skills: ['linmas-security-operations-lead', 'linmas-smart-contract-reviewer', 'linmas-exploit-validation-specialist', 'linmas-threat-research-analyst', 'linmas-detection-rules-engineer', 'linmas-incident-triage-lead', 'linmas-controls-compliance-reviewer', 'linmas-cloud-hardening-architect', 'linmas-secure-systems-architect', 'linmas-secure-code-reviewer', 'linmas-security-domain-router'],
      mcpTools: ['linmas_review_decide', 'linmas_review_prepare', 'linmas_review_compare', 'linmas_policy_evaluate', 'linmas_proof_verify', 'linmas_proof_create', 'linmas_review_execute']
    },
    evidenceArtifacts: [{ path: 'package.json', source: 'fixture', bytes: packageBytes.byteLength, sha256: sha256(packageBytes) }],
    records: historicalRecords(sourceRevision)
  });

  execFileSync('git', ['add', '-f', RECORD_PATH, SNAPSHOT_PATH], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture historical evidence'], { cwd: root, stdio: 'ignore' });
  writeJson(path.join(root, CLEAN_IDENTITY_PATH), { schemaVersion: 0, placeholder: true });
  execFileSync('git', ['add', '-f', CLEAN_IDENTITY_PATH], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture identity placeholder'], { cwd: root, stdio: 'ignore' });
  const authorizedRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const identity = buildContentIdentity({ repositoryRoot: root, authorizedRevision, generatedAt: '2026-09-08T00:00:00.000Z' });
  snapshot.gitScope = structuredClone(identity.gitScope);
  snapshot.snapshotDigest = snapshotDigest(snapshot);
  const refreshedRecord = readJson(path.join(root, RECORD_PATH));
  const refreshedSourceRevision = `HEAD ${baseImplementationHead} + dirty snapshot sha256:${snapshot.snapshotDigest}`;
  refreshedRecord.candidate.sourceRevision = refreshedSourceRevision;
  refreshedRecord.candidate.snapshot.digest = snapshot.snapshotDigest;
  for (const evidence of refreshedRecord.records) evidence.evidenceRevision = refreshedSourceRevision;
  writeJson(path.join(root, SNAPSHOT_PATH), snapshot);
  writeJson(path.join(root, RECORD_PATH), refreshedRecord);
  writeJson(path.join(root, CLEAN_IDENTITY_PATH), identity);
  execFileSync('git', ['add', '-f', RECORD_PATH, SNAPSHOT_PATH, CLEAN_IDENTITY_PATH], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture evidence identity'], { cwd: root, stdio: 'ignore' });

  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-artifact-root-'));
  fs.mkdirSync(path.join(artifactRoot, 'plugin'), { recursive: true });
  execFileSync(process.execPath, [approvedNpmCli, 'pack', '--ignore-scripts', '--silent', '--pack-destination', artifactRoot], { cwd: root, stdio: 'ignore' });
  execFileSync('node', ['scripts/build-codex-plugin.mjs', '--target', path.join(artifactRoot, 'plugin', 'linmas')], { cwd: root, stdio: 'ignore' });
  const measured = measureReleaseArtifacts({
    repositoryRoot: root,
    artifactRoot,
    packagePath: CURRENT_PACKAGE_FILENAME,
    pluginPath: 'plugin/linmas',
    expectedVersion: CURRENT_VERSION
  });
  const artifactBinding = {
    package: {
      path: measured.package.path,
      filename: measured.package.filename,
      bytes: measured.package.bytes,
      entryCount: measured.package.entryCount,
      sha256: measured.package.sha256,
      inventorySha256: measured.package.inventorySha256,
      packageName: measured.package.packageName,
      packageVersion: measured.package.packageVersion,
      published: false
    },
    plugin: {
      path: measured.plugin.path,
      fileCount: measured.plugin.fileCount,
      contentDigest: measured.plugin.contentDigest,
      packageName: measured.plugin.packageName,
      packageVersion: measured.plugin.packageVersion,
      published: false
    }
  };
  refreshedRecord.candidate.packageArtifact = {
    filename: measured.package.filename,
    entryCount: measured.package.entryCount,
    bytes: measured.package.bytes,
    sha256: measured.package.sha256,
    inventorySha256: measured.package.inventorySha256,
    published: false
  };
  refreshedRecord.candidate.pluginParity = {
    byteIdentical: true,
    skillCount: 11,
    fileCount: measured.plugin.fileCount,
    contentDigest: measured.plugin.contentDigest,
    published: false
  };
  const collected = collectFreshEvidence({
    repositoryRoot: root,
    artifactRoot,
    packagePath: artifactBinding.package.path,
    pluginPath: artifactBinding.plugin.path
  });
  const collectedById = new Map(collected.disposition.records.map((entry) => [entry.recordId, entry]));
  refreshedRecord.records = refreshedRecord.records.map((evidence) => {
    const fresh = collectedById.get(evidence.recordId);
    if (!fresh) return evidence;
    return {
      ...evidence,
      operation: fresh.operation,
      evidenceKind: fresh.evidenceKind,
      expectedResult: fresh.expectedResult,
      observedResult: fresh.observedResult,
      evidenceLocation: fresh.evidenceLocation,
      producer: fresh.producer,
      inputIdentity: fresh.inputIdentity,
      output: fresh.output
    };
  });
  writeJson(path.join(root, RECORD_PATH), refreshedRecord);
  execFileSync('git', ['add', '-f', RECORD_PATH], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture measured operation evidence'], { cwd: root, stdio: 'ignore' });
  const implementationHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const identityBytes = fs.readFileSync(path.join(root, CLEAN_IDENTITY_PATH));
  const recordBytes = fs.readFileSync(path.join(root, RECORD_PATH));
  const derived = deriveHistoricalEvidence({ repositoryRoot: root, sourceBytes: recordBytes, identity, artifactBinding });
  const acceptance = {
    schemaVersion: 1,
    bindingKind: 'clean-candidate-evidence',
    status: 'UNRELEASED',
    packageVersion: CURRENT_VERSION,
    implementationHead,
    workingTreeState: 'clean',
    contentIdentity: {
      path: CLEAN_IDENTITY_PATH,
      sha256: sha256(identityBytes),
      contentDigest: identity.contentDigest
    },
    artifactBinding,
    evidenceDisposition: {
      mode: 'historical-reuse',
      applicability: 'The exact source and deterministic fixture subset is unchanged.',
      sourceRecordPath: RECORD_PATH,
      sourceRecordSha256: sha256(recordBytes),
      artifactBindingDigest: computeArtifactBindingDigest(artifactBinding),
      ...derived
    }
  };
  return { root, artifactRoot, identity, acceptance, implementationHead, baseImplementationHead };
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.artifactRoot, { recursive: true, force: true });
}

function buildArtifactBinding(repositoryRoot) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-canonical-artifact-'));
  fs.mkdirSync(path.join(artifactRoot, 'plugin'), { recursive: true });
  execFileSync(process.execPath, [approvedNpmCli, 'pack', '--ignore-scripts', '--silent', '--pack-destination', artifactRoot], { cwd: repositoryRoot, stdio: 'ignore' });
  execFileSync(process.execPath, ['scripts/build-codex-plugin.mjs', '--target', path.join(artifactRoot, 'plugin', 'linmas')], { cwd: repositoryRoot, stdio: 'ignore' });
  const measured = measureReleaseArtifacts({
    repositoryRoot,
    artifactRoot,
    packagePath: CURRENT_PACKAGE_FILENAME,
    pluginPath: 'plugin/linmas',
    expectedVersion: CURRENT_VERSION
  });
  return {
    artifactRoot,
    artifactBinding: {
      package: {
        path: measured.package.path,
        filename: measured.package.filename,
        bytes: measured.package.bytes,
        entryCount: measured.package.entryCount,
        sha256: measured.package.sha256,
        inventorySha256: measured.package.inventorySha256,
        packageName: measured.package.packageName,
        packageVersion: measured.package.packageVersion,
        published: false
      },
      plugin: {
        path: measured.plugin.path,
        fileCount: measured.plugin.fileCount,
        contentDigest: measured.plugin.contentDigest,
        packageName: measured.plugin.packageName,
        packageVersion: measured.plugin.packageVersion,
        published: false
      }
    }
  };
}

function freshDisposition(fixture) {
  const collected = collectFreshEvidence({
    repositoryRoot: fixture.root,
    artifactRoot: fixture.artifactRoot,
    packagePath: fixture.acceptance.artifactBinding.package.path,
    pluginPath: fixture.acceptance.artifactBinding.plugin.path
  });
  const disposition = structuredClone(collected.disposition);
  disposition.contentIdentityDigest = fixture.identity.contentDigest;
  disposition.evidenceDigest = computeFreshEvidenceDigest(disposition);
  return disposition;
}

function refreshIdentity(fixture) {
  const identity = buildContentIdentity({ repositoryRoot: fixture.root, generatedAt: '2026-09-08T00:00:00.000Z' });
  writeJson(path.join(fixture.root, CLEAN_IDENTITY_PATH), identity);
  const identityBytes = fs.readFileSync(path.join(fixture.root, CLEAN_IDENTITY_PATH));
  fixture.identity = identity;
  fixture.acceptance.contentIdentity = {
    path: CLEAN_IDENTITY_PATH,
    sha256: sha256(identityBytes),
    contentDigest: identity.contentDigest
  };
  return identity;
}

test('clean binding accepts measured package/plugin artifacts and derived historical evidence', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));

  assert.equal(validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: fixture.acceptance,
    artifactRoot: fixture.artifactRoot
  }), true);
  assert.equal(computeContentIdentityDigest(fixture.identity), fixture.identity.contentDigest);
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: fixture.root, encoding: 'utf8' }), '');
});

test('Git-derived identity covers root controls and reusable workflow paths', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const paths = new Set(fixture.identity.includedFiles.map((entry) => entry.path));
  for (const requiredPath of ['.gitattributes', '.gitignore', '.npmrc', '.npmignore', 'UNEXPECTED-ROOT-CONFIG.toml', '.github/workflows/reusable-fixture.yml', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md']) {
    assert.equal(paths.has(requiredPath), true, `identity must include ${requiredPath}`);
  }
  assert.equal(fixture.identity.gitScope.pathSource, 'git-ls-tree');
  assert.equal(fixture.identity.gitScope.trackedPaths.includes('.github/workflows/reusable-fixture.yml'), true);
  assert.equal(fixture.identity.includedFiles.some((entry) => entry.path === CLEAN_IDENTITY_PATH), false);
});

test('Git scope rejects omitted reusable workflows and missing tracked paths', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  for (const omittedPath of ['.github/workflows/reusable-fixture.yml', '.npmrc', 'UNEXPECTED-ROOT-CONFIG.toml']) {
    const tampered = structuredClone(fixture.identity);
    tampered.gitScope.trackedPaths = tampered.gitScope.trackedPaths.filter((entry) => entry !== omittedPath);
    tampered.contentDigest = computeContentIdentityDigest(tampered);
    assert.throws(() => validateCleanEvidenceBinding({
      repositoryRoot: fixture.root,
      identity: tampered,
      acceptance: fixture.acceptance,
      artifactRoot: fixture.artifactRoot
    }), /tracked path universe is incomplete or stale/);
  }
});

test('fresh evidence requires concrete verifier-owned operation outputs', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const acceptance = structuredClone(fixture.acceptance);
  acceptance.evidenceDisposition = freshDisposition(fixture);
  assert.equal(validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance,
    artifactRoot: fixture.artifactRoot
  }), true);

  const proseOnly = structuredClone(acceptance);
  proseOnly.evidenceDisposition.records = [];
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: proseOnly, artifactRoot: fixture.artifactRoot }), /fresh evidence records are incomplete/);

  const missingOutput = structuredClone(acceptance);
  delete missingOutput.evidenceDisposition.records[0].output;
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: missingOutput, artifactRoot: fixture.artifactRoot }), /fresh evidence output is missing/);

  const staleOutput = structuredClone(acceptance);
  staleOutput.evidenceDisposition.records[0].output.sha256 = '0'.repeat(64);
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: staleOutput, artifactRoot: fixture.artifactRoot }), /fresh evidence output digest is stale/);

  const wrongProducer = structuredClone(acceptance);
  wrongProducer.evidenceDisposition.records[0].producer.id = 'untrusted.fixture';
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: wrongProducer, artifactRoot: fixture.artifactRoot }), /fresh evidence producer is invalid/);

  const packageJsonForAll = structuredClone(acceptance);
  packageJsonForAll.evidenceDisposition.records = packageJsonForAll.evidenceDisposition.records.map((record) => ({
    ...record,
    evidenceLocation: [{ path: 'package.json', locator: 'json: $.files' }]
  }));
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: packageJsonForAll, artifactRoot: fixture.artifactRoot }), /evidence locations are not operation-bound/);

  const staleInput = structuredClone(acceptance);
  staleInput.evidenceDisposition.records[0].inputIdentity[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: staleInput, artifactRoot: fixture.artifactRoot }), /fresh evidence records are not the output/);

  const promoted = structuredClone(acceptance);
  promoted.evidenceDisposition.records[0].observedResult.runtimeObserved = true;
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: promoted, artifactRoot: fixture.artifactRoot }), /runtimeObserved must be false/);

  const unrelated = structuredClone(acceptance);
  unrelated.evidenceDisposition.records[0].recordId = 'UNRELATED';
  assert.throws(() => validateCleanEvidenceBinding({ repositoryRoot: fixture.root, identity: fixture.identity, acceptance: unrelated, artifactRoot: fixture.artifactRoot }), /fresh evidence record is unrelated/);
});

test('fresh package evidence does not resolve npm through caller PATH', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-fake-npm-'));
  t.after(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
  const marker = path.join(fakeRoot, 'invoked');
  const fakeNpm = path.join(fakeRoot, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nprintf invoked > "$LINMAS_FAKE_NPM_MARKER"\nexit 99\n', { mode: 0o755 });

  const output = execFileSync(process.execPath, [
    path.join(fixture.root, 'scripts/evidence-operations.mjs'),
    '--mode', 'collect',
    '--root-dir', fixture.root,
    '--artifact-root', fixture.artifactRoot,
    '--package-path', fixture.acceptance.artifactBinding.package.path,
    '--plugin-path', fixture.acceptance.artifactBinding.plugin.path
  ], {
    cwd: fixture.root,
    env: {
      ...process.env,
      PATH: `${fakeRoot}${path.delimiter}${process.env.PATH}`,
      LINMAS_FAKE_NPM_MARKER: marker
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  const collected = JSON.parse(output);
  const packageRecord = collected.disposition.records.find((entry) => entry.recordId === 'R090-PACKAGE-001');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(packageRecord.observedResult.result.execution.runner, 'node-execfile-fixed-v1');
  assert.equal(packageRecord.observedResult.result.execution.environmentPolicy, 'sanitized-fixed-v1');
  assert.equal(packageRecord.observedResult.result.execution.networkPolicy, 'offline');
});

test('clean binding rejects an absent package artifact and an absent plugin tree', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  fs.rmSync(path.join(fixture.artifactRoot, fixture.acceptance.artifactBinding.package.path));
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: fixture.acceptance,
    artifactRoot: fixture.artifactRoot
  }), /ENOENT|unavailable/);

  const second = createFixture();
  t.after(() => cleanup(second));
  fs.rmSync(path.join(second.artifactRoot, second.acceptance.artifactBinding.plugin.path), { recursive: true, force: true });
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: second.root,
    identity: second.identity,
    acceptance: second.acceptance,
    artifactRoot: second.artifactRoot
  }), /ENOENT|unavailable|plugin artifact/);
});

test('artifact validation rejects changed bytes, wrong metadata, and entry-count mismatches', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const packagePath = path.join(fixture.artifactRoot, fixture.acceptance.artifactBinding.package.path);
  const changed = fs.readFileSync(packagePath);
  changed[0] ^= 0xff;
  fs.writeFileSync(packagePath, changed);
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: fixture.acceptance,
    artifactRoot: fixture.artifactRoot
  }), /valid gzip tarball|package artifact/);

  const second = createFixture();
  t.after(() => cleanup(second));
  second.acceptance.artifactBinding.package.packageName = 'wrong-name';
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: second.root,
    identity: second.identity,
    acceptance: second.acceptance,
    artifactRoot: second.artifactRoot
  }), /artifactBinding package metadata/);

  const metadata = createFixture();
  t.after(() => cleanup(metadata));
  metadata.acceptance.artifactBinding.package.packageVersion = '9.9.9';
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: metadata.root,
    identity: metadata.identity,
    acceptance: metadata.acceptance,
    artifactRoot: metadata.artifactRoot
  }), /artifactBinding package metadata/);

  const third = createFixture();
  t.after(() => cleanup(third));
  third.acceptance.artifactBinding.package.bytes += 1;
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: third.root,
    identity: third.identity,
    acceptance: third.acceptance,
    artifactRoot: third.artifactRoot
  }), /package artifact bytes/);

  const fourth = createFixture();
  t.after(() => cleanup(fourth));
  fourth.acceptance.artifactBinding.package.entryCount += 1;
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: fourth.root,
    identity: fourth.identity,
    acceptance: fourth.acceptance,
    artifactRoot: fourth.artifactRoot
  }), /package artifact entryCount/);
});

test('artifact validation rejects an unsafe tar symlink and a plugin tree mismatch', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-unsafe-tar-'));
  t.after(() => fs.rmSync(unsafeRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(unsafeRoot, 'package'));
  fs.copyFileSync(path.join(fixture.root, 'package.json'), path.join(unsafeRoot, 'package', 'package.json'));
  fs.symlinkSync('package.json', path.join(unsafeRoot, 'package', 'link'));
  const unsafeArchive = path.join(unsafeRoot, 'unsafe.tgz');
  execFileSync('tar', ['--format=ustar', '-czf', unsafeArchive, '-C', unsafeRoot, 'package'], { stdio: 'ignore' });
  assert.throws(() => measurePackageArtifact({
    repositoryRoot: fixture.root,
    artifactPath: unsafeArchive,
    expectedVersion: CURRENT_VERSION
  }), /non-regular entry/);

  const pluginFile = path.join(fixture.artifactRoot, fixture.acceptance.artifactBinding.plugin.path, 'package.json');
  fs.appendFileSync(pluginFile, ' ');
  assert.throws(() => measureReleaseArtifacts({
    repositoryRoot: fixture.root,
    artifactRoot: fixture.artifactRoot,
    packagePath: fixture.acceptance.artifactBinding.package.path,
    pluginPath: fixture.acceptance.artifactBinding.plugin.path,
    expectedVersion: CURRENT_VERSION
  }), /plugin artifact differs/);
});

test('artifact paths must remain in an external tool-owned root', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  assert.throws(() => measureReleaseArtifacts({
    repositoryRoot: fixture.root,
    artifactRoot: fixture.root,
    packagePath: fixture.acceptance.artifactBinding.package.path,
    pluginPath: fixture.acceptance.artifactBinding.plugin.path,
    expectedVersion: CURRENT_VERSION
  }), /outside the repository checkout/);
});

test('artifact verification keeps measured artifacts read-only and uses separate scratch', (t) => {
  const fixture = createFixture();
  t.after(() => {
    for (const current of fs.readdirSync(fixture.artifactRoot, { recursive: true }).map((entry) => path.join(fixture.artifactRoot, entry)).reverse()) {
      const item = fs.lstatSync(current);
      fs.chmodSync(current, item.isDirectory() ? 0o700 : 0o600);
    }
    fs.chmodSync(fixture.artifactRoot, 0o700);
    cleanup(fixture);
  });
  for (const current of fs.readdirSync(fixture.artifactRoot, { recursive: true }).map((entry) => path.join(fixture.artifactRoot, entry)).reverse()) {
    const item = fs.lstatSync(current);
    fs.chmodSync(current, item.isDirectory() ? 0o500 : 0o400);
  }
  fs.chmodSync(fixture.artifactRoot, 0o500);
  const artifactInventory = () => fs.readdirSync(fixture.artifactRoot, { recursive: true }).sort().map((relativePath) => {
    const current = path.join(fixture.artifactRoot, relativePath);
    const item = fs.lstatSync(current);
    assert.equal(item.isSymbolicLink(), false, 'measured artifact inventory must not contain symlinks');
    if (item.isDirectory()) return { path: relativePath, type: 'directory' };
    assert.equal(item.isFile(), true, 'measured artifact inventory must contain regular files');
    const bytes = fs.readFileSync(current);
    return { path: relativePath, type: 'file', bytes: bytes.length, sha256: sha256(bytes) };
  });
  const beforeMeasurement = artifactInventory();
  if (process.platform === 'win32') {
    // Windows directory chmod is not a directory-create denial mechanism.
    const measuredPackage = path.join(fixture.artifactRoot, fixture.acceptance.artifactBinding.package.path);
    assert.throws(() => {
      let descriptor;
      try {
        descriptor = fs.openSync(measuredPackage, 'r+');
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }, (error) => error?.code === 'EACCES' || error?.code === 'EPERM');
  } else {
    assert.throws(() => fs.writeFileSync(path.join(fixture.artifactRoot, 'write-probe'), 'denied'), /EACCES/);
  }
  const measured = measureReleaseArtifacts({
    repositoryRoot: fixture.root,
    artifactRoot: fixture.artifactRoot,
    packagePath: fixture.acceptance.artifactBinding.package.path,
    pluginPath: fixture.acceptance.artifactBinding.plugin.path,
    expectedVersion: CURRENT_VERSION
  });
  assert.equal(measured.package.sha256, fixture.acceptance.artifactBinding.package.sha256);
  assert.equal(measured.plugin.contentDigest, fixture.acceptance.artifactBinding.plugin.contentDigest);
  assert.deepEqual(artifactInventory(), beforeMeasurement, 'measurement must not mutate artifacts or create scratch files in the artifact root');
});

test('identity rejects self-declared scope and extra digest exclusions', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const extraScope = structuredClone(fixture.identity);
  extraScope.coveredPaths = [...extraScope.coveredPaths, 'docs'];
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: extraScope,
    acceptance: fixture.acceptance,
    artifactRoot: fixture.artifactRoot
  }), /duplicate path|coveredPaths do not match/);

  const extraExclusion = structuredClone(fixture.identity);
  extraExclusion.excludedFromDigest = [CLEAN_IDENTITY_PATH, 'docs/compatibility/COMPATIBILITY.md'];
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: extraExclusion,
    acceptance: fixture.acceptance,
    artifactRoot: fixture.artifactRoot
  }), /minimal exclusion/);
});

test('historical reuse rejects an unrelated JSON source and derives source linkage', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const unrelatedPath = path.join(fixture.root, 'docs/compatibility/evidence/unrelated.json');
  writeJson(unrelatedPath, { schemaVersion: 1, status: 'UNRELEASED' });
  refreshIdentity(fixture);
  const unrelated = structuredClone(fixture.acceptance);
  unrelated.evidenceDisposition.sourceRecordPath = 'docs/compatibility/evidence/unrelated.json';
  unrelated.evidenceDisposition.sourceRecordSha256 = sha256(fs.readFileSync(unrelatedPath));
  assert.throws(() => validateDiagnosticSource({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: unrelated,
    artifactRoot: fixture.artifactRoot,
  }), /canonical v0.9.0 evidence record/);

  const linkage = readJson(path.join(fixture.root, RECORD_PATH));
  linkage.candidate.sourceRevision = `HEAD ${'f'.repeat(40)} + dirty snapshot sha256:${linkage.candidate.snapshot.digest}`;
  writeJson(path.join(fixture.root, RECORD_PATH), linkage);
  refreshIdentity(fixture);
  fixture.acceptance.evidenceDisposition.sourceRecordSha256 = sha256(fs.readFileSync(path.join(fixture.root, RECORD_PATH)));
  assert.throws(() => validateDiagnosticSource({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: fixture.acceptance,
    artifactRoot: fixture.artifactRoot,
  }), /source revision does not match candidate HEAD/);
});

test('historical eligible records reject placeholders and unrelated locators', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));

  const placeholderAcceptance = structuredClone(fixture.acceptance);
  const placeholderRecord = readJson(path.join(fixture.root, RECORD_PATH));
  placeholderRecord.records.find((entry) => entry.recordId === 'R090-MCP-01').observedResult.summary = 'TODO evidence';
  writeJson(path.join(fixture.root, RECORD_PATH), placeholderRecord);
  placeholderAcceptance.evidenceDisposition.sourceRecordSha256 = sha256(fs.readFileSync(path.join(fixture.root, RECORD_PATH)));
  assert.throws(() => validateDiagnosticSource({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: placeholderAcceptance,
    artifactRoot: fixture.artifactRoot,
  }), /historical eligible evidence summary is not derived from its result/);

  const locatorFixture = createFixture();
  t.after(() => cleanup(locatorFixture));
  const locatorAcceptance = structuredClone(locatorFixture.acceptance);
  const locatorRecord = readJson(path.join(locatorFixture.root, RECORD_PATH));
  locatorRecord.records.find((entry) => entry.recordId === 'R090-MCP-01').evidenceLocation = [{ path: 'package.json', locator: 'json: $.files' }];
  writeJson(path.join(locatorFixture.root, RECORD_PATH), locatorRecord);
  locatorAcceptance.evidenceDisposition.sourceRecordSha256 = sha256(fs.readFileSync(path.join(locatorFixture.root, RECORD_PATH)));
  assert.throws(() => validateDiagnosticSource({
    repositoryRoot: locatorFixture.root,
    identity: locatorFixture.identity,
    acceptance: locatorAcceptance,
    artifactRoot: locatorFixture.artifactRoot,
  }), /evidence locations are not operation-bound/);
});

test('historical artifact identity is tied to the measured package and plugin', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));

  const fabricated = structuredClone(fixture.acceptance);
  const record = readJson(path.join(fixture.root, RECORD_PATH));
  record.candidate.packageArtifact.bytes += 1;
  record.candidate.pluginParity.contentDigest = '0'.repeat(64);
  writeJson(path.join(fixture.root, RECORD_PATH), record);
  fabricated.evidenceDisposition.sourceRecordSha256 = sha256(fs.readFileSync(path.join(fixture.root, RECORD_PATH)));
  assert.throws(() => validateDiagnosticSource({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: fabricated,
    artifactRoot: fixture.artifactRoot,
  }), /historical package artifact bytes does not match the actual artifact binding/);

  const versionFixture = createFixture();
  t.after(() => cleanup(versionFixture));
  const versionRecord = readJson(path.join(versionFixture.root, RECORD_PATH));
  versionRecord.candidate.packageVersion = '9.9.9';
  versionRecord.candidate.pluginVersion = '9.9.9';
  writeJson(path.join(versionFixture.root, RECORD_PATH), versionRecord);
  const versionAcceptance = structuredClone(versionFixture.acceptance);
  versionAcceptance.evidenceDisposition.sourceRecordSha256 = sha256(fs.readFileSync(path.join(versionFixture.root, RECORD_PATH)));
  assert.throws(() => validateDiagnosticSource({
    repositoryRoot: versionFixture.root,
    identity: versionFixture.identity,
    acceptance: versionAcceptance,
    artifactRoot: versionFixture.artifactRoot,
  }), /historical package version does not match the actual artifact binding/);

  const mutatedBinding = structuredClone(fixture.acceptance);
  mutatedBinding.artifactBinding.plugin.contentDigest = '1'.repeat(64);
  mutatedBinding.evidenceDisposition.artifactBindingDigest = computeArtifactBindingDigest(mutatedBinding.artifactBinding);
  assert.notEqual(mutatedBinding.evidenceDisposition.artifactBindingDigest, fixture.acceptance.evidenceDisposition.artifactBindingDigest);
  assert.throws(() => validateDiagnosticSource({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: mutatedBinding,
    artifactRoot: fixture.artifactRoot,
  }), /plugin artifact contentDigest/);
});

test('historical identity normalization derives names, accepts an explicit schema, and rejects contradictions', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const sourceBytes = fs.readFileSync(path.join(fixture.root, RECORD_PATH));
  const legacy = deriveHistoricalEvidence({
    repositoryRoot: fixture.root,
    sourceBytes,
    identity: fixture.identity,
    artifactBinding: fixture.acceptance.artifactBinding
  });
  assert.deepEqual(legacy.normalizedHistoricalIdentity, {
    schemaVersion: 1,
    sourceSchemaVersion: 1,
    normalization: 'measured-artifact-v1',
    package: { name: 'linmas', version: CURRENT_VERSION },
    plugin: { name: 'linmas', version: CURRENT_VERSION }
  });

  const explicitRecord = readJson(path.join(fixture.root, RECORD_PATH));
  explicitRecord.candidate.identitySchemaVersion = 2;
  explicitRecord.candidate.packageArtifact.packageName = 'linmas';
  explicitRecord.candidate.packageArtifact.packageVersion = CURRENT_VERSION;
  explicitRecord.candidate.pluginParity.pluginName = 'linmas';
  explicitRecord.candidate.pluginParity.pluginVersion = CURRENT_VERSION;
  const explicit = deriveHistoricalEvidence({
    repositoryRoot: fixture.root,
    sourceBytes: Buffer.from(`${JSON.stringify(explicitRecord)}\n`),
    identity: fixture.identity,
    artifactBinding: fixture.acceptance.artifactBinding
  });
  assert.equal(explicit.normalizedHistoricalIdentity.sourceSchemaVersion, 2);
  assert.notEqual(explicit.evidenceDigest, legacy.evidenceDigest);

  const wrongName = structuredClone(explicitRecord);
  wrongName.candidate.packageArtifact.packageName = 'not-linmas';
  assert.throws(() => deriveHistoricalEvidence({
    repositoryRoot: fixture.root,
    sourceBytes: Buffer.from(`${JSON.stringify(wrongName)}\n`),
    identity: fixture.identity,
    artifactBinding: fixture.acceptance.artifactBinding
  }), /historical package name does not match/);

  const missingExplicitName = structuredClone(explicitRecord);
  delete missingExplicitName.candidate.pluginParity.pluginName;
  assert.throws(() => deriveHistoricalEvidence({
    repositoryRoot: fixture.root,
    sourceBytes: Buffer.from(`${JSON.stringify(missingExplicitName)}\n`),
    identity: fixture.identity,
    artifactBinding: fixture.acceptance.artifactBinding
  }), /schema 2 requires explicit/);

  const contradictoryAlias = structuredClone(explicitRecord);
  contradictoryAlias.candidate.pluginParity.packageName = 'not-linmas';
  assert.throws(() => deriveHistoricalEvidence({
    repositoryRoot: fixture.root,
    sourceBytes: Buffer.from(`${JSON.stringify(contradictoryAlias)}\n`),
    identity: fixture.identity,
    artifactBinding: fixture.acceptance.artifactBinding
  }), /unknown identity field/);
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, RECORD_PATH)), sourceBytes);
});

test('the disposable historical record remains explicitly dirty and source-bound', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const record = readJson(path.join(fixture.root, RECORD_PATH));
  assert.equal(record.candidate.workingTreeState, 'dirty');
  assert.match(record.candidate.sourceRevision, /^HEAD [a-f0-9]{40} \+ dirty snapshot sha256:[a-f0-9]{64}$/u);
  assert.equal(record.candidate.implementationHead, fixture.baseImplementationHead);
});

test('dirty preparation uses diagnostic schema and cannot enter the clean consumer', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  fs.mkdirSync(path.join(fixture.root, '.local-agent'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.local-agent/diagnostic-overlay.txt'), 'private diagnostic state\n');
  refreshIdentity(fixture);
  const sourceBytes = fs.readFileSync(path.join(fixture.root, RECORD_PATH));
  const derived = deriveHistoricalEvidence({
    repositoryRoot: fixture.root,
    sourceBytes,
    identity: fixture.identity,
    artifactBinding: fixture.acceptance.artifactBinding
  });
  fixture.acceptance.evidenceDisposition = {
    mode: 'historical-reuse',
    applicability: 'Diagnostic fixture for the exact dirty overlay.',
    sourceRecordPath: RECORD_PATH,
    sourceRecordSha256: sha256(sourceBytes),
    artifactBindingDigest: computeArtifactBindingDigest(fixture.acceptance.artifactBinding),
    ...derived
  };
  const diagnostic = buildDiagnosticEvidenceBinding({
    repositoryRoot: fixture.root,
    acceptance: fixture.acceptance
  });
  assert.equal(diagnostic.bindingKind, 'diagnostic-candidate-evidence');
  assert.equal(diagnostic.status, 'PREPARATION_ONLY');
  assert.equal(diagnostic.workingTreeState, 'dirty');
  assert.match(diagnostic.gitStatus, /diagnostic-overlay\.txt/);
  assert.equal(validateDiagnosticEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    diagnostic,
    artifactRoot: fixture.artifactRoot
  }), true);
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: diagnostic,
    artifactRoot: fixture.artifactRoot
  }), /binding kind/);
  assert.throws(() => validateCleanEvidenceBinding({
    repositoryRoot: fixture.root,
    identity: fixture.identity,
    acceptance: fixture.acceptance,
    artifactRoot: fixture.artifactRoot,
    requireClean: false
  }), /not a clean-acceptance operation/);
});

test('disposable historical evidence derives the 23 eligible records and excludes UNKNOWN runtime records', (t) => {
  const fixture = createFixture();
  t.after(() => cleanup(fixture));
  const identity = fixture.identity;
  const record = readJson(path.join(fixture.root, RECORD_PATH));
  const sourceBytes = fs.readFileSync(path.join(fixture.root, RECORD_PATH));
  const derived = deriveHistoricalEvidence({ repositoryRoot: fixture.root, sourceBytes, identity, artifactBinding: fixture.acceptance.artifactBinding });
  assert.equal(derived.evidenceClass, 'source-and-deterministic-fixture-v1');
  assert.equal(derived.eligibleRecordIds.length, 23);
  assert.equal(derived.eligibleOperations.length, 23);
  assert.equal(record.records.length, 31);
  assert.equal(record.records.filter((entry) => entry.evidenceKind === 'actual-runtime-loading' || entry.evidenceKind === 'live-model-evaluation').length, 8);
  assert.ok(record.records.filter((entry) => entry.evidenceKind === 'actual-runtime-loading' || entry.evidenceKind === 'live-model-evaluation')
    .every((entry) => entry.observedResult.status === 'UNKNOWN' && entry.observedResult.runtimeObserved === false));

  const promoted = structuredClone(record);
  const runtime = promoted.records.find((entry) => entry.evidenceKind === 'actual-runtime-loading');
  runtime.observedResult.status = 'PASS';
  runtime.observedResult.runtimeObserved = true;
  assert.throws(() => deriveHistoricalEvidence({ repositoryRoot: fixture.root, sourceBytes: Buffer.from(`${JSON.stringify(promoted)}\n`), identity, artifactBinding: fixture.acceptance.artifactBinding }), /historical runtime evidence is promoted/);

  const changedIdentity = structuredClone(identity);
  changedIdentity.includedFiles = changedIdentity.includedFiles.filter((entry) => entry.path !== 'README.md');
  assert.throws(() => deriveHistoricalEvidence({ repositoryRoot: fixture.root, sourceBytes, identity: changedIdentity, artifactBinding: fixture.acceptance.artifactBinding }), /relevant scope does not match/);
});
