#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { loadCapsuleEvidence } from '../src/proof/load-evidence.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { createLinmasDispatcher } from '../mcp/server.mjs';
import { PUBLIC_SKILL_IDS, resolveSkill } from '../src/core/skill-catalog.mjs';
import { createClaudeRunner } from '../src/providers/claude-api.mjs';
import { applyUninstallPlan, SAFE_FILESYSTEM_OPERATION_UNAVAILABLE } from '../src/core/uninstall-skills.mjs';
import {
  measurePackageArtifact,
  measurePluginParity,
  measureReleaseArtifacts
} from './artifact-integrity.mjs';
import { assertTrustedGitAvailable, createExplicitChildEnvironment, CHILD_ENVIRONMENT_POLICY } from './child-environment.mjs';

export const EVIDENCE_PRODUCER_ID = 'linmas.irsa003.local-operations';
export const EVIDENCE_PRODUCER_VERSION = '1';
export const EVIDENCE_PRODUCER_EXECUTION = 'bounded-local-operations-v2';
export const EVIDENCE_RESULT_SCHEMA_VERSION = 1;
export const EVIDENCE_OPERATION_TIMEOUT_MS = 120_000;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const TEST_PATH = 'tests/mcp-server.test.mjs';
const SAFETY_BOUNDARY = Object.freeze({
  satisfied: true,
  humanReviewRequired: true,
  statement: 'Human review remains required.'
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function currentPackageVersion(rootDir) {
  const packageJson = readJson(rootDir, 'package.json');
  if (packageJson.name !== 'linmas' || !VERSION.test(packageJson.version)) throw new Error('current package version is invalid');
  return packageJson.version;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function location(pathName, locator) {
  return Object.freeze({ path: pathName, locator });
}

function contract({
  recordId,
  operation,
  evidenceKind,
  expectedStatus,
  producerId,
  resultSchema,
  expectedSummary,
  observedSummary,
  locations,
  inputPaths
}) {
  return Object.freeze({
    recordId,
    operation,
    evidenceKind,
    expectedStatus,
    producerId,
    resultSchema,
    expectedSummary,
    observedSummary,
    locations: Object.freeze(locations),
    inputPaths: Object.freeze(inputPaths)
  });
}

const SKILL_CONTRACTS = PUBLIC_SKILL_IDS.map((skillId, index) => contract({
  recordId: `R090-SKILL-${String(index + 1).padStart(2, '0')}`,
  operation: `skill:${skillId}:catalog`,
  evidenceKind: 'source-inspection',
  expectedStatus: 'PASS',
  producerId: 'linmas.irsa003.skill-source-v1',
  resultSchema: 'skill-source-v1',
  expectedSummary: `The canonical source catalog contains ${skillId} and its public skill file exists.`,
  observedSummary: `The canonical source catalog contains ${skillId} and its public skill file exists.`,
  locations: [
    location(`skills/${skillId}/SKILL.md`, 'file: SKILL.md'),
    location('src/core/skill-catalog.mjs', 'text: PUBLIC_SKILL_IDS')
  ],
  inputPaths: [`skills/${skillId}/SKILL.md`, 'src/core/skill-catalog.mjs']
}));

const MCP_CONTRACTS = [
  contract({
    recordId: 'R090-MCP-01',
    operation: 'mcp:linmas_review_prepare',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.mcp-review-prepare-v1',
    resultSchema: 'mcp-review-prepare-v1',
    expectedSummary: 'Offline preparation returns a bounded request without provider execution or writes.',
    observedSummary: 'Offline preparation returns a bounded request without provider execution or writes.',
    locations: [location(TEST_PATH, 'test: offline prepare is read-only and returns prepared plus human-review state'), location('docs/linmas-mcp-validation-runbook.md', 'tool: linmas_review_prepare')],
    inputPaths: ['mcp/server.mjs', 'src/review/prepare-review.mjs', 'src/core/skill-catalog.mjs']
  }),
  contract({
    recordId: 'R090-MCP-02',
    operation: 'mcp:linmas_review_compare',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.mcp-review-compare-v1',
    resultSchema: 'mcp-review-compare-v1',
    expectedSummary: 'Offline capsule comparison validates local evidence and keeps remediation limits visible.',
    observedSummary: 'Offline capsule comparison validates local evidence and keeps remediation limits visible.',
    locations: [location(TEST_PATH, 'test: offline compare, policy evaluate, and proof verify return verified bounded results'), location('docs/linmas-mcp-validation-runbook.md', 'tool: linmas_review_compare')],
    inputPaths: ['mcp/server.mjs', 'src/review/compare-capsules.mjs', 'src/review/build-capsule.mjs']
  }),
  contract({
    recordId: 'R090-MCP-03',
    operation: 'mcp:linmas_policy_evaluate',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.mcp-policy-evaluate-v1',
    resultSchema: 'mcp-policy-evaluate-v1',
    expectedSummary: 'Offline policy evaluation returns a deterministic policy result that still requires human review.',
    observedSummary: 'Offline policy evaluation returns a deterministic policy result that still requires human review.',
    locations: [location(TEST_PATH, 'test: offline compare, policy evaluate, and proof verify return verified bounded results'), location('docs/linmas-mcp-validation-runbook.md', 'tool: linmas_policy_evaluate')],
    inputPaths: ['mcp/server.mjs', 'src/policy/evaluate-policy.mjs', 'policies/baseline-appsec.json']
  }),
  contract({
    recordId: 'R090-MCP-04',
    operation: 'mcp:linmas_proof_verify',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.mcp-proof-verify-v1',
    resultSchema: 'mcp-proof-verify-v1',
    expectedSummary: 'Offline proof verification checks integrity and source binding without proving author identity or correctness.',
    observedSummary: 'Offline proof verification checks integrity and source binding without proving author identity or correctness.',
    locations: [location(TEST_PATH, 'test: offline compare, policy evaluate, and proof verify return verified bounded results'), location('docs/linmas-mcp-validation-runbook.md', 'tool: linmas_proof_verify')],
    inputPaths: ['mcp/server.mjs', 'src/proof/verify-bundle.mjs', 'src/proof/write-bundle.mjs']
  }),
  contract({
    recordId: 'R090-MCP-05',
    operation: 'mcp:linmas_proof_create',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.mcp-proof-create-v1',
    resultSchema: 'mcp-proof-create-v1',
    expectedSummary: 'Proof creation requires explicit local write confirmation.',
    observedSummary: 'Proof creation requires explicit local write confirmation.',
    locations: [location(TEST_PATH, 'test: proof create requires explicit write confirmation and verifies its own result'), location('docs/linmas-mcp-validation-runbook.md', 'tool: linmas_proof_create')],
    inputPaths: ['mcp/server.mjs', 'src/proof/write-bundle.mjs', 'src/proof/verify-bundle.mjs']
  }),
  contract({
    recordId: 'R090-MCP-06',
    operation: 'mcp:linmas_review_execute',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.mcp-review-execute-v1',
    resultSchema: 'mcp-review-execute-v1',
    expectedSummary: 'Provider execution is prepared without consent and only the injected fixture runs after explicit transmission consent.',
    observedSummary: 'Provider execution is prepared without consent and only the injected fixture runs after explicit transmission consent.',
    locations: [location(TEST_PATH, 'test: review execute is prepared without consent and only executes a mocked provider after consent'), location('docs/linmas-mcp-validation-runbook.md', 'tool: linmas_review_execute')],
    inputPaths: ['mcp/server.mjs', 'src/providers/registry.mjs', 'src/review/run-review.mjs']
  }),
  contract({
    recordId: 'R090-MCP-07',
    operation: 'mcp:linmas_review_decide',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.mcp-review-decide-v1',
    resultSchema: 'mcp-review-decide-v1',
    expectedSummary: 'Human disposition uses the bound handle and exact capsule digest; altered or restarted references are rejected.',
    observedSummary: 'Human disposition uses the bound handle and exact capsule digest; altered or restarted references are rejected.',
    locations: [location(TEST_PATH, 'test: F-006 decision gate rejects tampered review references and uses immutable severity'), location('docs/linmas-mcp-validation-runbook.md', 'tool: linmas_review_decide')],
    inputPaths: ['mcp/server.mjs', 'src/proof/validate-receipt.mjs']
  })
];

const OTHER_CONTRACTS = [
  contract({
    recordId: 'R090-PROVENANCE',
    operation: 'baseline:provenance',
    evidenceKind: 'source-inspection',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.provenance-v1',
    resultSchema: 'baseline-provenance-v1',
    expectedSummary: 'Implementation HEAD, 0.8.0 baseline commit/tag, package version, and local environment are recorded.',
    observedSummary: 'Implementation HEAD, 0.8.0 baseline commit/tag, package version, and local environment are recorded.',
    locations: [location('docs/roadmap/versions/v0.9.0.md', 'heading: 12. Implementation Checklist'), location('package.json', 'json: $.version')],
    inputPaths: ['docs/roadmap/versions/v0.9.0.md', 'package.json', 'package-lock.json', 'plugins/linmas/package.json', 'plugins/linmas/.codex-plugin/plugin.json']
  }),
  contract({
    recordId: 'R090-PACKAGE-001',
    operation: 'package:inventory',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.package-inventory-v1',
    resultSchema: 'npm-package-inventory-v1',
    expectedSummary: 'The package inventory is checked for expected runtime files and excluded development/private paths.',
    observedSummary: null,
    locations: [location('package.json', 'json: $.files'), location('tests/codex-plugin-build.test.mjs', 'test: npm packed artifact contains builder inputs and builds a validated plugin without internal files')],
    inputPaths: ['package.json', 'package-lock.json']
  }),
  contract({
    recordId: 'R090-PLUGIN-001',
    operation: 'plugin:canonical-parity',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.plugin-parity-v1',
    resultSchema: 'codex-plugin-parity-v1',
    expectedSummary: 'The generated plugin is compared with canonical source and the exact skill/tool inventory.',
    observedSummary: 'The generated plugin is compared with canonical source and the exact skill/tool inventory.',
    locations: [location('scripts/build-codex-plugin.mjs', 'text: buildPlugin'), location('tests/codex-plugin-build.test.mjs', 'test: public Git marketplace exposes a byte-identical validated Linmas plugin')],
    inputPaths: ['plugin', '.mcp.json', 'mcp', 'src', 'policies', 'skills']
  }),
  contract({
    recordId: 'R090-PROVIDER-CLAUDE',
    operation: 'provider-fixture:claude-api',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'PASS',
    producerId: 'linmas.irsa003.claude-api-fixture-v1',
    resultSchema: 'claude-api-fixture-v1',
    expectedSummary: 'The Claude API adapter preserves bounded provider error and response contracts under injected fixtures.',
    observedSummary: 'Injected Claude provider fixtures pass the adapter contract without a live model call.',
    locations: [location('tests/claude-provider.test.mjs', 'test: Claude runner sends explicit headers/model and returns usage')],
    inputPaths: ['src/providers/claude-api.mjs']
  }),
  contract({
    recordId: 'R090-WINDOWS-001',
    operation: 'windows:destructive-uninstall',
    evidenceKind: 'deterministic-fixture',
    expectedStatus: 'UNSUPPORTED',
    producerId: 'linmas.irsa003.windows-denial-v1',
    resultSchema: 'windows-destructive-denial-v1',
    expectedSummary: 'Destructive Windows operation must fail closed with SAFE_FILESYSTEM_OPERATION_UNAVAILABLE.',
    observedSummary: 'Injected Windows denial fixture reports SAFE_FILESYSTEM_OPERATION_UNAVAILABLE.',
    locations: [location('tests/windows-security.test.mjs', 'test: WIN-F001-UNINSTALL rejects before a substituted root can mutate an external object'), location('src/core/uninstall-skills.mjs', 'text: SAFE_FILESYSTEM_OPERATION_UNAVAILABLE')],
    inputPaths: ['src/core/uninstall-skills.mjs', 'tests/windows-security.test.mjs']
  })
];

const CONTRACTS = Object.freeze([...MCP_CONTRACTS, ...OTHER_CONTRACTS, ...SKILL_CONTRACTS].sort((left, right) => left.recordId.localeCompare(right.recordId)));
const CONTRACT_BY_ID = new Map(CONTRACTS.map((item) => [item.recordId, item]));
const CONTRACT_BY_OPERATION = new Map(CONTRACTS.map((item) => [item.operation, item]));

export const EVIDENCE_OPERATION_CONTRACTS = CONTRACTS;
export const REQUIRED_OPERATION_RECORD_IDS = Object.freeze(CONTRACTS.map((item) => item.recordId));

export function getEvidenceContract(recordId) {
  return CONTRACT_BY_ID.get(recordId) ?? null;
}

export function getEvidenceContractByOperation(operation) {
  return CONTRACT_BY_OPERATION.get(operation) ?? null;
}

function isSafeRelativePath(relativePath) {
  return typeof relativePath === 'string'
    && relativePath.length > 0
    && !relativePath.includes('\\')
    && !relativePath.includes('\0')
    && !path.posix.isAbsolute(relativePath)
    && relativePath.split('/').every((part) => part && part !== '.' && part !== '..');
}

function resolveInside(rootDir, relativePath) {
  if (!isSafeRelativePath(relativePath)) throw new Error(`unsafe evidence path: ${relativePath}`);
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...relativePath.split('/'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`evidence path escapes root: ${relativePath}`);
  return target;
}

function fileIdentity(rootDir, relativePath) {
  const target = resolveInside(rootDir, relativePath);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`evidence input must be a regular file: ${relativePath}`);
  const bytes = fs.readFileSync(target);
  return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function treeIdentity(rootDir, relativePath) {
  const target = resolveInside(rootDir, relativePath);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`evidence input contains a symlink: ${relativePath}`);
  if (stat.isFile()) return [fileIdentity(rootDir, relativePath)];
  if (!stat.isDirectory()) throw new Error(`evidence input is not regular: ${relativePath}`);
  const entries = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    entries.push(...treeIdentity(rootDir, path.posix.join(relativePath, entry.name)));
  }
  return entries;
}

function inputIdentity(rootDir, contractItem, extra = []) {
  const paths = new Set(['scripts/evidence-operations.mjs', ...contractItem.inputPaths]);
  const entries = [...paths].flatMap((relativePath) => treeIdentity(rootDir, relativePath));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of extra) byPath.set(entry.path, entry);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function fixtureIdentity(label, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { path: `<fixture>/${label}`, bytes: value.byteLength, sha256: sha256(value) };
}

function regularFileIdentity(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${filePath} (${error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${filePath}`);
  const bytes = fs.readFileSync(filePath);
  return { path: filePath, bytes: bytes.byteLength, sha256: sha256(bytes), rawBytes: bytes };
}

function resolveTrustedNpmCli() {
  const approvedPath = process.env.LINMAS_APPROVED_NPM_CLI;
  if (typeof approvedPath !== 'string' || !path.isAbsolute(approvedPath)) throw new Error('approved npm CLI is unavailable; use the operator-installed outer launch boundary');
  return regularFileIdentity(approvedPath, 'approved npm CLI');
}

function createIsolatedNpmEnvironment(operationRoot, tool) {
  const environmentRoot = path.join(operationRoot, 'npm-environment');
  const cacheRoot = path.join(environmentRoot, 'cache');
  const userConfigPath = path.join(environmentRoot, 'user.npmrc');
  const globalConfigPath = path.join(environmentRoot, 'global.npmrc');
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(userConfigPath, '# verifier-owned empty npm user config\n', 'utf8');
  fs.writeFileSync(globalConfigPath, '# verifier-owned empty npm global config\n', 'utf8');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: environmentRoot,
    npm_config_userconfig: userConfigPath,
    npm_config_globalconfig: globalConfigPath,
    npm_config_cache: cacheRoot,
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_offline: 'true',
    npm_config_color: 'false',
    npm_config_progress: 'false'
  };
  return {
    env,
    inputIdentity: [
      fixtureIdentity('producer/node-executable', tool.node.rawBytes),
      fixtureIdentity('producer/npm-cli', tool.npmCli.rawBytes),
      fixtureIdentity('producer/user.npmrc', fs.readFileSync(userConfigPath)),
      fixtureIdentity('producer/global.npmrc', fs.readFileSync(globalConfigPath))
    ]
  };
}

function trustedNpmTool() {
  const node = regularFileIdentity(process.execPath, 'Node executable');
  const npmCli = resolveTrustedNpmCli();
  return {
    node,
    npmCli,
    execution: {
      runner: 'node-execfile-fixed-v1',
      nodePath: node.path,
      nodeBytes: node.bytes,
      nodeSha256: node.sha256,
      npmCliPath: npmCli.path,
      npmCliBytes: npmCli.bytes,
      npmCliSha256: npmCli.sha256,
      environmentPolicy: 'sanitized-fixed-v1',
      childEnvironmentPolicy: CHILD_ENVIRONMENT_POLICY,
      configPolicy: 'temporary-empty-user-and-global-config-v1',
      networkPolicy: 'offline'
    }
  };
}

function producer(contractItem) {
  return {
    id: contractItem.producerId,
    version: EVIDENCE_PRODUCER_VERSION,
    entrypoint: 'scripts/evidence-operations.mjs',
    execution: EVIDENCE_PRODUCER_EXECUTION,
    attestation: 'external-outer-launch-required'
  };
}

function outputDescriptor(value) {
  const bytes = Buffer.from(canonicalJson(value));
  return {
    schemaVersion: EVIDENCE_RESULT_SCHEMA_VERSION,
    contentType: 'application/json',
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    value
  };
}

function readJson(rootDir, relativePath) {
  return JSON.parse(fs.readFileSync(resolveInside(rootDir, relativePath), 'utf8'));
}

function packageResult(measured, repeat, execution) {
  return {
    schemaVersion: EVIDENCE_RESULT_SCHEMA_VERSION,
    operation: 'package:inventory',
    status: 'PASS',
    package: {
      filename: measured.filename,
      bytes: measured.bytes,
      entryCount: measured.entryCount,
      sha256: measured.sha256,
      inventorySha256: measured.inventorySha256,
      packageName: measured.packageName,
      packageVersion: measured.packageVersion
    },
    repeatability: {
      packCount: 2,
      byteIdentical: measured.sha256 === repeat.sha256 && measured.bytes === repeat.bytes && measured.entryCount === repeat.entryCount,
      repeatedSha256: repeat.sha256
    },
    privatePathsRejected: true,
    execution
  };
}

function pluginResult(measured, execution) {
  return {
    schemaVersion: EVIDENCE_RESULT_SCHEMA_VERSION,
    operation: 'plugin:canonical-parity',
    status: 'PASS',
    byteIdentical: true,
    fileCount: measured.fileCount,
    contentDigest: measured.contentDigest,
    packageName: measured.packageName,
    packageVersion: measured.packageVersion,
    execution
  };
}

function sourceProvenanceResult(rootDir) {
  const packageJson = readJson(rootDir, 'package.json');
  const lockJson = readJson(rootDir, 'package-lock.json');
  const pluginPackage = readJson(rootDir, 'plugins/linmas/package.json');
  const pluginManifest = readJson(rootDir, 'plugins/linmas/.codex-plugin/plugin.json');
  const roadmap = fs.readFileSync(resolveInside(rootDir, 'docs/roadmap/versions/v0.9.0.md'), 'utf8');
  const currentVersion = currentPackageVersion(rootDir);
  const values = [packageJson.version, lockJson.packages?.['']?.version, pluginPackage.version, pluginManifest.version];
  if (values.some((value) => value !== currentVersion) || !/^## 12\. Implementation Checklist$/mu.test(roadmap)) {
    throw new Error('provenance operation did not satisfy the version and roadmap contract');
  }
  return {
    schemaVersion: EVIDENCE_RESULT_SCHEMA_VERSION,
    operation: 'baseline:provenance',
    status: 'PASS',
    versionSurfaces: {
      package: packageJson.version,
      lock: lockJson.packages?.['']?.version,
      pluginPackage: pluginPackage.version,
      pluginManifest: pluginManifest.version
    },
    roadmapHeading: '12. Implementation Checklist'
  };
}

function skillResult(rootDir, contractItem) {
  const skillId = contractItem.operation.slice('skill:'.length, -':catalog'.length);
  const skillFile = fileIdentity(rootDir, `skills/${skillId}/SKILL.md`);
  const catalogText = fs.readFileSync(resolveInside(rootDir, 'src/core/skill-catalog.mjs'), 'utf8');
  const entry = resolveSkill(skillId);
  if (!entry || !PUBLIC_SKILL_IDS.includes(skillId) || !catalogText.includes('PUBLIC_SKILL_IDS')) throw new Error(`skill source operation failed: ${skillId}`);
  return {
    schemaVersion: EVIDENCE_RESULT_SCHEMA_VERSION,
    operation: contractItem.operation,
    status: 'PASS',
    skillId,
    catalogContains: true,
    skillFileRegular: true,
    skillFile,
    descriptionPresent: /^description:\s*.+$/mu.test(fs.readFileSync(resolveInside(rootDir, skillFile.path), 'utf8'))
  };
}

async function claudeFixtureResult() {
  let request;
  const runner = createClaudeRunner({
    apiKey: 'irsa003-fixture-key',
    model: 'claude-opus-4-8',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        id: 'fixture-message',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: '{"schemaVersion":1}' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }), { status: 200, headers: { 'request-id': 'fixture-request', 'content-type': 'application/json' } });
    }
  });
  const response = await runner.run({ system: 'Return JSON.', user: 'Review synthetic input.' });
  const body = JSON.parse(request.options.body);
  return {
    schemaVersion: EVIDENCE_RESULT_SCHEMA_VERSION,
    operation: 'provider-fixture:claude-api',
    status: 'PASS',
    endpoint: request.url,
    method: request.options.method,
    model: body.model,
    headers: {
      contentType: request.options.headers['content-type'],
      anthropicVersion: request.options.headers['anthropic-version'],
      apiKeyPresent: request.options.headers['x-api-key'] === 'irsa003-fixture-key'
    },
    responseModel: response.model,
    usage: response.usage,
    responseRequestId: response.requestId,
    normalizedSchemaVersion: JSON.parse(response.rawResponse).schemaVersion
  };
}

function windowsDenialResult() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-irsa003-windows-'));
  try {
    const hostRoot = path.join(root, 'host');
    const installRoot = path.join(hostRoot, 'skills');
    const skillPath = path.join(installRoot, 'secure-code-reviewer');
    const manifestPath = path.join(hostRoot, 'linmas-manifest.json');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# synthetic\n');
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      tool: 'linmas', version: '0.9.0', manifestVersion: 1, host: 'claude', installedAt: '2026-09-09T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    }, null, 2)}\n`);
    const manifests = new Map([['claude', {
      tool: 'linmas', version: '0.9.0', manifestVersion: 1, host: 'claude', installedAt: '2026-09-09T00:00:00.000Z',
      skills: [{ name: 'secure-code-reviewer', path: skillPath, backupPath: null }]
    }]]);
    let code = null;
    try {
      applyUninstallPlan(
        [{ host: 'claude', skillName: 'secure-code-reviewer', skillPath, installRoot }],
        manifests,
        new Map([['claude', manifestPath]]),
        { platform: 'win32' }
      );
    } catch (error) {
      code = error?.code;
    }
    if (code !== SAFE_FILESYSTEM_OPERATION_UNAVAILABLE || !fs.existsSync(path.join(skillPath, 'SKILL.md'))) throw new Error('Windows denial operation did not fail closed before mutation');
    return {
      schemaVersion: EVIDENCE_RESULT_SCHEMA_VERSION,
      operation: 'windows:destructive-uninstall',
      status: 'UNSUPPORTED',
      code,
      mutated: false,
      safeFilesystemBoundary: true
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function capsule({ source = 'input.diff' } = {}) {
  return buildReviewCapsule({
    input: { source, bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: {
      schemaVersion: 1,
      caseId: 'irsa003/mcp',
      specialist: 'secure-code-reviewer',
      modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic MCP fixture.'],
      findings: [],
      deterministicChecks: [],
      safetyBoundary: SAFETY_BOUNDARY
    },
    policyResult: null,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
}

function setupMcpFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-irsa003-mcp-'));
  fs.writeFileSync(path.join(root, 'before.json'), `${JSON.stringify(capsule(), null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'after.json'), `${JSON.stringify(capsule({ source: 'after.diff' }), null, 2)}\n`);
  return root;
}

function fixtureProviderRegistry(calls) {
  return new Map([['codex', {
    detectConfiguration: () => ({ status: 'configured', defaultModel: 'fixture-model' }),
    create: () => ({ run: async () => {
      calls.count += 1;
      return {
        provider: 'codex', model: 'fixture-model', usage: null, requestId: 'private-request-id',
        rawResponse: JSON.stringify({ schemaVersion: 1, scopeAndAssumptions: ['fixture'], findings: [], deterministicChecks: [], safetyBoundary: SAFETY_BOUNDARY })
      };
    } })
  }]]);
}

async function mcpResult(contractItem) {
  const root = setupMcpFixture();
  const calls = { count: 0 };
  try {
    const dispatch = createLinmasDispatcher({ env: {}, providerRegistry: fixtureProviderRegistry(calls) });
    const common = { workspace_root: root };
    if (contractItem.recordId === 'R090-MCP-01') {
      const result = await dispatch('linmas_review_prepare', { ...common, input_text: 'SELECT 1', skill_name: 'linmas-secure-code-reviewer' });
      return { schemaVersion: 1, operation: contractItem.operation, status: 'PASS', resultStatus: result.status, humanReviewRequired: result.humanReviewRequired, dataLeavesMachine: result.dataLeavesMachine, specialist: result.request.specialist };
    }
    if (contractItem.recordId === 'R090-MCP-02') {
      const result = await dispatch('linmas_review_compare', { ...common, before_capsule_path: 'before.json', after_capsule_path: 'after.json' });
      return { schemaVersion: 1, operation: contractItem.operation, status: 'PASS', resultStatus: result.status, humanReviewRequired: result.humanReviewRequired, disclaimer: result.delta.disclaimer };
    }
    if (contractItem.recordId === 'R090-MCP-03') {
      const result = await dispatch('linmas_policy_evaluate', { ...common, capsule_path: 'before.json', policy_id: 'baseline-appsec' });
      return { schemaVersion: 1, operation: contractItem.operation, status: 'PASS', resultStatus: result.status, humanReviewRequired: result.policy.humanReviewRequired, disclaimer: result.policy.disclaimer };
    }
    if (contractItem.recordId === 'R090-MCP-04') {
      const source = await loadCapsuleEvidence(path.join(root, 'before.json'));
      const receipt = buildDecisionReceipt({ subject: { kind: source.kind, sha256: source.sourceSha256 }, reviewer: { label: 'Synthetic reviewer', principal: null }, findings: [], statement: 'No action is recorded.', now: new Date('2026-07-19T00:00:00.000Z') });
      await writeProofBundle(path.join(root, 'bundle'), source, receipt);
      const result = await dispatch('linmas_proof_verify', { ...common, bundle_path: 'bundle' });
      return { schemaVersion: 1, operation: contractItem.operation, status: 'PASS', resultStatus: result.status, integrity: result.verification.integrity, overallDisposition: result.verification.receipt.overallDisposition };
    }
    if (contractItem.recordId === 'R090-MCP-05') {
      const args = { ...common, source_path: 'before.json', bundle_path: 'new-bundle', reviewer: { label: 'Synthetic reviewer', principal: null }, findings: [], statement: 'No action is recorded.' };
      const prepared = await dispatch('linmas_proof_create', { ...args, confirm_write: false });
      const executed = await dispatch('linmas_proof_create', { ...args, confirm_write: true });
      if (fs.existsSync(path.join(root, 'new-bundle')) === false) throw new Error('proof create did not produce its bounded output');
      return { schemaVersion: 1, operation: contractItem.operation, status: 'PASS', preparedStatus: prepared.status, executedStatus: executed.status, proofOfImpact: executed.proofOfImpact, integrity: executed.verification.integrity, explicitWriteConfirmation: true };
    }
    if (contractItem.recordId === 'R090-MCP-06') {
      const args = { ...common, input_text: 'safe fixture', skill_name: 'linmas-secure-code-reviewer', provider: 'codex', confirm_transmission: false };
      const prepared = await dispatch('linmas_review_execute', args);
      const executed = await dispatch('linmas_review_execute', { ...args, confirm_transmission: true });
      return { schemaVersion: 1, operation: contractItem.operation, status: 'PASS', preparedStatus: prepared.status, executedStatus: executed.status, model: executed.provider.model, dataLeavesMachine: executed.dataLeavesMachine, transmissionConfirmed: executed.transmissionConfirmed, transmissionState: executed.transmissionState, providerResponseReceived: executed.providerResponseReceived, capsuleWritten: executed.capsuleWritten, providerCalls: calls.count };
    }
    if (contractItem.recordId === 'R090-MCP-07') {
      const args = { ...common, input_text: 'safe fixture', skill_name: 'linmas-secure-code-reviewer', provider: 'codex', confirm_transmission: true };
      const executed = await dispatch('linmas_review_execute', args);
      const decided = await dispatch('linmas_review_decide', { ...common, review_handle: executed.reviewReference.handle, capsule_digest: executed.reviewReference.capsuleDigest, decision: { disposition: 'manual_review_required' } });
      return { schemaVersion: 1, operation: contractItem.operation, status: 'PASS', disposition: decided.reviewInteraction.disposition, mayContinue: decided.reviewInteraction.mayContinue, unresolvedFindings: decided.reviewInteraction.unresolvedFindings, boundReference: true, providerCalls: calls.count };
    }
    throw new Error(`unsupported MCP evidence operation: ${contractItem.recordId}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runPackageOperation(rootDir, artifactRoot, artifactBinding) {
  const operationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-irsa003-pack-run-'));
  const first = path.join(operationRoot, 'first');
  const second = path.join(operationRoot, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  try {
    const currentVersion = currentPackageVersion(rootDir);
    const packageFilename = `linmas-${currentVersion}.tgz`;
    const tool = trustedNpmTool();
    const isolated = createIsolatedNpmEnvironment(operationRoot, tool);
    const npmArgs = [tool.npmCli.path, 'pack', '--ignore-scripts', '--silent'];
    execFileSync(process.execPath, [...npmArgs, '--pack-destination', first], { cwd: rootDir, env: isolated.env, stdio: 'ignore', timeout: EVIDENCE_OPERATION_TIMEOUT_MS });
    execFileSync(process.execPath, [...npmArgs, '--pack-destination', second], { cwd: rootDir, env: isolated.env, stdio: 'ignore', timeout: EVIDENCE_OPERATION_TIMEOUT_MS });
    const firstPath = path.join(first, packageFilename);
    const secondPath = path.join(second, packageFilename);
    const measured = measurePackageArtifact({ repositoryRoot: rootDir, artifactPath: firstPath, expectedVersion: currentVersion });
    const repeated = measurePackageArtifact({ repositoryRoot: rootDir, artifactPath: secondPath, expectedVersion: currentVersion });
    const result = packageResult(measured, repeated, tool.execution);
    if (!result.repeatability.byteIdentical) throw new Error('package operation produced different independent outputs');
    if (artifactBinding && (result.package.sha256 !== artifactBinding.package.sha256 || result.package.bytes !== artifactBinding.package.bytes || result.package.entryCount !== artifactBinding.package.entryCount || result.package.inventorySha256 !== artifactBinding.package.inventorySha256)) throw new Error('package operation output does not match the authorized artifact binding');
    return { result, inputIdentity: isolated.inputIdentity };
  } finally {
    fs.rmSync(operationRoot, { recursive: true, force: true });
  }
}

function runPluginOperation(rootDir, artifactRoot, artifactBinding) {
  const operationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-irsa003-plugin-run-'));
  const target = path.join(operationRoot, 'linmas');
  const childEnvironment = createExplicitChildEnvironment('plugin-builder');
  try {
    execFileSync(process.execPath, [path.join(rootDir, 'scripts/build-codex-plugin.mjs'), '--target', target], {
      cwd: rootDir,
      env: childEnvironment.env,
      stdio: 'ignore',
      timeout: EVIDENCE_OPERATION_TIMEOUT_MS
    });
    const measured = measurePluginParity({ pluginPath: target, canonicalPath: path.join(rootDir, 'plugins/linmas'), expectedVersion: currentPackageVersion(rootDir) });
    const result = pluginResult(measured, {
      runner: 'node-execfile-fixed-v1',
      environmentPolicy: childEnvironment.policy,
      loaderInputs: 'NODE_OPTIONS,NODE_PATH absent'
    });
    if (artifactBinding && (result.contentDigest !== artifactBinding.plugin.contentDigest || result.fileCount !== artifactBinding.plugin.fileCount)) throw new Error('plugin operation output does not match the authorized artifact binding');
    return result;
  } finally {
    childEnvironment.cleanup();
    fs.rmSync(operationRoot, { recursive: true, force: true });
  }
}

async function runOperation(rootDir, artifactRoot, artifactBinding, contractItem) {
  let result;
  let extraInputs = [];
  if (contractItem.recordId === 'R090-PROVENANCE') result = sourceProvenanceResult(rootDir);
  else if (contractItem.recordId === 'R090-PACKAGE-001') {
    const packageOperation = runPackageOperation(rootDir, artifactRoot, artifactBinding);
    result = packageOperation.result;
    extraInputs = packageOperation.inputIdentity;
  }
  else if (contractItem.recordId === 'R090-PLUGIN-001') result = runPluginOperation(rootDir, artifactRoot, artifactBinding);
  else if (contractItem.recordId === 'R090-PROVIDER-CLAUDE') result = await claudeFixtureResult();
  else if (contractItem.recordId === 'R090-WINDOWS-001') result = windowsDenialResult();
  else if (contractItem.operation.startsWith('skill:')) result = skillResult(rootDir, contractItem);
  else if (contractItem.operation.startsWith('mcp:')) {
    result = await mcpResult(contractItem);
    extraInputs = [fixtureIdentity('operation-config.json', Buffer.from(canonicalJson({ operation: contractItem.operation, fixture: 'irsa003-mcp-v1' })))];
  } else throw new Error(`unimplemented evidence operation: ${contractItem.operation}`);

  validateOperationResult(contractItem, result, { artifactBinding });
  const producerInput = inputIdentity(rootDir, contractItem, extraInputs);
  return {
    result,
    inputIdentity: producerInput,
    output: outputDescriptor(result),
    producer: producer(contractItem)
  };
}

function actualArtifactBinding({ repositoryRoot, artifactRoot, packagePath, pluginPath }) {
  const measured = measureReleaseArtifacts({ repositoryRoot, artifactRoot, packagePath, pluginPath, expectedVersion: currentPackageVersion(repositoryRoot) });
  return {
    schemaVersion: 1,
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
}

export function computeArtifactBindingDigest(artifactBinding) {
  const material = {
    package: {
      path: artifactBinding.package.path,
      filename: artifactBinding.package.filename,
      bytes: artifactBinding.package.bytes,
      entryCount: artifactBinding.package.entryCount,
      sha256: artifactBinding.package.sha256,
      inventorySha256: artifactBinding.package.inventorySha256,
      packageName: artifactBinding.package.packageName,
      packageVersion: artifactBinding.package.packageVersion,
      published: artifactBinding.package.published
    },
    plugin: {
      path: artifactBinding.plugin.path,
      fileCount: artifactBinding.plugin.fileCount,
      contentDigest: artifactBinding.plugin.contentDigest,
      packageName: artifactBinding.plugin.packageName,
      packageVersion: artifactBinding.plugin.packageVersion,
      published: artifactBinding.plugin.published
    }
  };
  return sha256(Buffer.from(canonicalJson(material)));
}

export function formatObservedSummary(contractItem, result) {
  if (contractItem.recordId === 'R090-PACKAGE-001') {
    return `Two independently created local npm tarballs were identical: ${result.package.entryCount} entries, ${result.package.bytes} bytes, sha256 ${result.package.sha256}; required runtime files were present and docs/, tests/, plugins/, .local-agent/, .serena/, and .env* paths were absent.`;
  }
  return contractItem.observedSummary;
}

export function formatHistoricalSummary(contractItem, artifactBinding) {
  if (contractItem.recordId === 'R090-PACKAGE-001') {
    return `Two independently created local npm tarballs were identical: ${artifactBinding.package.entryCount} entries, ${artifactBinding.package.bytes} bytes, sha256 ${artifactBinding.package.sha256}; required runtime files were present and docs/, tests/, plugins/, .local-agent/, .serena/, and .env* paths were absent.`;
  }
  return contractItem.observedSummary;
}

export function validateOperationResult(contractItem, result, { artifactBinding, requireTrustedPackager = true } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`operation result is invalid: ${contractItem.recordId}`);
  if (result.schemaVersion !== EVIDENCE_RESULT_SCHEMA_VERSION || result.operation !== contractItem.operation || result.status !== contractItem.expectedStatus) throw new Error(`operation result contract is invalid: ${contractItem.recordId}`);
  if (contractItem.operation.startsWith('skill:')) {
    if (result.skillId !== contractItem.operation.slice('skill:'.length, -':catalog'.length) || result.catalogContains !== true || result.skillFileRegular !== true || !result.skillFile || !SHA256.test(result.skillFile.sha256) || !Number.isSafeInteger(result.skillFile.bytes) || result.skillFile.bytes <= 0 || result.descriptionPresent !== true) throw new Error(`skill operation result is incomplete: ${contractItem.recordId}`);
    return true;
  }
  switch (contractItem.recordId) {
    case 'R090-PROVENANCE':
      {
        const versions = Object.values(result.versionSurfaces || {});
        if (result.roadmapHeading !== '12. Implementation Checklist' || versions.length !== 4 || !VERSION.test(versions[0]) || versions.some((value) => value !== versions[0]) || (artifactBinding && versions[0] !== artifactBinding.package.packageVersion)) throw new Error('provenance operation result is incomplete');
      }
      break;
    case 'R090-PACKAGE-001':
      if (!result.repeatability?.byteIdentical || result.repeatability.packCount !== 2 || !result.package || !SHA256.test(result.package.sha256) || !SHA256.test(result.package.inventorySha256)) throw new Error('package operation result is incomplete');
      if (result.privatePathsRejected !== true) throw new Error('package operation result does not prove private-path rejection');
      if (requireTrustedPackager && (!result.execution || result.execution.runner !== 'node-execfile-fixed-v1' || result.execution.environmentPolicy !== 'sanitized-fixed-v1' || result.execution.childEnvironmentPolicy !== CHILD_ENVIRONMENT_POLICY || result.execution.configPolicy !== 'temporary-empty-user-and-global-config-v1' || result.execution.networkPolicy !== 'offline' || typeof result.execution.nodePath !== 'string' || !path.isAbsolute(result.execution.nodePath) || !Number.isSafeInteger(result.execution.nodeBytes) || result.execution.nodeBytes <= 0 || !SHA256.test(result.execution.nodeSha256) || typeof result.execution.npmCliPath !== 'string' || !path.isAbsolute(result.execution.npmCliPath) || !Number.isSafeInteger(result.execution.npmCliBytes) || result.execution.npmCliBytes <= 0 || !SHA256.test(result.execution.npmCliSha256))) throw new Error('package operation result does not bind its trusted packager');
      if (artifactBinding && (result.package.sha256 !== artifactBinding.package.sha256 || result.package.bytes !== artifactBinding.package.bytes || result.package.entryCount !== artifactBinding.package.entryCount || result.package.inventorySha256 !== artifactBinding.package.inventorySha256)) throw new Error('package operation result does not match artifact binding');
      break;
    case 'R090-PLUGIN-001':
      if (result.byteIdentical !== true || !Number.isSafeInteger(result.fileCount) || !SHA256.test(result.contentDigest)) throw new Error('plugin operation result is incomplete');
      if (requireTrustedPackager && (!result.execution || result.execution.runner !== 'node-execfile-fixed-v1' || result.execution.environmentPolicy !== CHILD_ENVIRONMENT_POLICY || result.execution.loaderInputs !== 'NODE_OPTIONS,NODE_PATH absent')) throw new Error('plugin operation result does not bind its explicit child environment');
      if (artifactBinding && (result.contentDigest !== artifactBinding.plugin.contentDigest || result.fileCount !== artifactBinding.plugin.fileCount)) throw new Error('plugin operation result does not match artifact binding');
      break;
    case 'R090-PROVIDER-CLAUDE':
      if (result.endpoint !== 'https://api.anthropic.com/v1/messages' || result.method !== 'POST' || result.model !== 'claude-opus-4-8' || result.headers?.apiKeyPresent !== true || result.normalizedSchemaVersion !== 1 || result.usage?.inputTokens !== 10 || result.usage?.outputTokens !== 5) throw new Error('Claude fixture result is incomplete');
      break;
    case 'R090-WINDOWS-001':
      if (result.code !== SAFE_FILESYSTEM_OPERATION_UNAVAILABLE || result.mutated !== false || result.safeFilesystemBoundary !== true) throw new Error('Windows denial result is incomplete');
      break;
    case 'R090-MCP-01':
      if (result.resultStatus !== 'prepared' || result.humanReviewRequired !== true || result.dataLeavesMachine !== false || result.specialist !== 'secure-code-reviewer') throw new Error('MCP prepare result is incomplete');
      break;
    case 'R090-MCP-02':
      if (result.resultStatus !== 'verified' || result.humanReviewRequired !== true || !result.disclaimer.includes('does not prove remediation')) throw new Error('MCP compare result is incomplete');
      break;
    case 'R090-MCP-03':
      if (result.resultStatus !== 'verified' || result.humanReviewRequired !== true || !result.disclaimer.includes('does not prove security or compliance')) throw new Error('MCP policy result is incomplete');
      break;
    case 'R090-MCP-04':
      if (result.resultStatus !== 'verified' || result.integrity !== 'valid' || result.overallDisposition !== 'no-findings-reported') throw new Error('MCP proof verify result is incomplete');
      break;
    case 'R090-MCP-05':
      if (result.preparedStatus !== 'prepared' || result.executedStatus !== 'executed' || result.explicitWriteConfirmation !== true || result.integrity !== 'valid' || result.proofOfImpact !== 'not_claimed') throw new Error('MCP proof create result is incomplete');
      break;
    case 'R090-MCP-06':
      if (result.preparedStatus !== 'prepared' || result.executedStatus !== 'executed' || result.transmissionConfirmed !== true || result.transmissionState !== 'normalized' || result.providerResponseReceived !== true || result.capsuleWritten !== false || result.providerCalls !== 1) throw new Error('MCP execute result is incomplete');
      break;
    case 'R090-MCP-07':
      if (result.disposition !== 'manual_review_required' || result.mayContinue !== false || result.boundReference !== true || result.providerCalls !== 1) throw new Error('MCP decide result is incomplete');
      break;
    default:
      throw new Error(`unknown evidence operation contract: ${contractItem.recordId}`);
  }
  return true;
}

function extractTestNames(text) {
  return [
    ...text.matchAll(/^\s*test\(\s*'([^']+)'/gmu),
    ...text.matchAll(/^\s*test\(\s*"([^"]+)"/gmu),
    ...text.matchAll(/^\s*test\(\s*`([^`]+)`/gmu)
  ].map((match) => match[1]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveLocator(repositoryRoot, evidenceLocation) {
  const target = resolveInside(repositoryRoot, evidenceLocation.path);
  const text = fs.readFileSync(target, 'utf8');
  const locatorText = evidenceLocation.locator;
  if (locatorText.startsWith('test: ')) return extractTestNames(text).includes(locatorText.slice(6));
  if (locatorText.startsWith('tool: ')) return new RegExp(`^\\d+\\. ${escapeRegExp(locatorText.slice(6))}$`, 'mu').test(text);
  if (locatorText.startsWith('heading: ')) return new RegExp(`^#+ ${escapeRegExp(locatorText.slice(9))}$`, 'mu').test(text);
  if (locatorText.startsWith('json: ')) {
    let value;
    try {
      value = JSON.parse(text);
      const pointer = locatorText.slice(6);
      const normalized = pointer.startsWith('$.') ? pointer.slice(2) : pointer.startsWith('$') ? pointer.slice(1) : pointer;
      for (const part of normalized.split('.').filter(Boolean)) value = value[part];
    } catch {
      return false;
    }
    return value !== undefined;
  }
  if (locatorText.startsWith('text: ')) return text.includes(locatorText.slice(6));
  if (locatorText.startsWith('file: ')) return path.basename(evidenceLocation.path) === locatorText.slice(6);
  return false;
}

export function validateOperationLocations(repositoryRoot, contractItem, evidenceLocations) {
  if (!Array.isArray(evidenceLocations) || JSON.stringify(evidenceLocations) !== JSON.stringify(contractItem.locations)) throw new Error(`evidence locations are not operation-bound: ${contractItem.recordId}`);
  for (const evidenceLocation of evidenceLocations) {
    if (!resolveLocator(repositoryRoot, evidenceLocation)) throw new Error(`evidence locator does not resolve: ${contractItem.recordId}`);
  }
  return true;
}

async function collectFreshEvidenceAsync({ repositoryRoot, artifactRoot, packagePath, pluginPath }) {
  const gitEnvironment = createExplicitChildEnvironment('producer-git');
  let currentRevision;
  try {
    currentRevision = execFileSync(assertTrustedGitAvailable(), ['rev-parse', 'HEAD'], { cwd: repositoryRoot, env: gitEnvironment.env, encoding: 'utf8' }).trim();
  } finally {
    gitEnvironment.cleanup();
  }
  const artifactBinding = actualArtifactBinding({ repositoryRoot, artifactRoot, packagePath, pluginPath });
  const records = [];
  for (const contractItem of CONTRACTS) {
    const execution = await runOperation(repositoryRoot, artifactRoot, artifactBinding, contractItem);
    const observedSummary = formatObservedSummary(contractItem, execution.result);
    const record = {
      recordId: contractItem.recordId,
      operation: contractItem.operation,
      evidenceKind: contractItem.evidenceKind,
      expectedResult: { status: contractItem.expectedStatus, summary: contractItem.expectedSummary, resultSchema: contractItem.resultSchema },
      observedResult: {
        status: contractItem.expectedStatus,
        summary: observedSummary,
        claimLevel: contractItem.evidenceKind,
        runtimeObserved: false,
        resultSchema: contractItem.resultSchema,
        result: execution.result
      },
      evidenceLocation: contractItem.locations,
      producer: execution.producer,
      inputIdentity: execution.inputIdentity,
      output: execution.output
    };
    validateOperationLocations(repositoryRoot, contractItem, record.evidenceLocation);
    records.push(record);
  }
  const disposition = {
    mode: 'fresh',
    applicability: 'Verifier-owned source and deterministic evidence produced by bounded local operations.',
    schemaVersion: 1,
    evidenceClass: 'source-and-deterministic-fixture-v1',
    sourceRevision: currentRevision,
    contentIdentityDigest: null,
    artifactBindingDigest: computeArtifactBindingDigest(artifactBinding),
    producer: { id: EVIDENCE_PRODUCER_ID, version: EVIDENCE_PRODUCER_VERSION, execution: EVIDENCE_PRODUCER_EXECUTION, attestation: 'external-outer-launch-required', childEnvironmentPolicy: CHILD_ENVIRONMENT_POLICY },
    records,
    evidenceDigest: ''
  };
  return { disposition, artifactBinding };
}

export function collectFreshEvidence({ repositoryRoot, artifactRoot, packagePath, pluginPath }) {
  const args = [SCRIPT_PATH, '--mode', 'collect', '--root-dir', path.resolve(repositoryRoot), '--artifact-root', path.resolve(artifactRoot)];
  if (packagePath) args.push('--package-path', packagePath);
  if (pluginPath) args.push('--plugin-path', pluginPath);
  const childEnvironment = createExplicitChildEnvironment('producer');
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: repositoryRoot,
      env: childEnvironment.env,
      encoding: 'utf8',
      timeout: EVIDENCE_OPERATION_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    });
    return JSON.parse(output);
  } finally {
    childEnvironment.cleanup();
  }
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(['--mode', '--root-dir', '--artifact-root', '--package-path', '--plugin-path']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || values.has(key)) throw new Error('invalid evidence operation arguments');
    values.set(key, value);
  }
  return values;
}

if (path.resolve(process.argv[1] || '') === SCRIPT_PATH) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.get('--mode') !== 'collect') throw new Error('mode must be collect');
    const repositoryRoot = path.resolve(args.get('--root-dir') || process.cwd());
    const artifactRoot = path.resolve(args.get('--artifact-root') || '');
    const packagePath = args.get('--package-path') || `linmas-${currentPackageVersion(repositoryRoot)}.tgz`;
    const pluginPath = args.get('--plugin-path') || 'plugin/linmas';
    const collected = await collectFreshEvidenceAsync({ repositoryRoot, artifactRoot, packagePath, pluginPath });
    process.stdout.write(`${JSON.stringify(collected)}\n`);
  } catch (error) {
    console.error(`evidence operation collection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
