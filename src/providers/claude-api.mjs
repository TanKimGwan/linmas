const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export function createClaudeRunner({ apiKey, model, fetchImpl = fetch, timeoutMs = 60000, maxTokens = 2048 } = {}) {
  if (!apiKey) throw classified('provider-configuration', 'ANTHROPIC_API_KEY is required', undefined, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, transmissionState: 'not-attempted' });
  if (!model) throw classified('provider-configuration', 'LINMAS_EVAL_MODEL is required', undefined, { stage: 'provider-preflight', reasonCode: 'CONFIGURATION_MISSING', retryable: false, transmissionState: 'not-attempted' });
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
        const kind = response.status === 401 || response.status === 403
          ? 'provider-authentication'
          : response.status === 429
            ? 'provider-rate-limit'
            : response.status >= 500
              ? 'provider-upstream'
              : response.status === 408 || response.status === 504
                ? 'provider-timeout'
                : 'provider-rejected';
        const reasonCode = kind === 'provider-authentication' ? 'EXECUTION_AUTHENTICATION_FAILED'
          : kind === 'provider-rate-limit' ? 'EXECUTION_RATE_LIMITED'
            : kind === 'provider-upstream' ? 'EXECUTION_UPSTREAM_FAILED'
              : kind === 'provider-timeout' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_REQUEST_REJECTED';
        throw classified(kind, `Claude API returned HTTP ${response.status}`, undefined, { stage: 'provider-execution', reasonCode, retryable: ['provider-rate-limit', 'provider-upstream', 'provider-timeout'].includes(kind), transmissionState: 'response-received', httpStatus: response.status });
      }
      const text = body?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (!text) throw classified('provider-response-invalid', 'Claude response contains no text block', undefined, { stage: 'response-read', reasonCode: 'RESPONSE_TEXT_MISSING', retryable: false, transmissionState: 'response-received' });
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
