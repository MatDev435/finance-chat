/**
 * The chat dispatcher: turns one message into a response, whatever
 * interpreted it.
 *
 *   message ─ parser (always first) ─┬─ complete → existing deterministic flow
 *                                    └─ not understood / partial / unknown category
 *                                          └─ AI enabled? → one OpenAI call → plan (validated)
 *
 * Interpretation (parser or plan) only produces data. Validation, previews,
 * confirmation, writes and every number shown come from the same backend
 * code in both modes. The AI never writes: transactions always end in a
 * preview that the user confirms; queries are read-only.
 */
import { requireChatAccount } from './accounts.js';
import { contextKey } from './actual.js';
import { getSynchronizedCategoryAvailability } from './budget-availability.js';
import { commitTransaction, commitTransactions, prepareItems, prepareTransaction, undoTransaction } from './budget-operations.js';
import { evaluateCategorySpending } from './category-queries.js';
import * as text from './chat-text.js';
import { resolveDate } from './dates.js';
import { draftContext, draftItemsFrom, itemSummaries } from './drafts.js';
import { HttpError } from './http.js';
import { isCompleteParse } from './parse-check.js';
import { amountToCents, parseAmount, parseMessage } from './parser.js';
import { currentLocalDate } from './transaction-mapping.js';
import { normalizePlan } from './ai/plan.js';
import { weekdayOf } from './ai/plan-schema.js';

const MAX_QUERIES = 3;
const MAX_CONTEXT_CATEGORIES = 200;
const LOCAL_AMOUNT = /^(?:(?:foi|valor|deu)\s+)?((?:r\$|\$)?\s*\d[\d.,]*)(?:\s*reais?)?[.!]?$/i;
const LOCAL_CATEGORY_PREFIX = /^(?:(?:a|na|em)\s+)?(?:categoria\s+|é\s+|e\s+)?/i;

const textAnswer = (message) => ({ ok: true, kind: 'text', message });
const withSource = (result, source) => ({ ...result, source });

/** The command as shown to the browser: no internal category ids. */
function publicCommand(command) {
  const { categoryId, ...rest } = command;
  if (rest.splits) rest.splits = rest.splits.map(({ categoryId: id, ...part }) => part);
  return rest;
}

/** Names the model may use for hints: visible categories only, bounded. */
function contextCategories(categories) {
  return [...new Set(categories.filter((category) => !category.hidden).map((category) => category.name))].slice(0, MAX_CONTEXT_CATEGORIES);
}

/**
 * A short reply that can complete a draft without the AI: exactly one field
 * is missing and the reply is just an amount, or just a category name (the
 * name must still match the budget exactly, checked by the caller).
 */
export function localDraftUpdate(missing, message) {
  if (missing.length !== 1 || typeof message !== 'string') return null;
  const [field] = missing;
  const reply = message.trim();
  if (field.field === 'amount') {
    const match = reply.match(LOCAL_AMOUNT);
    if (!match) return null;
    try {
      return { item: field.item, part: field.part, field: 'amount', value: parseAmount(match[1]) };
    } catch {
      return null;
    }
  }
  const name = reply.replace(LOCAL_CATEGORY_PREFIX, '').replace(/[.!?]+$/, '').trim();
  if (!name || name.length > 60 || /\d/.test(name)) return null;
  return { item: field.item, part: field.part, field: 'category', value: name };
}

