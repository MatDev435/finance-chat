import { contextKey } from './actual.js';
import { getSynchronizedCategoryAvailability } from './budget-availability.js';
import { commitTransaction, listChatAccounts, prepareTransaction, undoTransaction } from './budget-operations.js';
import { evaluateCategorySpending } from './category-queries.js';
import {
  HttpError, applySecurityHeaders, clientIp, isCrossSite, isSecureRequest, parseCookies, readJson,
  sendJson, serializeCookie, serveStatic,
} from './http.js';
import { resolveDate } from './dates.js';
import { amountToCents, parseMessage } from './parser.js';
import { createRateLimiter } from './rate-limit.js';
import { currentLocalDate } from './transaction-mapping.js';
import { createUndoStore } from './undo.js';
import { ACCOUNT_ID_PATTERN, inputError, resolveConnectionInput } from './user-store.js';
import { AI_MODELS, DEFAULT_MODEL, findModel } from './ai/models.js';
import { aiError, createInterpreter } from './ai/interpreter.js';
import { weekdayOf } from './ai/plan-schema.js';
import { perMillionText, priceTableAt } from './ai/pricing.js';
import { apiKeyFrom, resolveAiSettingsInput } from './ai/store.js';

export const ACCESS_COOKIE = 'fc_access';
export const REFRESH_COOKIE = 'fc_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';
const MAX_MESSAGE_LENGTH = 500;
const MINUTE = 60 * 1000;

const ERROR_STATUS = {
  INVALID_INPUT: 400,
  INVALID_COMMAND: 400,
  VALIDATION_ERROR: 400,
  CATEGORY_NOT_FOUND: 400,
  SIGNUP_DISABLED: 403,
  USERNAME_TAKEN: 409,
  ACCOUNT_UNAVAILABLE: 409,
  NO_PENDING_TRANSACTION: 409,
  PENDING_EXPIRED: 409,
  NO_UNDO: 409,
  UNDO_EXPIRED: 409,
  UNDO_NOT_FOUND: 409,
  UNDO_CHANGED: 409,
  ACTUAL_ERROR: 503,
  WRITE_UNCERTAIN: 503,
  UNDO_UNCERTAIN: 503,
  // AI mode: OpenAI errors (src/ai/openai-client.js) and interpretation outcomes.
  AI_AUTH: 502,
  AI_FORBIDDEN: 502,
  AI_QUOTA: 502,
  AI_MODEL_UNAVAILABLE: 502,
  AI_BAD_REQUEST: 502,
  AI_INVALID_OUTPUT: 502,
  AI_UNAVAILABLE: 503,
  AI_NETWORK: 503,
  AI_TIMEOUT: 504,
  AI_RATE_LIMIT: 429,
  AI_TOO_MANY: 429,
  AI_REFUSAL: 422,
  AI_INCOMPLETE: 422,
  AI_INVALID_PLAN: 422,
  AI_KEY_UNREADABLE: 409,
};

function moneyText(amount) {
  return amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function typeText(type) {
  return type === 'expense' ? 'Despesa' : 'Receita';
}

function dateText(date) {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** "Categoria: Alimentação" or, for a split, "Categorias: Alimentação (R$ 70,00), Limpeza (R$ 30,00)". */
function categoryText({ category, splits }) {
  if (splits) return `Categorias: ${splits.map((split) => `${split.category.name} (${moneyText(split.amount)})`).join(', ')}`;
  return `Categoria: ${category.name}`;
}

function previewText(command, validation, date) {
  const noteLine = command.notes ? `\nNota: ${command.notes}` : '';
  return `Vou registrar esta movimentação:\n\nTipo: ${typeText(command.type)}\nValor: ${moneyText(command.amount)}\nBeneficiário: ${command.description}\nConta: ${validation.account.name}\n${categoryText(validation)}\nData: ${dateText(date)}${noteLine}\n\nDeseja confirmar?`;
}

function successText(preview, account) {
  // The date is mentioned only when it is not today, keeping the usual message unchanged.
  const date = preview.transaction.date;
  const dateLine = date !== currentLocalDate() ? `\nData: ${dateText(date)}.` : '';
  return `Movimentação registrada com sucesso!\n\n${typeText(preview.command.type)} de ${moneyText(preview.command.amount)} para ${preview.command.description}.\nConta: ${account.name}.\n${categoryText(preview)}.${dateLine}`;
}

/** "Despesa de R$ 40,00 para mercado" */
function summaryText(preview) {
  return `${typeText(preview.command.type)} de ${moneyText(preview.command.amount)} para ${preview.command.description}`;
}

function unsyncedText(preview, account) {
  return `Movimentação registrada, mas a sincronização com o servidor Actual falhou.\n\n${typeText(preview.command.type)} de ${moneyText(preview.command.amount)} para ${preview.command.description} na conta ${account.name}.\nEla será enviada na próxima sincronização. Não envie de novo.`;
}

function optionalCategoryId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) throw inputError('Categoria inválida.', 'categoryId');
  return value;
}

