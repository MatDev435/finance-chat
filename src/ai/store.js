import { currentLocalDate } from '../transaction-mapping.js';
import { inputError } from '../user-store.js';
import { DEFAULT_MODEL, findModel } from './models.js';

const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,500}$/;

/**
 * Validates the AI settings form. Every field is optional: only what is sent
 * changes. An empty apiKey keeps the stored one. The key itself is never
 * echoed back in an error message.
 */
export function resolveAiSettingsInput(body) {
  const changes = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw inputError('Valor inválido para ativar a IA.', 'enabled');
    changes.enabled = body.enabled;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !findModel(body.model)) throw inputError('Escolha um dos modelos da lista.', 'model');
    changes.model = body.model;
  }
  if (body.removeKey === true) {
    changes.removeKey = true;
  } else if (body.apiKey !== undefined && body.apiKey !== null && body.apiKey !== '') {
    changes.apiKey = apiKeyFrom(body.apiKey);
  }
  return changes;
}

/** A typed API key, trimmed and checked for the OpenAI format (never logged or echoed). */
export function apiKeyFrom(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!API_KEY_PATTERN.test(key)) throw inputError('Chave inválida. A chave de API da OpenAI começa com “sk-” e não tem espaços.', 'apiKey');
  return key;
}

const transcriptionTotals = (row) => ({ requests: row.requests, audioMs: row.audio_ms, costNanoUsd: row.cost_nano_usd });

const usageTotals = (row) => ({
  requests: row.requests,
  requestsWithoutUsage: row.without_usage ?? 0,
  requestsWithoutCost: row.without_cost ?? 0,
  inputTokens: row.input_tokens,
  cachedInputTokens: row.cached_input_tokens,
  outputTokens: row.output_tokens,
  reasoningTokens: row.reasoning_tokens,
  totalTokens: row.total_tokens,
  costNanoUsd: row.cost_nano_usd,
});

/**
 * Per-user AI settings and usage. The OpenAI key is sealed with the secret box
 * (AES-256-GCM, key derived from APP_SECRET, bound to the user id and field)
 * and is only ever opened by credentials(), on the server, right before a
 * request to OpenAI.
 */
