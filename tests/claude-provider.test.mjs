import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeRunner } from '../src/providers/claude-api.mjs';

test('Claude runner sends explicit headers/model and returns usage', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: 'msg_1', model: 'claude-opus-4-8', content: [{ type: 'text', text: '{"schemaVersion":1}' }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'request-id': 'req_1', 'content-type': 'application/json' } });
  };
  const result = await createClaudeRunner({ apiKey: 'test-key', model: 'claude-opus-4-8', fetchImpl }).run({ system: 'Return JSON.', user: 'Review synthetic input.' });
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.equal(request.options.headers['x-api-key'], 'test-key');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'claude-opus-4-8');
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Review synthetic input.' }]);
  assert.equal(body.system, 'Return JSON.');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

test('Claude runner classifies rate limits and authentication without retrying internally', async () => {
  const rateLimited = createClaudeRunner({ apiKey: 'test-key', model: 'claude-opus-4-8', fetchImpl: async () => new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 }) });
  await assert.rejects(rateLimited.run({ system: 'x', user: 'y' }), (error) => error.failureClass === 'provider-rate-limit');
  const unauthorized = createClaudeRunner({ apiKey: 'test-key', model: 'claude-opus-4-8', fetchImpl: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(unauthorized.run({ system: 'x', user: 'y' }), (error) => error.failureClass === 'provider-authentication');
});

test('Claude runner classifies upstream and request rejection responses safely', async () => {
  for (const [status, failureClass, retryable] of [[400, 'provider-rejected', false], [503, 'provider-upstream', true]]) {
    const runner = createClaudeRunner({ apiKey: 'test-key', model: 'claude-opus-4-8', fetchImpl: async () => new Response('{}', { status }) });
    await assert.rejects(runner.run({ system: 'x', user: 'y' }), (error) => error.failureClass === failureClass
      && error.retryable === retryable && error.httpStatus === status && error.transmissionState === 'response-received');
  }
});

test('Claude runner rejects missing configuration and empty text', async () => {
  assert.throws(() => createClaudeRunner({ model: 'm' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => createClaudeRunner({ apiKey: 'k' }), /LINMAS_EVAL_MODEL/);
  const empty = createClaudeRunner({ apiKey: 'k', model: 'm', fetchImpl: async () => new Response(JSON.stringify({ content: [] }), { status: 200 }) });
  await assert.rejects(empty.run({ system: 'x', user: 'y' }), (error) => error.failureClass === 'provider-response-invalid' && error.transmissionState === 'response-received');
});
