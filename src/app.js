import { contextKey } from './actual.js';
import { getSynchronizedCategoryAvailability } from './budget-availability.js';
import { commitTransaction, listChatAccounts, prepareTransaction } from './budget-operations.js';
import { evaluateCategorySpending } from './category-queries.js';
import {
  HttpError, applySecurityHeaders, clientIp, isCrossSite, isSecureRequest, parseCookies, readJson,
  sendJson, serializeCookie, serveStatic,
} from './http.js';
import { resolveDate } from './dates.js';
import { amountToCents, parseMessage } from './parser.js';
import { createRateLimiter } from './rate-limit.js';
import { currentLocalDate } from './transaction-mapping.js';
import { ACCOUNT_ID_PATTERN, inputError, resolveConnectionInput } from './user-store.js';

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
  ACTUAL_ERROR: 503,
  WRITE_UNCERTAIN: 503,
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

function previewText(command, validation, date) {
  const noteLine = command.notes ? `\nNota: ${command.notes}` : '';
  return `Vou registrar esta movimentação:\n\nTipo: ${typeText(command.type)}\nValor: ${moneyText(command.amount)}\nBeneficiário: ${command.description}\nConta: ${validation.account.name}\nCategoria: ${validation.category.name}\nData: ${dateText(date)}${noteLine}\n\nDeseja confirmar?`;
}

function successText(preview, account) {
  // The date is mentioned only when it is not today, keeping the usual message unchanged.
  const date = preview.transaction.date;
  const dateLine = date !== currentLocalDate() ? `\nData: ${dateText(date)}.` : '';
  return `Movimentação registrada com sucesso!\n\n${typeText(preview.command.type)} de ${moneyText(preview.command.amount)} para ${preview.command.description}.\nConta: ${account.name}.\nCategoria: ${preview.category.name}.${dateLine}`;
}

function unsyncedText(preview, account) {
  return `Movimentação registrada, mas a sincronização com o servidor Actual falhou.\n\n${typeText(preview.command.type)} de ${moneyText(preview.command.amount)} para ${preview.command.description} na conta ${account.name}.\nEla será enviada na próxima sincronização. Não envie de novo.`;
}

function accountIdFrom(value) {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) throw inputError('Selecione uma conta válida.', 'accountId');
  return value;
}

export function createApp({ config, auth, store, actual, pending, publicDir, log = console }) {
  const limiters = {
    loginIp: createRateLimiter({ limit: 20, windowMs: 15 * MINUTE }),
    loginUser: createRateLimiter({ limit: 5, windowMs: 15 * MINUTE }),
    signup: createRateLimiter({ limit: 10, windowMs: 60 * MINUTE }),
    connectionTest: createRateLimiter({ limit: 10, windowMs: 5 * MINUTE }),
  };

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
      }),
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
        if (typeof message === 'string' && message.length > MAX_MESSAGE_LENGTH) throw inputError(`A mensagem pode ter no máximo ${MAX_MESSAGE_LENGTH} caracteres.`, 'message');
        const intent = parseMessage(message);
        const connection = requireConnection(ctx.user.id);

        if (intent.kind === 'category-available' || intent.kind === 'category-can-spend') {
          const month = currentLocalDate().slice(0, 7);
          const availability = await actual.run(connection, (api) => getSynchronizedCategoryAvailability(api, intent.category, month));
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
          ...(await prepareTransaction(api, { accountId, command: intent.command, date })),
          key: openKey,
        }));
        const preview = {
          command: intent.command,
          account: validation.account,
          category: validation.category,
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
        return sendJson(ctx.response, 200, {
          ok: true,
          synced: result.synced,
          account: result.account,
          message: result.synced ? successText(entry.preview, result.account) : unsyncedText(entry.preview, result.account),
        });
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
    if (status) {
      if (error.code === 'ACTUAL_ERROR' || error.code === 'WRITE_UNCERTAIN') log.error(`[actual] ${error.code} ${error.reason || ''} ${error.detail || error.cause?.code || ''}`.trim());
      const body = { ok: false, code: error.code, error: error.message };
      if (error.field) body.field = error.field;
      if (error.reason) body.reason = error.reason;
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
