#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isStrictReleaseVersion,
  validatePackageVersionConsistency
} from './validate-package-version.mjs';
import { inspectRegistryVersion } from './registry-result.mjs';

const RELEASE_PACKAGE = 'linmas';
const STRICT_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const STRICT_DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_MAIN_REF = /^(?![-/])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/u;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PHASES = new Set(['prepare', 'publish']);
const CHECKOUT_ROLES = new Set(['main', 'target']);

function commandResult(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, stdout, stderr: '' };
  } catch (cause) {
    return {
      status: Number.isInteger(cause?.status) ? cause.status : null,
      stdout: Buffer.isBuffer(cause?.stdout) ? cause.stdout.toString('utf8') : String(cause?.stdout || ''),
      stderr: Buffer.isBuffer(cause?.stderr) ? cause.stderr.toString('utf8') : String(cause?.stderr || '')
    };
  }
}

function runChecked(runCommand, command, args, options, label) {
  const result = runCommand(command, args, options);
  if (result?.status !== 0) throw new Error(`${label} failed`);
  return String(result.stdout || '').trim();
}

function resolveCommit(runCommand, rootDir, ref, label) {
  const resolved = runChecked(
    runCommand,
    'git',
    ['rev-parse', '--verify', `${ref}^{commit}`],
    { cwd: rootDir },
    `unable to resolve ${label}`
  );
  if (!STRICT_COMMIT_SHA.test(resolved)) throw new Error(`unable to resolve ${label}`);
  return resolved;
}

