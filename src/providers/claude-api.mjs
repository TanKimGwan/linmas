const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export function createClaudeRunner({ apiKey, model, fetchImpl = fetch, timeoutMs = 60000, maxTokens = 2048 } = {}) {
  if (!apiKey) throw classified('runner-configuration', 'ANTHROPIC_API_KEY is required');
  if (!model) throw classified('runner-configuration', 'LINMAS_EVAL_MODEL is required');
  return {
    id: 'claude', model,
    async run({ system, user }) {
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
        });
      } catch (cause) { throw classified('provider-transport', 'Claude request failed', cause); }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const kind = response.status === 401 || response.status === 403 ? 'provider-authentication' : response.status === 429 ? 'provider-rate-limit' : 'provider-transport';
        throw classified(kind, `Claude API returned HTTP ${response.status}`);
      }
      const text = body?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (!text) throw classified('normalization-failed', 'Claude response contains no text block');
      return { provider: 'claude', model: body.model || model, rawResponse: text, usage: { inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null }, requestId: response.headers.get('request-id') };
    }
  };
}

function classified(failureClass, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { failureClass });
}
