import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransaction, getAccounts, getCategories, getCategoryAvailability, shutdown } from './actual.js';
import { amountToCents, parseCommand, parseMessage } from './parser.js';
import { evaluateCategorySpending } from './category-queries.js';
import { confirmPending, cancelPending, setPending } from './pending.js';
import { currentLocalDate, toActualImport } from './transaction-mapping.js';
import { validateCommand } from './validation.js';

const port = Number(process.env.PORT || 3000);
const publicDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const corsOrigin = process.env.CORS_ORIGIN?.trim();

const contentTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url;
  const file = normalize(join(publicDir, requested));
  if (!file.startsWith(publicDir)) return send(response, 404, { ok: false });
  try {
    const body = await readFile(file);
    send(response, 200, body, contentTypes[extname(file)] || 'application/octet-stream');
  } catch {
    send(response, 404, { ok: false });
  }
}

const server = createServer(async (request, response) => {
  if (corsOrigin && request.headers.origin === corsOrigin) {
    response.setHeader('Access-Control-Allow-Origin', corsOrigin);
    response.setHeader('Vary', 'Origin');
  }
  if (request.method === 'OPTIONS') {
    if (corsOrigin && request.headers.origin === corsOrigin) {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return send(response, 204, '');
    }
    return send(response, 403, { ok: false });
  }
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true });
  if (request.method === 'GET' && request.url === '/favicon.ico') {
    response.writeHead(204);
    return response.end();
  }
  if (request.method === 'GET' && (request.url === '/' || request.url.startsWith('/app.'))) return serveStatic(request, response);

  if (request.method === 'POST' && request.url === '/parse') {
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const { message } = JSON.parse(body);
      return send(response, 200, { ok: true, command: parseCommand(message) });
    } catch (error) {
      return send(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === 'POST' && request.url === '/validate') {
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const { message } = JSON.parse(body);
      const command = parseCommand(message);
      const [accounts, categories] = await Promise.all([getAccounts(), getCategories()]);
      return send(response, 200, validateCommand(command, { accounts, categories }));
    } catch (error) {
      if (error.code === 'VALIDATION_ERROR' || error.code === 'INVALID_COMMAND') {
        return send(response, 400, { ok: false, error: error.message });
      }
      return send(response, 503, { ok: false, error: 'Não foi possível consultar o Actual Budget.', code: error.publicCode || 'actual' });
    }
  }

  if (request.method === 'POST' && request.url === '/preview') {
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const { message } = JSON.parse(body);
      const intent = parseMessage(message);
      if (intent.kind === 'category-available' || intent.kind === 'category-can-spend') {
        const month = currentLocalDate().slice(0, 7);
        const availability = await getCategoryAvailability(intent.category, month);
        const spending = intent.kind === 'category-can-spend'
          ? evaluateCategorySpending(availability.available, amountToCents(intent.amount))
          : null;
        const requested = spending?.requested ?? null;
        const remaining = spending?.remaining ?? null;
        const categoryMessage = requested === null
          ? `Você tem ${moneyText(availability.available / 100)} disponíveis em ${availability.category.name} este mês.`
          : spending.canSpend
            ? `Sim, você pode gastar esse valor em ${availability.category.name}.`
            : `Não, você não tem saldo suficiente para esse gasto em ${availability.category.name}.`;
        return send(response, 200, {
          ok: true,
          kind: intent.kind,
          message: categoryMessage,
          category: availability.category,
          month,
          available: availability.available,
          requested,
          remaining,
          canSpend: spending?.canSpend ?? null,
        });
      }
      const command = intent.command;
      const [accounts, categories] = await Promise.all([getAccounts(), getCategories()]);
      const validation = validateCommand(command, { accounts, categories });
      const mapped = toActualImport(validation, currentLocalDate());
      const preview = {
        command,
        account: validation.account,
        category: validation.category,
        transaction: mapped.transaction,
        text: previewText(command, validation),
      };
      setPending({ preview, mapped });
      return send(response, 200, { ok: true, preview });
    } catch (error) {
      if (error.code === 'VALIDATION_ERROR' || error.code === 'INVALID_COMMAND') {
        return send(response, 400, { ok: false, error: error.message });
      }
      return send(response, 503, { ok: false, error: 'Não foi possível consultar o Actual Budget.', code: error.publicCode || 'actual' });
    }
  }

  if (request.method === 'POST' && request.url === '/confirm') {
    try {
      const pendingResult = await confirmPending(async ({ mapped }) => createTransaction(mapped));
      const { preview } = pendingResult.transaction;
      return send(response, 200, { ok: true, message: successText(preview), ids: pendingResult.result });
    } catch (error) {
      if (error.code === 'NO_PENDING_TRANSACTION' || error.code === 'CONFIRMATION_IN_PROGRESS') {
        return send(response, 409, { ok: false, error: error.message });
      }
      return send(response, 503, { ok: false, error: 'Não foi possível registrar a movimentação no Actual Budget.' });
    }
  }

  if (request.method === 'POST' && request.url === '/cancel') {
    cancelPending();
    return send(response, 200, { ok: true, message: 'Movimentação cancelada.' });
  }

  if (request.method === 'GET' && request.url === '/api/accounts') {
    try { return send(response, 200, { ok: true, accounts: await getAccounts() }); }
    catch (error) { return send(response, 503, { ok: false, code: error.publicCode || 'actual', error: error.message }); }
  }
  if (request.method === 'GET' && request.url === '/api/categories') {
    try { return send(response, 200, { ok: true, categories: await getCategories() }); }
    catch (error) { return send(response, 503, { ok: false, code: error.publicCode || 'actual', error: error.message }); }
  }
  return send(response, 404, { ok: false });
});

function moneyText(amount) {
  return amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function typeText(type) {
  return type === 'expense' ? 'Despesa' : 'Receita';
}

function previewText(command, validation) {
  const noteLine = command.notes ? `\nNota: ${command.notes}` : '';
  return `Vou registrar esta movimentação:\n\nTipo: ${typeText(command.type)}\nValor: ${moneyText(command.amount)}\nBeneficiário: ${command.description}\nConta: ${validation.account.name}\nCategoria: ${validation.category.name}${noteLine}\n\nDeseja confirmar?`;
}

function successText(preview) {
  return `Movimentação registrada com sucesso!\n\n${typeText(preview.command.type)} de ${moneyText(preview.command.amount)} para ${preview.command.description}.\nConta: ${preview.account.name}.\nCategoria: ${preview.category.name}.`;
}

server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Finance Chat listening on ${process.env.HOST || '127.0.0.1'}:${port}`));
process.once('SIGINT', async () => { await shutdown(); server.close(); });
process.once('SIGTERM', async () => { await shutdown(); server.close(); });
