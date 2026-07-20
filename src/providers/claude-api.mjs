const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export function createClaudeRunner({ apiKey, model, fetchImpl = fetch, timeoutMs = 60000, maxTokens = 2048 } = {}) {
  if (!apiKey) throw classified('runner-configuration', 'ANTHROPIC_API_KEY is required');
  if (!model) throw classified('runner-configuration', 'LINMAS_EVAL_MODEL is required');
  return {
    id: 'claude', model,
    async run({ system, user, signal }) {
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST', signal: combineSignals(signal, timeoutMs),
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
        });
      } catch (cause) {
        const category = signal?.aborted ? 'provider-timeout' : 'provider-transport';
        throw classified(category, signal?.aborted ? 'Claude request timed out or was cancelled' : 'Claude request failed', cause, { stage: 'provider-execution', reasonCode: signal?.aborted ? 'EXECUTION_TIMEOUT' : 'EXECUTION_FAILED', retryable: category === 'provider-timeout', transmissionState: 'attempted' });
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const kind = response.status === 401 || response.status === 403 ? 'provider-authentication' : response.status === 429 ? 'provider-rate-limit' : 'provider-transport';
        throw classified(kind, `Claude API returned HTTP ${response.status}`, undefined, { stage: 'provider-execution', reasonCode: kind === 'provider-authentication' ? 'EXECUTION_AUTHENTICATION_FAILED' : kind === 'provider-rate-limit' ? 'EXECUTION_RATE_LIMITED' : 'EXECUTION_FAILED', retryable: kind === 'provider-rate-limit', transmissionState: 'attempted' });
      }
      const text = body?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (!text) throw classified('normalization-failed', 'Claude response contains no text block');
      return { provider: 'claude', model: body.model || model, rawResponse: text, usage: { inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null }, requestId: response.headers.get('request-id') };
    }
  };
}

function combineSignals(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

function classified(failureClass, message, cause, metadata = {}) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { failureClass, ...metadata });
}