function accountIdFrom(value) {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) throw inputError('Selecione uma conta válida.', 'accountId');
  return value;
}

/** Models offered in the settings, with the prices of the table in force (USD per 1M tokens). */
function publicModels() {
  const table = priceTableAt(Date.now());
  return AI_MODELS.map(({ id, name, description }) => {
    const price = table?.models[id];
    return {
      id, name, description,
      prices: price ? { input: perMillionText(price.input), cachedInput: perMillionText(price.cachedInput), output: perMillionText(price.output) } : null,
    };
  });
}

/** The message used by the explicit key test: exercises the real schema with a tiny, fictitious context. */
function probeContext() {
  const today = currentLocalDate();
  return { today, weekday: weekdayOf(today), currency: 'BRL', categories: ['Teste'], draft: null, lastSearch: null, message: 'Quanto tenho disponível em Teste?' };
}

export function createApp({ config, auth, store, aiStore, openai, actual, pending, undo = createUndoStore(), publicDir, log = console }) {
  const limiters = {
    loginIp: createRateLimiter({ limit: 20, windowMs: 15 * MINUTE }),
    loginUser: createRateLimiter({ limit: 5, windowMs: 15 * MINUTE }),
    signup: createRateLimiter({ limit: 10, windowMs: 60 * MINUTE }),
    connectionTest: createRateLimiter({ limit: 10, windowMs: 5 * MINUTE }),
    aiTest: createRateLimiter({ limit: 10, windowMs: 5 * MINUTE }),
    aiChat: createRateLimiter({ limit: 40, windowMs: 10 * MINUTE }),
  };
  const interpreter = createInterpreter({ client: openai, aiStore, log });

  function logOpenAI(error) {
    if (error?.code?.startsWith?.('AI_')) log.error(`[openai] ${error.code}${error.status ? ` status=${error.status}` : ''}${error.apiCode ? ` code=${error.apiCode}` : ''}${error.requestId ? ` request=${error.requestId}` : ''}`);
  }

  /** The stored key for an explicit test; a key sealed with another APP_SECRET asks for it again. */
  function storedKey(userId) {
    try {
      return aiStore.storedKey(userId);
    } catch (error) {
      if (error.code === 'SECRET_UNREADABLE') throw new HttpError(409, 'AI_KEY_UNREADABLE', 'Não foi possível ler a chave da OpenAI salva (a APP_SECRET mudou?). Informe a chave novamente.');
      throw error;
    }
  }

  function enforce(limiter, key) {
    const { allowed, retryAfterMs } = limiter.check(key);
    if (!allowed) {
      const minutes = Math.max(1, Math.ceil(retryAfterMs / MINUTE));
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `Muitas tentativas. Tente novamente em ${minutes} minuto${minutes > 1 ? 's' : ''}.`, { retryAfter: Math.ceil(retryAfterMs / 1000) });
    }
  }

  function setSessionCookies(ctx, session) {
    const now = Date.now();
    ctx.response.setHeader('Set-Cookie', [
      serializeCookie(ACCESS_COOKIE, session.accessToken, { path: '/', maxAge: (session.accessExpiresAt - now) / 1000, secure: ctx.secure }),
      serializeCookie(REFRESH_COOKIE, session.refreshToken, { path: REFRESH_COOKIE_PATH, maxAge: (session.refreshExpiresAt - now) / 1000, secure: ctx.secure }),
    ]);
  }

  function clearSessionCookies(ctx) {
    ctx.response.setHeader('Set-Cookie', [
      serializeCookie(ACCESS_COOKIE, '', { path: '/', maxAge: 0, secure: ctx.secure }),
      serializeCookie(REFRESH_COOKIE, '', { path: REFRESH_COOKIE_PATH, maxAge: 0, secure: ctx.secure }),
    ]);
  }

  function requireConnection(userId) {
    let connection;
    try {
      connection = store.getConnection(userId);
    } catch (error) {
      if (error.code === 'SECRET_UNREADABLE') {
        throw new HttpError(409, 'CONNECTION_UNREADABLE', 'Não foi possível ler as credenciais salvas do Actual (a APP_SECRET mudou?). Configure a conexão novamente.');
      }
      throw error;
    }
    if (!connection) throw new HttpError(409, 'CONNECTION_REQUIRED', 'Configure a conexão com o Actual Budget primeiro.');
    return connection;
  }

  function existingConnection(userId) {
    try {
      return store.getConnection(userId);
    } catch {
      return null;
    }
  }

  function candidateConnection(ctx) {
    enforce(limiters.connectionTest, `user:${ctx.user.id}`);
    limiters.connectionTest.hit(`user:${ctx.user.id}`);
    return { userId: ctx.user.id, ...resolveConnectionInput(ctx.body, existingConnection(ctx.user.id)) };
  }

  /**
   * Deletes the last transaction confirmed in this chat (or the one of `undoId`),
   * only while it is undoable and unchanged in Actual.
   */
  async function performUndo(ctx, accountId, undoId) {
    const id = typeof undoId === 'string' ? undoId : undo.latestId(ctx.user.id, accountId);
    const entry = undo.begin(ctx.user.id, id);
    if (entry.accountId !== accountId) {
      undo.abort(entry.id);
      throw Object.assign(new Error('Não há movimentação recente para desfazer nesta conversa.'), { code: 'NO_UNDO' });
    }
    let result;
    try {
      const connection = requireConnection(ctx.user.id);
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

  const routes = {
    'GET /api/auth/options': {
      public: true,
      handler(ctx) {
        const firstUser = auth.userCount() === 0;
        return sendJson(ctx.response, 200, { ok: true, signupOpen: config.allowSignup || firstUser, firstUser });
      },
    },

    'POST /api/auth/register': {
      public: true,
      async handler(ctx) {
        enforce(limiters.signup, `ip:${ctx.ip}`);
        limiters.signup.hit(`ip:${ctx.ip}`);
        const user = await auth.register(ctx.body.username, ctx.body.password, { allowSignup: config.allowSignup });
        setSessionCookies(ctx, auth.createSession(user.id));
        return sendJson(ctx.response, 201, { ok: true, user });
      },
    },

    'POST /api/auth/login': {
      public: true,
      async handler(ctx) {
        const username = typeof ctx.body.username === 'string' ? ctx.body.username.trim().toLowerCase().slice(0, 64) : '';
        const ipKey = `ip:${ctx.ip}`;
        const userKey = `user:${username}`;
        enforce(limiters.loginIp, ipKey);
        enforce(limiters.loginUser, userKey);
        const user = await auth.verifyCredentials(ctx.body.username, ctx.body.password);
        if (!user) {
          limiters.loginIp.hit(ipKey);
          limiters.loginUser.hit(userKey);
          throw new HttpError(401, 'INVALID_CREDENTIALS', 'Usuário ou senha incorretos.');
        }
        limiters.loginUser.reset(userKey);
        setSessionCookies(ctx, auth.createSession(user.id));
        return sendJson(ctx.response, 200, { ok: true, user });
      },
    },

    'POST /api/auth/refresh': {
      public: true,
      handler(ctx) {
        const result = auth.refresh(ctx.cookies[REFRESH_COOKIE]);
        if (result.status !== 'rotated') {
          clearSessionCookies(ctx);
          throw new HttpError(401, 'SESSION_EXPIRED', 'Sua sessão expirou. Entre novamente.');
        }
        setSessionCookies(ctx, result);
        return sendJson(ctx.response, 200, { ok: true });
      },
    },

    'POST /api/auth/logout': {
      public: true,
      handler(ctx) {
        auth.logout({ accessToken: ctx.cookies[ACCESS_COOKIE], refreshToken: ctx.cookies[REFRESH_COOKIE] });
        clearSessionCookies(ctx);
        return sendJson(ctx.response, 200, { ok: true });
      },
    },

    'GET /api/me': {
      handler: (ctx) => sendJson(ctx.response, 200, {
        ok: true,
        user: ctx.user,
        connection: store.connectionSummary(ctx.user.id),
        settings: store.getSettings(ctx.user.id),
        ai: aiStore.settings(ctx.user.id),
      }),
    },

    'GET /api/ai': {
      handler(ctx) {
        const table = priceTableAt(Date.now());
        return sendJson(ctx.response, 200, {
          ok: true,
          settings: aiStore.settings(ctx.user.id),
          models: publicModels(),
          defaultModel: DEFAULT_MODEL,
          pricing: table ? { version: table.version, source: table.source } : null,
          usage: aiStore.usageSummary(ctx.user.id),
        });
      },
    },

    'PUT /api/ai/settings': {
      handler(ctx) {
        const settings = aiStore.update(ctx.user.id, resolveAiSettingsInput(ctx.body));
        return sendJson(ctx.response, 200, { ok: true, settings });
      },
    },

    /**
     * Explicit test of a key and model (typed or saved), without saving: the key
     * must list the model (when it can list models at all) and the model must
     * answer one request with the real Structured Outputs schema. The test
     * request is billed like any other and recorded with purpose "test".
     */
    'POST /api/ai/test': {
      async handler(ctx) {
        const userKey = `user:${ctx.user.id}`;
        enforce(limiters.aiTest, userKey);
        limiters.aiTest.hit(userKey);
        const requested = ctx.body.model === undefined ? aiStore.settings(ctx.user.id).model : ctx.body.model;
        const model = typeof requested === 'string' ? findModel(requested) : null;
        if (!model) throw inputError('Escolha um dos modelos da lista.', 'model');
        const apiKey = ctx.body.apiKey ? apiKeyFrom(ctx.body.apiKey) : storedKey(ctx.user.id);
        if (!apiKey) throw inputError('Informe a chave de API da OpenAI.', 'apiKey');

        let listed = null;
        try {
          listed = await openai.listModels({ apiKey });
        } catch (error) {
          logOpenAI(error);
          // A restricted key may be allowed to create responses without listing models.
          if (error.code !== 'AI_FORBIDDEN') throw error;
        }
        if (listed && !listed.includes(model.id)) {
          throw aiError('AI_MODEL_UNAVAILABLE', `A chave funciona, mas o modelo ${model.name} não está disponível para ela. Escolha outro modelo.`);
        }
        try {
          await interpreter.interpret({ userId: ctx.user.id, credentials: { model: model.id, apiKey }, context: probeContext(), purpose: 'test' });
        } catch (error) {
          // A truncated answer still proves that the key, the model and the schema were accepted.
          if (error.code !== 'AI_INCOMPLETE') throw error;
        }
        return sendJson(ctx.response, 200, {
          ok: true,
          message: `Chave e modelo funcionando: o ${model.name} respondeu no formato esperado.`,
          availableModels: listed ? AI_MODELS.filter((item) => listed.includes(item.id)).map((item) => item.id) : null,
          usage: aiStore.usageSummary(ctx.user.id),
        });
      },
    },

    'POST /api/connection/test': {
      async handler(ctx) {
        const accounts = await actual.test(candidateConnection(ctx), listChatAccounts);
        return sendJson(ctx.response, 200, { ok: true, accounts, message: `Conexão funcionando! ${accounts.length} conta${accounts.length === 1 ? '' : 's'} encontrada${accounts.length === 1 ? '' : 's'}.` });
      },
    },

    'PUT /api/connection': {
      async handler(ctx) {
        const candidate = candidateConnection(ctx);
        // Saved only after a successful test with exactly these values.
        const accounts = await actual.test(candidate, listChatAccounts);
        store.saveConnection(ctx.user.id, candidate);
        return sendJson(ctx.response, 200, { ok: true, accounts, connection: store.connectionSummary(ctx.user.id) });
      },
    },

    'GET /api/accounts': {
      async handler(ctx) {
        const accounts = await actual.run(requireConnection(ctx.user.id), listChatAccounts);
        return sendJson(ctx.response, 200, { ok: true, accounts });
      },
    },

    'PUT /api/settings': {
      async handler(ctx) {
        const { defaultAccountId } = ctx.body;
        if (defaultAccountId === null) {
          return sendJson(ctx.response, 200, { ok: true, settings: store.setDefaultAccount(ctx.user.id, null) });
        }
        const accountId = accountIdFrom(defaultAccountId);
        const accounts = await actual.run(requireConnection(ctx.user.id), listChatAccounts);
        if (!accounts.some((account) => account.id === accountId)) {
          throw Object.assign(new Error('Essa conta não está disponível no Actual Budget. Atualize a lista de contas.'), { code: 'ACCOUNT_UNAVAILABLE' });
        }
        return sendJson(ctx.response, 200, { ok: true, settings: store.setDefaultAccount(ctx.user.id, accountId) });
      },
    },

    'POST /api/chat/preview': {
      async handler(ctx) {
        const accountId = accountIdFrom(ctx.body.accountId);
        const { message } = ctx.body;
        const categoryId = optionalCategoryId(ctx.body.categoryId);
        if (typeof message === 'string' && message.length > MAX_MESSAGE_LENGTH) throw inputError(`A mensagem pode ter no máximo ${MAX_MESSAGE_LENGTH} caracteres.`, 'message');
        const intent = parseMessage(message);
        if (intent.kind === 'undo') return sendJson(ctx.response, 200, await performUndo(ctx, accountId));
        if (categoryId && intent.command?.splits) throw inputError('A escolha de categoria não se aplica a movimentações divididas.', 'categoryId');
        const connection = requireConnection(ctx.user.id);

        if (intent.kind === 'category-available' || intent.kind === 'category-can-spend') {
          const month = currentLocalDate().slice(0, 7);
          const availability = await actual.run(connection, (api) => getSynchronizedCategoryAvailability(api, intent.category, month, categoryId));
          const spending = intent.kind === 'category-can-spend' ? evaluateCategorySpending(availability.available, amountToCents(intent.amount)) : null;
          const requested = spending?.requested ?? null;
          const categoryMessage = requested === null
            ? `Você tem ${moneyText(availability.available / 100)} disponíveis em ${availability.category.name} este mês.`
            : spending.canSpend
              ? `Sim, você pode gastar esse valor em ${availability.category.name}.`
              : `Não, você não tem saldo suficiente para esse gasto em ${availability.category.name}.`;
          return sendJson(ctx.response, 200, {
            ok: true,
            kind: intent.kind,
            message: categoryMessage,
            category: availability.category,
            month,
            available: availability.available,
            requested,
            remaining: spending?.remaining ?? null,
            canSpend: spending?.canSpend ?? null,
          });
        }

        const date = resolveDate(intent.command.when, currentLocalDate());
        const { validation, mapped, key } = await actual.run(connection, async (api, openKey) => ({
          ...(await prepareTransaction(api, { accountId, command: intent.command, date, categoryId })),
          key: openKey,
        }));
        const preview = {
          command: intent.command,
          account: validation.account,
          category: validation.category,
          ...(validation.splits ? { splits: validation.splits } : {}),
          transaction: mapped.transaction,
          text: previewText(intent.command, validation, date),
        };
        const { id, expiresAt } = pending.put(ctx.user.id, accountId, { mapped, preview, contextKey: key });
        return sendJson(ctx.response, 200, { ok: true, kind: 'transaction', pendingId: id, expiresAt, preview });
      },
    },

    'POST /api/chat/confirm': {
      async handler(ctx) {
        // Taken (removed) before writing: a repeated confirmation finds nothing to write.
        const entry = pending.take(ctx.user.id, ctx.body.pendingId);
        const connection = requireConnection(ctx.user.id);
        if (contextKey(connection) !== entry.contextKey) {
          throw new HttpError(409, 'CONNECTION_CHANGED', 'A conexão com o Actual mudou depois da prévia. Nada foi registrado; envie a mensagem novamente.');
        }
        let result;
        try {
          result = await actual.run(connection, (api) => commitTransaction(api, entry.mapped));
        } catch (error) {
          if (error.code !== 'WRITE_UNCERTAIN' && ERROR_STATUS[error.code]) error.message = `${error.message} Nada foi registrado.`;
          throw error;
        }
        // The last confirmed transaction of the chat can be undone for a few minutes.
        const undoable = result.transactionId
          ? undo.put(ctx.user.id, entry.accountId, {
            transactionId: result.transactionId,
            date: entry.mapped.transaction.date,
            amount: entry.mapped.transaction.amount,
            contextKey: entry.contextKey,
            summary: summaryText(entry.preview),
          })
          : null;
        return sendJson(ctx.response, 200, {
          ok: true,
          synced: result.synced,
          account: result.account,
          message: result.synced ? successText(entry.preview, result.account) : unsyncedText(entry.preview, result.account),
          ...(undoable ? { undoId: undoable.id, undoExpiresAt: undoable.expiresAt, undoTtlMs: Math.max(0, undoable.expiresAt - Date.now()) } : {}),
        });
      },
    },

    'POST /api/chat/undo': {
      async handler(ctx) {
        const accountId = accountIdFrom(ctx.body.accountId);
        return sendJson(ctx.response, 200, await performUndo(ctx, accountId, ctx.body.undoId));
      },
    },

    'POST /api/chat/cancel': {
      handler(ctx) {
        pending.cancel(ctx.user.id, ctx.body.pendingId);
        return sendJson(ctx.response, 200, { ok: true, message: 'Movimentação cancelada.' });
      },
    },
  };

  function sendError(response, error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof HttpError) {
      const headers = error.extra.retryAfter ? { 'Retry-After': String(error.extra.retryAfter) } : {};
      if (error.status === 413) headers.Connection = 'close';
      return sendJson(response, error.status, { ok: false, code: error.code, error: error.message }, headers);
    }
    const status = ERROR_STATUS[error?.code];
    if (status && error.retryAfter) {
      return sendJson(response, status, { ok: false, code: error.code, error: error.message, retryAfter: error.retryAfter }, { 'Retry-After': String(error.retryAfter) });
    }
    if (status) {
      if (['ACTUAL_ERROR', 'WRITE_UNCERTAIN', 'UNDO_UNCERTAIN'].includes(error.code)) log.error(`[actual] ${error.code} ${error.reason || ''} ${error.detail || error.cause?.code || ''}`.trim());
      const body = { ok: false, code: error.code, error: error.message };
      if (error.field) body.field = error.field;
      if (error.reason) body.reason = error.reason;
      if (Array.isArray(error.suggestions)) body.suggestions = error.suggestions;
      return sendJson(response, status, body);
    }
    log.error('[http] unexpected error', error);
    return sendJson(response, 500, { ok: false, code: 'INTERNAL_ERROR', error: 'Erro interno. Tente novamente.' });
  }

  return async function handle(request, response) {
    applySecurityHeaders(response);
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      if (pathname === '/health' && request.method === 'GET') return sendJson(response, 200, { ok: true });

      if (pathname.startsWith('/api/')) {
        const route = routes[`${request.method} ${pathname}`];
        if (!route) throw new HttpError(404, 'NOT_FOUND', 'Rota não encontrada.');
        const ctx = {
          request,
          response,
          ip: clientIp(request, config.trustProxy),
          secure: isSecureRequest(request, config.cookieSecure),
          cookies: parseCookies(request.headers.cookie),
          body: {},
        };
        if (request.method !== 'GET' && isCrossSite(request, config.trustProxy)) throw new HttpError(403, 'CROSS_SITE', 'Origem não permitida.');
        if (!route.public) {
          const session = auth.authenticate(ctx.cookies[ACCESS_COOKIE]);
          if (!session) throw new HttpError(401, 'AUTH_REQUIRED', 'Sua sessão expirou. Entre novamente.');
          ctx.user = session.user;
        }
        if (request.method !== 'GET') ctx.body = await readJson(request);
        return await route.handler(ctx);
      }

      if (request.method === 'GET' || request.method === 'HEAD') return await serveStatic(request, response, publicDir, pathname);
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
    } catch (error) {
      return sendError(response, error);
    }
  };
}
