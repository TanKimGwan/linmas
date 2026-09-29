#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'linmas';
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const NPM_REGISTRY_URL = `${NPM_REGISTRY_ORIGIN}/${PACKAGE_NAME}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const HTTP_TRAILER = '__LINMAS_HTTP_STATUS__';
const URL_TRAILER = '__LINMAS_EFFECTIVE_URL__';
const PACKUMENT_KEYS = new Set([
  '_id', '_rev', 'name', 'description', 'dist-tags', 'versions', 'time', 'readme', 'readmeFilename',
  'maintainers', 'contributors', 'author', 'bugs', 'homepage', 'keywords', 'license', 'repository',
  'funding', 'users', 'bin', 'engines', 'scripts', 'directories', 'os', 'cpu', 'publishConfig'
]);
const VERSION_METADATA_KEYS = new Set([
  'name', 'version', 'description', 'keywords', 'homepage', 'bugs', 'license', 'author', 'contributors',
  'funding', 'files', 'main', 'browser', 'bin', 'man', 'directories', 'repository', 'scripts', 'config',
  'dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies',
  'bundledDependencies', 'bundleDependencies', 'engines', 'os', 'cpu', 'private', 'publishConfig',
  'workspaces', 'exports', 'imports', 'type', 'types', 'typings', 'module', 'sideEffects', 'readme',
  'readmeFilename', '_id', '_nodeVersion', '_npmVersion', 'dist', 'gitHead', '_npmUser', '_npmOperationalInternal'
]);
const NOT_FOUND_KEYS = new Set(['error', 'statusCode', 'code', 'message']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains an unexpected field`);
}

function exactRegistryUrl(value) {
  if (typeof value !== 'string' || value !== NPM_REGISTRY_URL) throw new Error('registry response resolved to an unexpected URL');
  return value;
}

export function buildRegistryRequest(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error('registry version must be an exact release version');
  return Object.freeze({
    url: NPM_REGISTRY_URL,
    args: Object.freeze([
      '--silent',
      '--show-error',
      '--location',
      '--max-time', '20',
      '--proto', '=https',
      '--proto-redir', '=https',
      '--header', 'Accept: application/json',
      '--write-out', `\n${HTTP_TRAILER}:%{http_code}\n${URL_TRAILER}:%{url_effective}\n`,
      '--url', NPM_REGISTRY_URL
    ])
  });
}

function splitCurlResponse(stdout) {
  if (typeof stdout !== 'string') throw new Error('registry response is not text');
  const marker = new RegExp(`\\n${HTTP_TRAILER}:(\\d{3})\\n${URL_TRAILER}:([^\\r\\n]+)\\s*$`, 'u');
  const match = marker.exec(stdout);
  if (!match) throw new Error('registry response is missing structured curl trailers');
  return { body: stdout.slice(0, match.index), httpStatus: Number(match[1]), effectiveUrl: match[2] };
}

function parseJsonBody(body) {
  try {
    const value = JSON.parse(body.trim());
    if (!isPlainObject(value)) throw new Error('JSON body must be an object');
    return value;
  } catch {
    throw new Error('registry response body is malformed JSON');
  }
}

function parseNotFound(body) {
  assertAllowedKeys(body, NOT_FOUND_KEYS, 'structured registry 404');
  if (typeof body.error !== 'string' || !['Not Found', 'not_found', 'NOT_FOUND'].includes(body.error)) throw new Error('registry 404 response is not an exact package-not-found result');
  if (Object.hasOwn(body, 'statusCode') && body.statusCode !== 404) throw new Error('registry 404 response has a conflicting status code');
  if (Object.hasOwn(body, 'code') && body.code !== 'E404' && body.code !== 'NOT_FOUND') throw new Error('registry 404 response has a conflicting error code');
  if (Object.hasOwn(body, 'message') && typeof body.message !== 'string') throw new Error('registry 404 response message is invalid');
  return true;
}

export function parseRegistryResponse({ result, requestedVersion, requestedUrl = NPM_REGISTRY_URL } = {}) {
  if (!result || typeof result !== 'object' || !VERSION_PATTERN.test(requestedVersion || '')) throw new Error('registry parser request is invalid');
  if (requestedUrl !== NPM_REGISTRY_URL) throw new Error('registry parser is bound to the canonical npm registry URL');
  if (result.status !== 0) throw new Error('registry availability request failed');
  const { body: rawBody, httpStatus, effectiveUrl } = splitCurlResponse(String(result.stdout || ''));
  exactRegistryUrl(effectiveUrl);
  const body = parseJsonBody(rawBody);
  if (httpStatus === 404) {
    parseNotFound(body);
    return Object.freeze({ packageName: PACKAGE_NAME, requestedVersion, registryUrl: NPM_REGISTRY_URL, httpStatus, published: false });
  }
  if (httpStatus !== 200) throw new Error('registry availability response has an unsupported HTTP status');
  assertAllowedKeys(body, PACKUMENT_KEYS, 'registry package metadata');
  if (body.name !== PACKAGE_NAME || !isPlainObject(body.versions)) throw new Error('registry package metadata is not bound to linmas');
  const hasVersion = Object.hasOwn(body.versions, requestedVersion);
  if (!hasVersion) return Object.freeze({ packageName: PACKAGE_NAME, requestedVersion, registryUrl: NPM_REGISTRY_URL, httpStatus, published: false });
  const entry = body.versions[requestedVersion];
  if (!isPlainObject(entry)) throw new Error('registry version metadata is malformed');
  assertAllowedKeys(entry, VERSION_METADATA_KEYS, 'registry version metadata');
  if (entry.name !== PACKAGE_NAME || entry.version !== requestedVersion) throw new Error('registry version metadata conflicts with the requested package or version');
  return Object.freeze({ packageName: PACKAGE_NAME, requestedVersion, registryUrl: NPM_REGISTRY_URL, httpStatus, published: true });
}

export function inspectRegistryVersion({ runCommand, rootDir, version }) {
  if (typeof runCommand !== 'function') throw new Error('registry command runner is required');
  const request = buildRegistryRequest(version);
  const result = runCommand('curl', request.args, { cwd: rootDir });
  return parseRegistryResponse({ result, requestedVersion: version, requestedUrl: request.url });
}

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

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--version' || typeof argv[1] !== 'string') {
    throw new Error('usage: registry-result.mjs --version x.y.z');
  }
  return { version: argv[1] };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const { version } = parseArguments(process.argv.slice(2));
    const result = inspectRegistryVersion({ runCommand: commandResult, rootDir: process.cwd(), version });
    process.stdout.write(`${result.published ? 'published' : 'absent'}\n`);
  } catch (error) {
    console.error(`registry availability check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
