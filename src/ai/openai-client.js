/**
 * Minimal HTTP client for the OpenAI API (Responses and Models endpoints),
 * built on fetch so tests can inject a fake transport: no SDK, no network in
 * tests.
 *
 * Security: the API key only ever goes in the Authorization header. Error
 * messages are our own fixed texts; OpenAI's error messages are never echoed
 * or logged, because some of them quote part of the key ("Incorrect API key
 * provided: sk-abc***xyz").
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_TIMEOUT_MS = 30_000;

export const AI_ERROR_MESSAGES = {
  AI_AUTH: 'A OpenAI recusou a chave de API (inválida, revogada ou sem permissão). Revise a chave nas configurações de IA.',
  AI_FORBIDDEN: 'A OpenAI recusou o acesso desta chave (permissões insuficientes ou região não suportada).',
  AI_QUOTA: 'A conta da OpenAI está sem créditos ou atingiu o limite de gastos. Verifique o faturamento na plataforma da OpenAI.',
  AI_RATE_LIMIT: 'A OpenAI limitou as requisições desta chave por alguns instantes. Tente novamente em breve.',
  AI_MODEL_UNAVAILABLE: 'O modelo escolhido não está disponível para esta chave da OpenAI. Escolha outro modelo nas configurações de IA.',
  AI_BAD_REQUEST: 'A OpenAI recusou a requisição do Finance Chat para este modelo. Tente outro modelo nas configurações de IA.',
  AI_UNAVAILABLE: 'A OpenAI está indisponível no momento. Tente novamente em instantes.',
  AI_NETWORK: 'Não foi possível falar com a OpenAI. Verifique a conexão de internet do servidor do Finance Chat.',
  AI_TIMEOUT: 'A OpenAI demorou demais para responder. Tente novamente.',
};

// 429 codes that mean "no credit / spend limit", not "too many requests" (OpenAI error codes guide).
const BILLING_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);
// Errors raised before any byte reaches OpenAI: the request was certainly not processed.
const NOT_SENT_CAUSES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_INVALID_URL', 'UND_ERR_CONNECT_TIMEOUT']);

const safeToken = (value) => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null);

export class OpenAIError extends Error {
  constructor(code, { status = null, apiCode = null, requestId = null, retryAfter = null, maybeProcessed = false } = {}) {
    super(AI_ERROR_MESSAGES[code] || AI_ERROR_MESSAGES.AI_UNAVAILABLE);
    this.code = code;
    this.status = status;
    this.apiCode = safeToken(apiCode);
    this.requestId = safeToken(requestId);
    this.retryAfter = retryAfter;
    /** The request may have reached OpenAI (and been billed) without us getting the answer. */
    this.maybeProcessed = maybeProcessed;
  }
}

/** Maps an OpenAI HTTP error to one of our codes, using only the status and the error code/type. */
export function classifyError(status, body) {
  const error = body?.error || {};
  if (status === 401) return 'AI_AUTH';
  if (status === 403) return 'AI_FORBIDDEN';
  if (status === 404 || error.code === 'model_not_found') return 'AI_MODEL_UNAVAILABLE';
  if (status === 429) return error.type === 'insufficient_quota' || BILLING_CODES.has(error.code) ? 'AI_QUOTA' : 'AI_RATE_LIMIT';
  if (status === 400 && error.param === 'model') return 'AI_MODEL_UNAVAILABLE';
  if (status >= 500) return 'AI_UNAVAILABLE';
  return 'AI_BAD_REQUEST';
}

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * Normalizes the Responses API `usage` object. Field names, per the official
 * docs: input_tokens, input_tokens_details.cached_tokens (billed cache reads,
 * excluding writes), input_tokens_details.cache_write_tokens and its
 * cache_write_tokens_details.ttl_30m_tokens / ttl_12h_tokens, output_tokens
 * (includes reasoning) and output_tokens_details.reasoning_tokens.
 * Returns null when the API reported no usable counters.
 */
