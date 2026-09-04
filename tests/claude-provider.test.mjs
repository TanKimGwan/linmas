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

test('F-010 Claude distinguishes internal timeout, caller cancellation, and transport failure', async () => {
  const waitForAbort = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const timedOut = createClaudeRunner({ apiKey: 'k', model: 'm', timeoutMs: 1, fetchImpl: waitForAbort });
  await assert.rejects(timedOut.run({ system: 'x', user: 'y' }), (error) =>
    error.failureClass === 'provider-timeout'
      && error.reasonCode === 'EXECUTION_TIMEOUT'
      && error.retryable === true
  );

  const controller = new AbortController();
  const cancelled = createClaudeRunner({ apiKey: 'k', model: 'm', timeoutMs: 1000, fetchImpl: waitForAbort })
    .run({ system: 'x', user: 'y', signal: controller.signal });
  controller.abort(new Error('synthetic caller cancellation'));
  await assert.rejects(cancelled, (error) =>
    error.failureClass === 'provider-cancelled'
      && error.reasonCode === 'EXECUTION_CANCELLED'
      && error.retryable === false
  );

  const transport = createClaudeRunner({
    apiKey: 'k', model: 'm',
    fetchImpl: async () => { throw new Error('synthetic network failure'); }
  });
  await assert.rejects(transport.run({ system: 'x', user: 'y' }), (error) =>
    error.failureClass === 'provider-transport'
      && error.reasonCode === 'EXECUTION_FAILED'
      && error.retryable === true
  );
});

test('F-010 Claude preserves failure taxonomy while reading the response body', async (t) => {
  const bodyAfterHeaders = (signal) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json() {
      return new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });

  await t.test('internal timeout', async () => {
    const runner = createClaudeRunner({
      apiKey: 'k', model: 'm', timeoutMs: 1,
      fetchImpl: async (_url, { signal }) => bodyAfterHeaders(signal)
    });
    await assert.rejects(runner.run({ system: 'x', user: 'y' }), (error) =>
      error.failureClass === 'provider-timeout'
        && error.reasonCode === 'EXECUTION_TIMEOUT'
        && error.retryable === true
        && error.stage === 'response-read'
        && error.transmissionState === 'response-received'
    );
  });

  await t.test('caller cancellation', async () => {
    const controller = new AbortController();
    const runner = createClaudeRunner({
      apiKey: 'k', model: 'm', timeoutMs: 1000,
      fetchImpl: async (_url, { signal }) => bodyAfterHeaders(signal)
    });
    const pending = runner.run({ system: 'x', user: 'y', signal: controller.signal });
    controller.abort(new Error('synthetic caller cancellation'));
    await assert.rejects(pending, (error) =>
      error.failureClass === 'provider-cancelled'
        && error.reasonCode === 'EXECUTION_CANCELLED'
        && error.retryable === false
        && error.stage === 'response-read'
    );
  });

  await t.test('body transport rejection', async () => {
    const runner = createClaudeRunner({
      apiKey: 'k', model: 'm',
      fetchImpl: async () => ({
        ok: true, status: 200, headers: new Headers(),
        async json() { throw new Error('synthetic body stream failure'); }
      })
    });
    await assert.rejects(runner.run({ system: 'x', user: 'y' }), (error) =>
      error.failureClass === 'provider-transport'
        && error.reasonCode === 'RESPONSE_READ_FAILED'
        && error.retryable === true
        && error.stage === 'response-read'
    );
  });

  await t.test('malformed JSON', async () => {
    const runner = createClaudeRunner({
      apiKey: 'k', model: 'm',
      fetchImpl: async () => new Response('{not-json', { status: 200 })
    });
    await assert.rejects(runner.run({ system: 'x', user: 'y' }), (error) =>
      error.failureClass === 'provider-response-invalid'
        && error.reasonCode === 'RESPONSE_JSON_INVALID'
        && error.retryable === false
        && error.stage === 'response-read'
    );
  });
});

test('F-010 Claude classifies HTTP 408 and 504 as retryable timeouts', async () => {
  for (const status of [408, 504]) {
    const runner = createClaudeRunner({
      apiKey: 'k', model: 'm',
      fetchImpl: async () => new Response('{}', { status })
    });
    await assert.rejects(runner.run({ system: 'x', user: 'y' }), (error) =>
      error.failureClass === 'provider-timeout'
        && error.reasonCode === 'EXECUTION_TIMEOUT'
        && error.retryable === true
        && error.httpStatus === status
        && error.transmissionState === 'response-received'
    );
  }
});