function inspectReleaseNotes(rootDir, version) {
  const relativePath = `releases/${version}.md`;
  const notesPath = path.join(rootDir, 'releases', `${version}.md`);
  let stat;
  try {
    stat = fs.lstatSync(notesPath);
  } catch {
    throw new Error(`release notes are missing: ${relativePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`release notes must be a regular file: ${relativePath}`);

  let firstLine;
  try {
    [firstLine] = fs.readFileSync(notesPath, 'utf8').split(/\r?\n/u, 1);
  } catch {
    throw new Error(`unable to read release notes: ${relativePath}`);
  }
  if (firstLine !== `# Linmas ${version}`) throw new Error(`release notes header must be exactly: # Linmas ${version}`);
  return relativePath;
}

function inspectLocalTag(runCommand, rootDir, tag) {
  const result = runCommand('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: rootDir });
  if (result?.status === 1) return { exists: false, commit: null };
  if (result?.status !== 0) throw new Error('local release-tag availability check failed');
  return { exists: true, commit: resolveCommit(runCommand, rootDir, tag, 'local release tag') };
}

function inspectRemoteTag(runCommand, rootDir, tag) {
  const ref = `refs/tags/${tag}`;
  const result = runCommand('git', ['ls-remote', '--exit-code', '--tags', 'origin', ref, `${ref}^{}`], { cwd: rootDir });
  if (result?.status === 2) return { exists: false, commit: null };
  if (result?.status !== 0) throw new Error('remote release-tag availability check failed');

  const refs = new Map();
  for (const line of String(result.stdout || '').trim().split(/\r?\n/u)) {
    const [sha, name] = line.trim().split(/\s+/u);
    if (STRICT_COMMIT_SHA.test(sha) && name) refs.set(name, sha);
  }
  const commit = refs.get(`${ref}^{}`) || refs.get(ref);
  if (!commit) throw new Error('remote release-tag availability check returned an invalid response');
  return { exists: true, commit };
}

export function inspectNpmVersion(runCommand, rootDir, version) {
  try {
    return inspectRegistryVersion({ runCommand, rootDir, version }).published;
  } catch {
    throw new Error('npm release-version availability check failed');
  }
}

function inspectGithubRelease(runCommand, rootDir, repository, tag) {
  const result = runCommand(
    'gh',
    ['release', 'view', tag, '--repo', repository, '--json', 'tagName'],
    { cwd: rootDir }
  );
  if (result?.status === 0) return true;
  const diagnostic = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  if (/release not found/iu.test(diagnostic)) return false;
  throw new Error('GitHub release availability check failed');
}

export function inspectReleaseState({ rootDir, repository, tag, version, runCommand = commandResult }) {
  const localTag = inspectLocalTag(runCommand, rootDir, tag);
  const remoteTag = inspectRemoteTag(runCommand, rootDir, tag);
  if (localTag.exists && remoteTag.exists && localTag.commit !== remoteTag.commit) {
    throw new Error('local and remote release tags resolve to different commits');
  }

  return Object.freeze({
    tag: Object.freeze({
      localExists: localTag.exists,
      remoteExists: remoteTag.exists,
      commit: remoteTag.commit || localTag.commit
    }),
    npmPublished: inspectNpmVersion(runCommand, rootDir, version),
    githubReleaseExists: inspectGithubRelease(runCommand, rootDir, repository, tag)
  });
}

function validateReleaseStateShape(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('release state is invalid');
  const tag = state.tag;
  if (!tag || typeof tag !== 'object' || Array.isArray(tag)) throw new Error('release tag state is invalid');
  for (const field of ['localExists', 'remoteExists']) {
    if (typeof tag[field] !== 'boolean') throw new Error(`release tag ${field} state is invalid`);
  }
  if (tag.commit !== null && !STRICT_COMMIT_SHA.test(tag.commit)) throw new Error('release tag commit state is invalid');
  for (const field of ['npmPublished', 'githubReleaseExists']) {
    if (typeof state[field] !== 'boolean') throw new Error(`release ${field} state is invalid`);
  }
}

function validateArtifactAuthorization({ version, artifactFilename, artifactSha256, artifactBytes, artifactEntries, artifactInventorySha256 }) {
  if (artifactFilename !== `${RELEASE_PACKAGE}-${version}.tgz`) throw new Error('authorized artifact filename is invalid');
  if (typeof artifactSha256 !== 'string' || !STRICT_DIGEST.test(artifactSha256)) throw new Error('authorized artifact SHA-256 is invalid');
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes <= 0) throw new Error('authorized artifact byte count is invalid');
  if (!Number.isSafeInteger(artifactEntries) || artifactEntries <= 0) throw new Error('authorized artifact entry count is invalid');
  if (typeof artifactInventorySha256 !== 'string' || !STRICT_DIGEST.test(artifactInventorySha256)) throw new Error('authorized artifact inventory digest is invalid');
  return Object.freeze({ sha256: artifactSha256, bytes: artifactBytes, entryCount: artifactEntries, inventorySha256: artifactInventorySha256 });
}

function validateCleanCheckout(runCommand, rootDir) {
  const result = runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: rootDir });
  if (result?.status !== 0) throw new Error('working tree cleanliness check failed');
  const lines = String(result.stdout || '').split(/\r?\n/u).filter(Boolean);
  const staged = lines.filter((line) => line !== '??' && line[0] !== ' ' && line[0] !== '?');
  const unstaged = lines.filter((line) => line !== '??' && line[1] !== ' ' && line[1] !== '?');
  const untracked = lines.filter((line) => line.startsWith('??'));
  if (staged.length || unstaged.length || untracked.length) {
    const kinds = [];
    if (staged.length) kinds.push('staged changes');
    if (unstaged.length) kinds.push('unstaged changes');
    if (untracked.length) kinds.push('untracked changes');
    throw new Error(`working tree must be clean: ${kinds.join(', ')}`);
  }
}

export function validateReleaseState({ phase, state, targetSha }) {
  validateReleaseStateShape(state);
  const tagState = state.tag;
  if (phase === 'prepare') {
    const collisions = [];
    if (tagState.localExists || tagState.remoteExists) collisions.push('release tag already exists');
    if (state.npmPublished) collisions.push('npm version already exists');
    if (state.githubReleaseExists) collisions.push('GitHub release already exists');
    if (collisions.length > 0) throw new Error(`release collision: ${collisions.join(', ')}`);
    return;
  }

  if (!tagState.localExists || !tagState.remoteExists) throw new Error('release tag must exist both locally and remotely before publication');
  if (tagState.commit !== targetSha) throw new Error('release tag does not resolve to the authorized target SHA');
  const collisions = [];
  if (state.npmPublished) collisions.push('npm version already exists');
  if (state.githubReleaseExists) collisions.push('GitHub release already exists');
  if (collisions.length > 0) throw new Error(`release collision: ${collisions.join(', ')}`);
}