export function createAiStore(db, secretBox, { now = Date.now, localDate = currentLocalDate } = {}) {
  const sql = {
    settings: db.prepare('SELECT enabled, model, api_key, key_updated_at, updated_at FROM ai_settings WHERE user_id = ?'),
    upsert: db.prepare(`
      INSERT INTO ai_settings (user_id, enabled, model, api_key, key_updated_at, updated_at)
      VALUES (@userId, @enabled, @model, @apiKey, @keyUpdatedAt, @updatedAt)
      ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, model = excluded.model, api_key = excluded.api_key,
        key_updated_at = excluded.key_updated_at, updated_at = excluded.updated_at`),
    recordUsage: db.prepare(`
      INSERT OR IGNORE INTO ai_usage (user_id, created_at, local_month, purpose, model, outcome, response_id, usage_known,
        input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, cost_nano_usd, pricing_version, audio_ms)
      VALUES (@userId, @createdAt, @localMonth, @purpose, @model, @outcome, @responseId, @usageKnown,
        @inputTokens, @cachedInputTokens, @cacheWriteTokens, @outputTokens, @reasoningTokens, @totalTokens, @costNanoUsd, @pricingVersion, @audioMs)`),
    setOutcome: db.prepare('UPDATE ai_usage SET outcome = ? WHERE user_id = ? AND response_id = ?'),
    summary: db.prepare(`
      SELECT COUNT(*) AS requests,
        SUM(usage_known = 0) AS without_usage,
        SUM(usage_known = 1 AND cost_nano_usd IS NULL) AS without_cost,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd
      FROM ai_usage WHERE user_id = ? AND local_month >= ?`),
    transcriptions: db.prepare(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(audio_ms), 0) AS audio_ms, COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd
      FROM ai_usage WHERE user_id = ? AND local_month >= ? AND purpose = 'transcription'`),
  };
  const keyContext = (userId) => `user:${userId}:openai_api_key`;

  function row(userId) {
    return sql.settings.get(userId) || null;
  }

  function settings(userId) {
    const current = row(userId);
    return {
      enabled: Boolean(current?.enabled),
      model: current?.model ?? DEFAULT_MODEL,
      hasKey: Boolean(current?.api_key),
      keyUpdatedAt: current?.key_updated_at ?? null,
    };
  }

  return {
    /** Safe to send to the browser: never includes the key. */
    settings,

    /**
     * Decrypted settings for a request to OpenAI, or null when the AI is not
     * usable (disabled or without a key). Throws SECRET_UNREADABLE when the
     * key was sealed with another APP_SECRET.
     */
    credentials(userId) {
      const current = row(userId);
      if (!current?.enabled || !current.api_key) return null;
      return { model: current.model, apiKey: secretBox.open(current.api_key, keyContext(userId)) };
    },

    /** Opens the stored key for an explicit test, even while the AI is disabled. */
    storedKey(userId) {
      const current = row(userId);
      return current?.api_key ? secretBox.open(current.api_key, keyContext(userId)) : null;
    },

    update(userId, changes) {
      const current = row(userId);
      const time = now();
      let apiKey = current?.api_key ?? null;
      let keyUpdatedAt = current?.key_updated_at ?? null;
      if (changes.removeKey) {
        apiKey = null;
        keyUpdatedAt = time;
      } else if (changes.apiKey) {
        apiKey = secretBox.seal(changes.apiKey, keyContext(userId));
        keyUpdatedAt = time;
      }
      sql.upsert.run({
        userId,
        enabled: (changes.enabled ?? Boolean(current?.enabled)) ? 1 : 0,
        model: changes.model ?? current?.model ?? DEFAULT_MODEL,
        apiKey,
        keyUpdatedAt,
        updatedAt: time,
      });
      return settings(userId);
    },

    /**
     * Records one OpenAI request. `entry.usage` is the normalized usage (or null
     * when the API returned none). Rows are unique per OpenAI response id, so a
     * response can never be counted twice. Returns whether a row was written.
     */
    recordUsage(userId, { purpose, model, outcome, responseId = null, usage = null, cost = null, audioMs = null }) {
      const time = now();
      const known = Boolean(usage);
      const result = sql.recordUsage.run({
        userId,
        createdAt: time,
        localMonth: localDate().slice(0, 7),
        purpose,
        model,
        outcome,
        responseId,
        usageKnown: known ? 1 : 0,
        inputTokens: known ? usage.inputTokens : null,
        cachedInputTokens: known ? usage.cachedInputTokens : null,
        cacheWriteTokens: known ? usage.cacheWriteTokens : null,
        outputTokens: known ? usage.outputTokens : null,
        reasoningTokens: known ? usage.reasoningTokens : null,
        totalTokens: known ? usage.totalTokens : null,
        costNanoUsd: known ? (cost?.costNanoUsd ?? null) : null,
        pricingVersion: cost?.pricingVersion ?? null,
        audioMs,
      });
      return result.changes === 1;
    },

    /** Marks a recorded request whose plan the backend rejected (the tokens were still consumed). */
    setOutcome(userId, responseId, outcome) {
      if (responseId) sql.setOutcome.run(outcome, userId, responseId);
    },

    /** Totals of this user only: everything, and the current month (APP_TIME_ZONE). */
    usageSummary(userId) {
      const month = localDate().slice(0, 7);
      return {
        month,
        total: usageTotals(sql.summary.get(userId, '0000-00')),
        currentMonth: usageTotals(sql.summary.get(userId, month)),
        // Voice transcriptions (already included in the totals above), shown on their own line.
        transcription: {
          total: transcriptionTotals(sql.transcriptions.get(userId, '0000-00')),
          currentMonth: transcriptionTotals(sql.transcriptions.get(userId, month)),
        },
      };
    },
  };
}