export function normalizeUsage(usage, serviceTier) {
  if (!usage || typeof usage !== 'object' || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return null;
  const input = usage.input_tokens_details || {};
  const writes = input.cache_write_tokens_details || {};
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: count(input.cached_tokens),
    cacheWriteTokens: count(input.cache_write_tokens),
    cacheWrite30mTokens: count(writes.ttl_30m_tokens),
    cacheWrite12hTokens: count(writes.ttl_12h_tokens),
    outputTokens,
    reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens),
    totalTokens: Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : inputTokens + outputTokens,
    serviceTier: typeof serviceTier === 'string' ? serviceTier : undefined,
  };
}

/**
 * Reads the model output of a Responses API result:
 * { kind: 'json', value } | { kind: 'refusal' } | { kind: 'incomplete', reason } | { kind: 'invalid', reason }.
 * The refusal text is not kept: it is not shown to the user.
 */
export function readOutput(data) {
  if (data?.status === 'incomplete') return { kind: 'incomplete', reason: safeToken(data.incomplete_details?.reason) || 'unknown' };
  if (data?.status !== undefined && data.status !== 'completed') return { kind: 'invalid', reason: 'status' };
  let text = '';
  let refused = false;
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
      if (part?.type === 'refusal') refused = true;
    }
  }
  if (refused) return { kind: 'refusal' };
  if (!text) return { kind: 'invalid', reason: 'empty' };
  try {
    return { kind: 'json', value: JSON.parse(text) };
  } catch {
    return { kind: 'invalid', reason: 'json' };
  }
}

export function createOpenAIClient({ fetch: fetchImpl = globalThis.fetch, baseUrl = OPENAI_BASE_URL, timeoutMs = OPENAI_TIMEOUT_MS } = {}) {
  async function call(method, path, apiKey, body, form) {
    const init = {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    // multipart/form-data: fetch sets the Content-Type with the boundary.
    if (form !== undefined) init.body = form;
    let response;
    let text;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
      text = await response.text();
    } catch (cause) {
      const timeout = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
      const notSent = !response && NOT_SENT_CAUSES.has(cause?.cause?.code ?? cause?.code);
      throw new OpenAIError(timeout ? 'AI_TIMEOUT' : 'AI_NETWORK', { maybeProcessed: !notSent });
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    const requestId = response.headers?.get?.('x-request-id') ?? null;
    if (!response.ok) {
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      throw new OpenAIError(classifyError(response.status, data), {
        status: response.status,
        apiCode: data?.error?.code,
        requestId,
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
      });
    }
    if (!data || typeof data !== 'object') throw new OpenAIError('AI_UNAVAILABLE', { status: response.status, requestId, maybeProcessed: true });
    return { data, requestId };
  }

  return {
    /** POST /v1/responses. Resolves with the parsed JSON body; throws OpenAIError. */
    createResponse: ({ apiKey, body }) => call('POST', '/responses', apiKey, body),

    /**
     * POST /v1/audio/transcriptions (multipart). `audio` is a WAV Buffer. Resolves with
     * { text, usage (raw, may be absent), requestId }; throws OpenAIError like the other calls.
     */
    async createTranscription({ apiKey, audio, model, languages = [], prompt }) {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'fala.wav');
      form.append('model', model);
      for (const language of languages) form.append('languages[]', language);
      if (prompt) form.append('prompt', prompt);
      form.append('response_format', 'json');
      const { data, requestId } = await call('POST', '/audio/transcriptions', apiKey, undefined, form);
      if (typeof data.text !== 'string') throw new OpenAIError('AI_INVALID_OUTPUT', { requestId, maybeProcessed: true });
      return { text: data.text, usage: data.usage ?? null, requestId };
    },

    /** GET /v1/models: ids of the models this key can list. */
    async listModels({ apiKey }) {
      const { data } = await call('GET', '/models', apiKey);
      return Array.isArray(data.data) ? data.data.map((model) => model?.id).filter((id) => typeof id === 'string') : [];
    },
  };
}
