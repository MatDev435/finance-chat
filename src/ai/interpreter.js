/**
 * One interpretation = one Responses API call. This module builds the request
 * from the configured model and a compact context, records the token usage
 * (always, whenever the API returned it, whatever happens to the plan) and
 * returns the raw plan for normalization. It never executes anything.
 */
import { findModel } from './models.js';
import { OpenAIError, normalizeUsage, readOutput } from './openai-client.js';
import { buildRequest } from './plan-schema.js';
import { estimateCost } from './pricing.js';

const OUTPUT_ERRORS = {
  refusal: ['AI_REFUSAL', 'A IA não quis interpretar esta mensagem. Nada foi registrado. Tente escrever de outro jeito.'],
  incomplete: ['AI_INCOMPLETE', 'A IA não conseguiu concluir a interpretação desta mensagem. Nada foi registrado. Tente uma mensagem mais curta.'],
  invalid: ['AI_INVALID_OUTPUT', 'A IA devolveu uma resposta fora do formato esperado. Nada foi registrado. Tente novamente.'],
};

export function aiError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const responseIdFrom = (data) => (typeof data?.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(data.id) ? data.id : null);

export function createInterpreter({ client, aiStore, log = console, now = Date.now }) {
  function logFailure(error, model) {
    // Codes and ids only: never the key, the message or OpenAI's error text.
    log.error(`[openai] ${error.code} model=${model}${error.status ? ` status=${error.status}` : ''}${error.apiCode ? ` code=${error.apiCode}` : ''}${error.requestId ? ` request=${error.requestId}` : ''}`);
  }

  return {
    /**
     * `credentials` = { model, apiKey } (from the AI store or an explicit test).
     * `context` = the compact JSON the model receives (see chat.js).
     * Resolves with { plan, responseId }; throws an error with a stable code.
     */
    async interpret({ userId, credentials, context, purpose = 'chat' }) {
      const model = findModel(credentials.model);
      if (!model) throw aiError('AI_MODEL_UNAVAILABLE', 'O modelo salvo não é mais oferecido pelo Finance Chat. Escolha outro nas configurações de IA.');

      let result;
      try {
        result = await client.createResponse({ apiKey: credentials.apiKey, body: buildRequest({ model, context }) });
      } catch (error) {
        if (!(error instanceof OpenAIError)) throw error;
        // Sent but unanswered (timeout, dropped connection): it may have been billed, with no usage to read.
        if (error.maybeProcessed) aiStore.recordUsage(userId, { purpose, model: model.id, outcome: error.code === 'AI_TIMEOUT' ? 'timeout' : 'network', usage: null });
        logFailure(error, model.id);
        throw error;
      }

      const { data } = result;
      const usage = normalizeUsage(data.usage, data.service_tier);
      const output = readOutput(data);
      const responseId = responseIdFrom(data);
      aiStore.recordUsage(userId, {
        purpose,
        model: model.id,
        outcome: output.kind === 'json' ? 'ok' : output.kind,
        responseId,
        usage,
        cost: usage ? estimateCost(model.id, usage, { at: now() }) : null,
      });

      if (output.kind !== 'json') {
        const [code, message] = OUTPUT_ERRORS[output.kind];
        log.error(`[openai] ${code} model=${model.id}${output.reason ? ` reason=${output.reason}` : ''}${responseId ? ` response=${responseId}` : ''}`);
        throw aiError(code, message, { responseId });
      }
      return { plan: output.value, responseId };
    },
  };
}