export function validateReleaseRequest({
  phase,
  version,
  targetSha,
  mainRef = 'origin/main',
  repository,
  checkoutRole,
  artifactFilename,
  artifactSha256,
  artifactBytes,
  artifactEntries,
  artifactInventorySha256,
  rootDir = process.cwd(),
  releaseState,
  runCommand = commandResult
}) {
  if (!PHASES.has(phase)) throw new Error('phase must be prepare or publish');
  if (!CHECKOUT_ROLES.has(checkoutRole)) throw new Error('checkout role must be main or target');
  if (phase === 'prepare' && checkoutRole !== 'target') throw new Error('prepare phase requires target checkout role');
  if (!isStrictReleaseVersion(version)) throw new Error('requested version must be a strict release SemVer string (x.y.z)');
  if (!STRICT_COMMIT_SHA.test(targetSha)) throw new Error('target SHA must be a full lowercase 40-character commit SHA');
  if (!SAFE_MAIN_REF.test(mainRef)) throw new Error('main ref is invalid');
  if (!SAFE_REPOSITORY.test(repository)) throw new Error('repository must use the owner/name form');
  const artifactAuthorization = validateArtifactAuthorization({ version, artifactFilename, artifactSha256, artifactBytes, artifactEntries, artifactInventorySha256 });

  const resolvedRoot = path.resolve(rootDir);
  validateCleanCheckout(runCommand, resolvedRoot);
  const versions = validatePackageVersionConsistency(resolvedRoot);
  if (versions.version !== version) throw new Error('requested version does not match the canonical package version');
  const releaseNotes = inspectReleaseNotes(resolvedRoot, version);

  const resolvedTarget = resolveCommit(runCommand, resolvedRoot, targetSha, 'target SHA');
  if (resolvedTarget !== targetSha) throw new Error('target SHA did not resolve exactly');
  const mainSha = resolveCommit(runCommand, resolvedRoot, mainRef, 'main ref');
  const ancestor = runCommand('git', ['merge-base', '--is-ancestor', resolvedTarget, mainSha], { cwd: resolvedRoot });
  if (ancestor?.status === 1) throw new Error('target SHA is not reachable from main');
  if (ancestor?.status !== 0) throw new Error('main ancestry validation failed');
  if (phase === 'prepare' && resolvedTarget !== mainSha) throw new Error('target SHA must be the exact current main commit');
  const headSha = resolveCommit(runCommand, resolvedRoot, 'HEAD', 'working tree HEAD');
  const expectedHead = checkoutRole === 'main' ? mainSha : resolvedTarget;
  if (headSha !== expectedHead) throw new Error(`working tree HEAD does not match the authorized ${checkoutRole} commit`);

  const tag = `v${version}`;
  const state = releaseState || inspectReleaseState({ rootDir: resolvedRoot, repository, tag, version, runCommand });
  validateReleaseState({ phase, state, targetSha: resolvedTarget });

  return Object.freeze({
    ready: true,
    phase,
    version,
    tag,
    targetSha: resolvedTarget,
    mainSha,
    checkoutRole,
    headSha,
    releaseNotes,
    artifactFilename,
    artifactAuthorization,
    versionSurfaces: versions.surfaces.map(({ label }) => label),
    availability: Object.freeze({
      tag: phase === 'prepare' ? 'available' : 'authorized-existing',
      npm: 'available',
      githubRelease: 'available'
    })
  });
}

function parseArguments(argv) {
  const allowed = new Set(['--phase', '--version', '--target-sha', '--main-ref', '--repository', '--checkout-role', '--artifact-filename', '--artifact-sha256', '--artifact-bytes', '--artifact-entries', '--artifact-inventory-sha256', '--root-dir']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || values.has(key)) throw new Error('invalid release-validation arguments');
    values.set(key, value);
  }
  return {
    phase: values.get('--phase'),
    version: values.get('--version'),
    targetSha: values.get('--target-sha'),
    mainRef: values.get('--main-ref') || 'origin/main',
    repository: values.get('--repository'),
    checkoutRole: values.get('--checkout-role'),
    artifactFilename: values.get('--artifact-filename'),
    artifactSha256: values.get('--artifact-sha256'),
    artifactBytes: values.has('--artifact-bytes') ? Number(values.get('--artifact-bytes')) : undefined,
    artifactEntries: values.has('--artifact-entries') ? Number(values.get('--artifact-entries')) : undefined,
    artifactInventorySha256: values.get('--artifact-inventory-sha256'),
    rootDir: values.get('--root-dir') || process.cwd()
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = validateReleaseRequest(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`release validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
