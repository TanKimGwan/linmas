import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NPM_REGISTRY_URL,
  buildRegistryRequest,
  parseRegistryResponse
} from '../scripts/registry-result.mjs';

function result(body, status = 200, effectiveUrl = NPM_REGISTRY_URL) {
  return {
    status: 0,
    stdout: `${typeof body === 'string' ? body : JSON.stringify(body)}\n__LINMAS_HTTP_STATUS__:${status}\n__LINMAS_EFFECTIVE_URL__:${effectiveUrl}\n`,
    stderr: ''
  };
}

test('registry request is pinned to the exact npm origin and package path', () => {
  const request = buildRegistryRequest('0.9.0');
  assert.equal(request.url, NPM_REGISTRY_URL);
  assert.equal(request.args.at(-1), NPM_REGISTRY_URL);
  assert.equal(request.args.includes('--registry=https://registry.npmjs.org/'), false);
});

test('structured registry responses distinguish exact absence and exact publication', () => {
  assert.equal(parseRegistryResponse({ result: result({ name: 'linmas', versions: {} }), requestedVersion: '0.9.0' }).published, false);
  assert.equal(parseRegistryResponse({ result: result({ name: 'linmas', versions: { '0.9.0': { name: 'linmas', version: '0.9.0' } } }), requestedVersion: '0.9.0' }).published, true);
  assert.equal(parseRegistryResponse({ result: result({ error: 'Not Found' }, 404), requestedVersion: '0.9.0' }).published, false);
});

test('registry parser fails closed for prose, wrong origin, wrong package/version, and unexpected fields', () => {
  const cases = [
    result('E404 linmas@0.9.0 is not in this registry', 404),
    result({ error: 'Not Found' }, 404, 'https://proxy.invalid/linmas'),
    result({ name: 'other', versions: {} }),
    result({ name: 'linmas', versions: { '0.9.0': { name: 'linmas', version: '0.9.1' } } }),
    result({ name: 'linmas', unexpected: true, versions: {} }),
    result({ name: 'linmas', versions: { '0.9.0': { name: 'linmas', version: '0.9.0', unexpected: true } } }),
    { status: 28, stdout: '', stderr: 'timeout' },
    result({ error: 'rate limit' }, 429)
  ];
  for (const item of cases) assert.throws(() => parseRegistryResponse({ result: item, requestedVersion: '0.9.0' }));
});

test('registry parser rejects conflicting structured 404 responses', () => {
  assert.throws(() => parseRegistryResponse({ result: result({ error: 'Not Found', statusCode: 500 }, 404), requestedVersion: '0.9.0' }));
  assert.throws(() => parseRegistryResponse({ result: result({ error: 'Not Found', code: 'E403' }, 404), requestedVersion: '0.9.0' }));
  assert.throws(() => parseRegistryResponse({ result: result({ error: 'Not Found', unexpected: true }, 404), requestedVersion: '0.9.0' }));
});
