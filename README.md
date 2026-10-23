# Finance Chat

Small, voice-friendly Brazilian Portuguese finance command parser for Actual Budget. It runs as a regular local Node.js project; Docker is not required.

## Status

The parser, Actual validation, transaction mapping, and confirmed transaction creation are implemented and tested. Transactions are never written during parsing or preview; the user must explicitly confirm.

The chat also supports read-only category questions such as `Quanto ainda tenho em Alimentação?` and `Posso gastar R$ 50 com Alimentação?`. These use the current month from `APP_TIME_ZONE` and Actual’s category `balance`; they never create transactions.

The official `@actual-app/api` integration uses `init({ dataDir, serverURL, password })` and `downloadBudget(syncId, { password })` when end-to-end encryption is enabled. It reads accounts and categories, synchronizes category availability queries, and creates confirmed transactions with `addTransactions()`. Credentials are read only by the Node backend through `process.env`; they are never sent to the frontend, logged, or returned by API responses.

## Commands

Examples:

```text
Gastei 40 reais no MCDonald's categoria alimentação
Ganhei 250 reais de freelance categoria salário
Gastei 10 reais e 94 centavos no Uber, categoria transporte, notas indo para tal lugar
```

Run `npm install`, create `.env` from `.env.example`, then run `npm start`. Run tests with `npm test`.

The transaction flow is:

1. `POST /preview` parses and validates the command against Actual, then keeps one preview in memory.
2. `POST /confirm` writes that pending transaction once with `addTransactions`, then calls `sync()`.
3. `POST /cancel` clears the pending preview without writing anything.

The transaction date is the current date in `APP_TIME_ZONE`, which defaults to `America/Sao_Paulo`. The app uses the Actual API’s integer-cent amount format, `payee_name`, `notes`, and category/account IDs. Notes are optional and are sent only when the command includes a `nota` or `notas` marker after the category.

Open the app at `http://localhost:3000`; do not double-click `public/index.html`. Browsers restrict JavaScript, CSS, and API requests from `file://` pages. The server provides the static files and API from one origin, so CORS is not needed for the normal local setup. It binds to `127.0.0.1` by default, which is suitable for a reverse proxy on the same machine. If a reverse proxy serves the frontend from a different origin, set `CORS_ORIGIN` to that exact origin in `.env`.


## Required Actual configuration

Copy `.env.example` to `.env` and fill in the Actual server URL, server login password, budget Sync ID, and—if enabled—the separate budget encryption password. The local budget cache defaults to `./data/actual`; keep it private. Never paste `.env` contents into chat.

## Documentation

Detailed project context is maintained in:

- [Architecture](docs/ARCHITECTURE.md)
- [HTTP API](docs/API.md)
- [Parser](docs/PARSER.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Security](docs/SECURITY.md)
- [Technical decisions](docs/DECISIONS.md)