export function createChat({ actual, pending, undo, conversations, aiStore, interpreter, search, requireConnection, aiLimiter, isKnownError, log = console }) {
  /* ---------- Undo (unchanged rules) ---------- */

  /**
   * Deletes the last transaction confirmed in this chat (or the one of `undoId`),
   * only while it is undoable and unchanged in Actual.
   */
  async function performUndo(userId, accountId, undoId) {
    const id = typeof undoId === 'string' ? undoId : undo.latestId(userId, accountId);
    const entry = undo.begin(userId, id);
    if (entry.accountId !== accountId) {
      undo.abort(entry.id);
      throw Object.assign(new Error('Não há movimentação recente para desfazer nesta conversa.'), { code: 'NO_UNDO' });
    }
    let result;
    try {
      const connection = requireConnection(userId);
      if (contextKey(connection) !== entry.contextKey) {
        throw new HttpError(409, 'CONNECTION_CHANGED', 'A conexão com o Actual mudou depois do registro. Nada foi desfeito.');
      }
      result = await actual.run(connection, (api) => undoTransaction(api, entry));
    } catch (error) {
      if (error.code === 'ACTUAL_ERROR') {
        // Actual was unreachable before deleting: nothing changed, so undo stays available.
        undo.abort(entry.id);
        error.message = `${error.message} Nada foi desfeito.`;
      } else {
        undo.finish(entry.id);
      }
      throw error;
    }
    undo.finish(entry.id);
    return {
      ok: true,
      kind: 'undo',
      undoneId: entry.id,
      synced: result.synced,
      message: result.synced
        ? `Movimentação desfeita: ${entry.summary}.`
        : `Movimentação desfeita na cópia local (${entry.summary}), mas a sincronização com o servidor Actual falhou. Ela será enviada na próxima sincronização.`,
    };
  }

  /* ---------- Shared building blocks ---------- */

  async function categoryAnswer({ connection, kind, category, amount, categoryId }) {
    const month = currentLocalDate().slice(0, 7);
    const availability = await actual.run(connection, (api) => getSynchronizedCategoryAvailability(api, category, month, categoryId));
    const spending = kind === 'category-can-spend' ? evaluateCategorySpending(availability.available, amountToCents(amount)) : null;
    return {
      ok: true,
      kind,
      message: spending ? text.spendingText(availability.category.name, spending) : text.availabilityText(availability.category.name, availability.available),
      category: availability.category,
      month,
      available: availability.available,
      requested: spending?.requested ?? null,
      remaining: spending?.remaining ?? null,
      canSpend: spending?.canSpend ?? null,
    };
  }

  function previewOf({ command, validation, mapped, date }) {
    return {
      command: publicCommand(command),
      account: validation.account,
      category: validation.category,
      ...(validation.splits ? { splits: validation.splits } : {}),
      transaction: mapped.transaction,
      text: text.previewText(command, validation, date),
    };
  }

  /** One transaction: the same pending preview as always (confirmable once, undoable after). */
  function singlePreview(userId, accountId, prepared, key) {
    const preview = previewOf(prepared);
    const { id, expiresAt } = pending.put(userId, accountId, { mapped: prepared.mapped, preview, contextKey: key });
    conversations.clearDraft(userId, accountId);
    return { ok: true, kind: 'transaction', pendingId: id, expiresAt, preview };
  }

  /** The result of prepareItems: a clarification (draft kept), one preview or a batch preview. */
  function afterPrepare(userId, accountId, result, { ignored = false, notes = [] } = {}) {
    const extra = notes.length ? { notes } : {};
    if (result.status === 'incomplete') {
      const draft = conversations.putDraft(userId, accountId, { items: result.items, missing: result.missing, contextKey: result.key });
      return {
        ok: true,
        kind: 'clarify',
        draftId: draft.id,
        expiresAt: draft.expiresAt,
        message: text.clarifyText(result.missing, result.items, { ignored }),
        items: itemSummaries(result.items),
        missing: result.missing.map((missing) => ({
          item: missing.item,
          part: missing.part,
          field: missing.field,
          label: text.missingLabel(missing, result.items),
          typed: missing.typed ?? null,
          suggestions: missing.suggestions ?? [],
        })),
        categories: result.categories,
        ...extra,
      };
    }
    if (result.previews.length === 1) return { ...singlePreview(userId, accountId, result.previews[0], result.key), ...extra };
    const previews = result.previews.map(previewOf);
    const { id, expiresAt } = pending.put(userId, accountId, {
      batch: true,
      items: result.previews.map((prepared, index) => ({ mapped: prepared.mapped, preview: previews[index] })),
      contextKey: result.key,
    });
    conversations.clearDraft(userId, accountId);
    return { ok: true, kind: 'batch', pendingId: id, expiresAt, account: result.account, items: previews, text: text.batchPreviewText(previews, result.account), ...extra };
  }

  async function prepare(connection, accountId, items, updates = []) {
    const today = currentLocalDate();
    return actual.run(connection, async (api, key) => ({ ...(await prepareItems(api, { accountId, items, updates, today })), key }));
  }

  function draftFor(userId, accountId, connection) {
    const draft = conversations.getDraft(userId, accountId);
    if (draft && draft.contextKey !== contextKey(connection)) {
      // Another server, file or credential: ids in the draft mean nothing there.
      conversations.clearDraft(userId, accountId);
      return null;
    }
    return draft;
  }

  /** Applies updates to the draft. With `localOnly`, returns null unless the reply really completed the missing field. */
  async function continueDraft({ userId, accountId, draft, updates, connection, localOnly = false, notes }) {
    const result = await prepare(connection, accountId, draft.items, updates);
    if (localOnly) {
      const target = updates[0];
      const stillMissing = result.status === 'incomplete' && result.missing.some((missing) => missing.item === target.item && missing.part === target.part && missing.field === target.field);
      if (result.applied === 0 || stillMissing) return null;
    }
    return afterPrepare(userId, accountId, result, { ignored: result.applied === 0, notes });
  }

  /* ---------- Deterministic path (unchanged behavior) ---------- */

  async function runParsed({ userId, accountId, intent, categoryId, connection }) {
    if (intent.kind === 'category-available' || intent.kind === 'category-can-spend') {
      return categoryAnswer({ connection, kind: intent.kind, category: intent.category, amount: intent.amount, categoryId });
    }
    if (categoryId && intent.command?.splits) {
      throw Object.assign(new Error('A escolha de categoria não se aplica a movimentações divididas.'), { code: 'INVALID_INPUT', field: 'categoryId' });
    }
    const date = resolveDate(intent.command.when, currentLocalDate());
    const { validation, mapped, key } = await actual.run(connection, async (api, openKey) => ({
      ...(await prepareTransaction(api, { accountId, command: intent.command, date, categoryId })),
      key: openKey,
    }));
    return singlePreview(userId, accountId, { command: intent.command, validation, mapped, date }, key);
  }

  /* ---------- AI path ---------- */

  function aiCredentials(userId) {
    let credentials;
    try {
      credentials = aiStore.credentials(userId);
    } catch (error) {
      if (error.code === 'SECRET_UNREADABLE') throw new HttpError(409, 'AI_KEY_UNREADABLE', 'Não foi possível ler a chave da OpenAI salva (a APP_SECRET mudou?). Informe a chave novamente nas configurações de IA.');
      throw error;
    }
    if (!credentials) throw new HttpError(409, 'AI_DISABLED', 'A IA está desativada ou sem chave de API. Ative-a nas configurações para usar mensagens livres.');
    return credentials;
  }

  async function runQuery(userId, accountId, connection, operation) {
    if (operation.kind === 'search') return search.answer({ userId, accountId, connection, request: operation.search });
    if (!operation.category) return textAnswer(operation.kind === 'category-can-spend' ? 'Em qual categoria você quer simular o gasto?' : 'De qual categoria você quer saber o saldo?');
    if (operation.kind === 'category-can-spend' && operation.amount === null) return textAnswer(`Qual valor você quer simular em ${operation.category}?`);
    try {
      return await categoryAnswer({ connection, kind: operation.kind, category: operation.category, amount: operation.amount });
    } catch (error) {
      // Typed suggestions instead of buttons: a button would repeat a message only the AI understands.
      if (error.code === 'CATEGORY_NOT_FOUND') return textAnswer(error.message);
      throw error;
    }
  }

  async function dispatchPlan({ userId, accountId, connection, plan, draft }) {
    const notes = [];
    const { operations } = plan;

    if (draft && plan.cancelDraft) {
      conversations.clearDraft(userId, accountId);
      if (!operations.length) return textAnswer(text.DRAFT_DISCARDED);
      notes.push(text.DRAFT_DISCARDED);
    } else if (plan.draftUpdates.length) {
      if (!draft) {
        if (!operations.length) return textAnswer('Não há movimentações incompletas nesta conversa (elas expiram em 15 minutos). Envie a mensagem completa novamente.');
      } else {
        if (operations.length) notes.push('Completei as movimentações pendentes. Envie as outras perguntas ou lançamentos em uma nova mensagem.');
        return continueDraft({ userId, accountId, draft, updates: plan.draftUpdates, connection, notes });
      }
    }

    const transactions = operations.filter((operation) => operation.kind === 'transaction');
    const queries = operations.filter((operation) => ['category-available', 'category-can-spend', 'search'].includes(operation.kind));
    const wantsUndo = operations.some((operation) => operation.kind === 'undo');
    const unsupported = operations.some((operation) => operation.kind === 'unsupported');

    if (queries.length) {
      // Mixed messages: answer the questions, never record anything (no conditional writes).
      if (transactions.length) notes.push(text.MIXED_NOTICE);
      if (queries.length > MAX_QUERIES) notes.push(text.TOO_MANY_QUERIES_NOTICE);
      if (wantsUndo) notes.push(text.UNDO_NOTICE);
      if (unsupported) notes.push(text.UNSUPPORTED_NOTICE);
      const answers = [];
      for (const query of queries.slice(0, MAX_QUERIES)) answers.push(await runQuery(userId, accountId, connection, query));
      if (answers.length === 1) return { ...answers[0], ...(notes.length ? { notes } : {}) };
      return { ok: true, kind: 'answers', answers, ...(notes.length ? { notes } : {}) };
    }

    if (transactions.length) {
      if (wantsUndo) notes.push(text.UNDO_NOTICE);
      if (unsupported) notes.push(text.UNSUPPORTED_NOTICE);
      const result = await prepare(connection, accountId, draftItemsFrom(transactions.map((operation) => operation.item)));
      return afterPrepare(userId, accountId, result, { notes });
    }

    // The AI never deletes anything: undo stays a deterministic command with its own rules.
    if (wantsUndo) return textAnswer(text.UNDO_NOTICE);
    if (unsupported) return textAnswer(text.UNSUPPORTED_NOTICE);
    if (plan.question) return { ...textAnswer(plan.question), ...(notes.length ? { notes } : {}) };
    return { ...textAnswer(notes.length ? notes.shift() : text.NOT_UNDERSTOOD), ...(notes.length ? { notes } : {}) };
  }

  async function runAi({ userId, accountId, message }) {
    const limiterKey = `user:${userId}`;
    const { allowed, retryAfterMs } = aiLimiter.check(limiterKey);
    if (!allowed) {
      throw new HttpError(429, 'AI_TOO_MANY', 'Muitas mensagens para a IA em pouco tempo. Aguarde alguns minutos ou use os formatos que o Finance Chat entende sem IA.', { retryAfter: Math.ceil(retryAfterMs / 1000) });
    }
    const credentials = aiCredentials(userId);
    const connection = requireConnection(userId);
    // The account is checked (and the category names read) before any token is spent.
    const categories = await actual.run(connection, async (api) => {
      await api.sync();
      requireChatAccount(await api.getAccounts(), accountId);
      return api.getCategories();
    });
    const draft = draftFor(userId, accountId, connection);
    const lastSearch = conversations.getQuery(userId, accountId);
    const today = currentLocalDate();
    const context = {
      today,
      weekday: weekdayOf(today),
      currency: 'BRL',
      categories: contextCategories(categories),
      draft: draft ? draftContext(draft.items) : null,
      lastSearch: lastSearch ? search.context(lastSearch) : null,
      message,
    };
    aiLimiter.hit(limiterKey);
    const { plan: raw, responseId } = await interpreter.interpret({ userId, credentials, context });
    let plan;
    try {
      plan = normalizePlan(raw);
    } catch (error) {
      if (error.code === 'AI_INVALID_PLAN') {
        aiStore.setOutcome(userId, responseId, 'rejected');
        log.error(`[openai] AI_INVALID_PLAN reason=${error.reason}${responseId ? ` response=${responseId}` : ''}`);
      }
      throw error;
    }
    return withSource(await dispatchPlan({ userId, accountId, connection, plan, draft }), 'ai');
  }

  /* ---------- Entry points ---------- */

  return {
    performUndo,

    /** POST /api/chat/preview. Writes nothing. */
    async handleMessage({ userId, accountId, message, categoryId }) {
      const settings = aiStore.settings(userId);
      const aiOn = settings.enabled && settings.hasKey;
      let intent = null;
      let parseError = null;
      try {
        intent = parseMessage(message);
      } catch (error) {
        if (error.code !== 'INVALID_COMMAND') throw error;
        parseError = error;
      }
      if (intent?.kind === 'undo') return performUndo(userId, accountId);

      if (!intent) {
        // Not a message at all (empty, not text): same answer as always, never sent anywhere.
        if (typeof message !== 'string' || !message.trim()) throw parseError;
        // A short reply to a pending clarification ("Alimentação", "50") is completed locally, without the AI.
        const update = localDraftUpdate(conversations.getDraft(userId, accountId)?.missing ?? [], message);
        if (update) {
          const connection = requireConnection(userId);
          const draft = draftFor(userId, accountId, connection);
          const local = draft ? await continueDraft({ userId, accountId, draft, updates: [update], connection, localOnly: true }) : null;
          if (local) return withSource(local, 'local');
        }
        if (!aiOn) throw parseError;
        return runAi({ userId, accountId, message });
      }

      const connection = requireConnection(userId);
      if (!aiOn || categoryId) return withSource(await runParsed({ userId, accountId, intent, categoryId, connection }), 'parser');
      if (isCompleteParse(intent).complete) {
        try {
          return withSource(await runParsed({ userId, accountId, intent, connection }), 'parser');
        } catch (error) {
          // A category that does not match the budget may be a partial parse: let the AI read the whole message.
          if (!error.categoryMiss) throw error;
        }
      }
      return runAi({ userId, accountId, message });
    },

    /** POST /api/chat/draft: a category picked on screen for a missing field. No AI call. */
    async chooseCategory({ userId, accountId, draftId, item, part, categoryId }) {
      const connection = requireConnection(userId);
      const draft = draftFor(userId, accountId, connection);
      if (!draft || draft.id !== draftId) {
        throw Object.assign(new Error('Estas movimentações não estão mais pendentes (expiraram ou foram substituídas). Envie a mensagem novamente.'), { code: 'NO_DRAFT' });
      }
      return withSource(await continueDraft({ userId, accountId, draft, updates: [{ item, part, field: 'category', categoryId }], connection }), 'local');
    },

    cancelDraft({ userId, accountId, draftId }) {
      const draft = conversations.getDraft(userId, accountId);
      if (!draft || draft.id !== draftId) return false;
      conversations.clearDraft(userId, accountId);
      return true;
    },

    /** POST /api/chat/confirm: the only place where the chat writes transactions. */
    async confirm({ userId, pendingId }) {
      // Taken (removed) before writing: a repeated confirmation finds nothing to write.
      const entry = pending.take(userId, pendingId);
      const connection = requireConnection(userId);
      if (contextKey(connection) !== entry.contextKey) {
        throw new HttpError(409, 'CONNECTION_CHANGED', 'A conexão com o Actual mudou depois da prévia. Nada foi registrado; envie a mensagem novamente.');
      }
      if (entry.batch) return confirmBatch(userId, entry, connection);

      let result;
      try {
        result = await actual.run(connection, (api) => commitTransaction(api, entry.mapped));
      } catch (error) {
        if (error.code !== 'WRITE_UNCERTAIN' && isKnownError(error.code)) error.message = `${error.message} Nada foi registrado.`;
        throw error;
      }
      // The last confirmed transaction of the chat can be undone for a few minutes.
      const undoable = result.transactionId
        ? undo.put(userId, entry.accountId, {
          transactionId: result.transactionId,
          date: entry.mapped.transaction.date,
          amount: entry.mapped.transaction.amount,
          contextKey: entry.contextKey,
          summary: text.summaryText(entry.preview),
        })
        : null;
      return {
        ok: true,
        synced: result.synced,
        account: result.account,
        message: result.synced ? text.successText(entry.preview, result.account) : text.unsyncedText(entry.preview, result.account),
        ...(undoable ? { undoId: undoable.id, undoExpiresAt: undoable.expiresAt, undoTtlMs: Math.max(0, undoable.expiresAt - Date.now()) } : {}),
      };
    },
  };

  async function confirmBatch(userId, entry, connection) {
    let result;
    try {
      result = await actual.run(connection, (api) => commitTransactions(api, entry.items.map((item) => item.mapped)));
    } catch (error) {
      if (isKnownError(error.code)) error.message = `${error.message} Nada foi registrado.`;
      throw error;
    }
    // A batch cannot be undone; "desfazer" must not delete an older transaction instead.
    if (result.results.some((status) => status !== 'skipped')) undo.discard(userId, entry.accountId);
    const previews = entry.items.map((item) => item.preview);
    const complete = result.results.every((status) => status === 'written');
    if (!complete) log.error(`[actual] BATCH_INCOMPLETE ${result.results.join(',')}`);
    return {
      ok: true,
      kind: 'batch',
      complete,
      synced: result.synced,
      account: result.account,
      results: result.results,
      message: text.batchResultText(previews, result),
    };
  }

}
