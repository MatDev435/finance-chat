# API HTTP

Implementada em `src/app.js`. Todas as respostas são JSON com `ok: true|false`. Erros trazem `code` (estável, para o frontend) e `error` (mensagem em português). Alguns trazem também `field` (campo inválido) ou `reason` (causa de falha do Actual).

## Regras gerais

- Rotas `/api/*` exigem sessão, exceto as de `/api/auth/*`.
- Requisições que alteram estado (`POST`, `PUT`) precisam de `Content-Type: application/json` e são recusadas (`403`) se vierem de outro site (`Origin` ou `Sec-Fetch-Site`).
- O corpo é limitado a 16 KB.
- A sessão usa dois cookies `HttpOnly`, com `SameSite=Strict`: `fc_access` (15 minutos, `Path=/`) e `fc_refresh` (`Path=/api/auth`).
- Um `401` com `AUTH_REQUIRED` indica access token expirado ou ausente: chame `POST /api/auth/refresh` e repita a requisição.

## Saúde

### `GET /health`

`200 { ok: true }`. Verifica apenas o processo HTTP.

## Autenticação

| Rota | Corpo | Respostas |
| --- | --- | --- |
| `GET /api/auth/options` | (nenhum) | `200 { signupOpen, firstUser }` |
| `POST /api/auth/register` | `{ username, password }` | `201 { user }` com cookies · `400 INVALID_INPUT` · `403 SIGNUP_DISABLED` · `409 USERNAME_TAKEN` · `429` |
| `POST /api/auth/login` | `{ username, password }` | `200 { user }` com cookies · `401 INVALID_CREDENTIALS` · `429 TOO_MANY_ATTEMPTS` (com `Retry-After`) |
| `POST /api/auth/refresh` | `{}` | `200` com cookies novos · `401 SESSION_EXPIRED` (cookies apagados) |
| `POST /api/auth/logout` | `{}` | `200` (sessão revogada, cookies apagados) |

## Usuário e conexão

### `GET /api/me`

```json
{
  "ok": true,
  "user": { "id": 1, "username": "ana" },
  "connection": { "configured": true, "serverUrl": "https://actual.exemplo.com", "syncId": "…", "authMethod": "password", "hasEncryptionPassword": false },
  "settings": { "defaultAccountId": "uuid-da-conta" }
}
```

Nunca devolve senhas, chaves ou tokens.

### `POST /api/connection/test` e `PUT /api/connection`

Corpo:

```json
{ "serverUrl": "https://actual.exemplo.com", "syncId": "…", "authMethod": "password", "serverSecret": "…", "useEncryption": false, "encryptionPassword": "" }
```

- `authMethod`: `password` (senha do servidor) ou `token` (chave de API, passada como `sessionToken` à API).
- Ao editar, `serverSecret` vazio mantém a senha salva, **desde que o servidor não mude**. O mesmo vale para `encryptionPassword` quando servidor e Sync ID não mudam.
- `test` abre o orçamento e devolve `{ accounts, message }` sem salvar. `PUT` testa e só salva se o teste passar.
- Erros: `400 INVALID_INPUT` (com `field`), `503 ACTUAL_ERROR` (com `reason`: `authentication`, `token`, `budget-not-found`, `encryption-required`, `encryption`, `network`, `version`, `clock-drift`, `actual`).

## Contas e preferências

### `GET /api/accounts`

Sincroniza e devolve as contas abertas e dentro do orçamento: `{ accounts: [{ id, name }] }`. Erros: `409 CONNECTION_REQUIRED`, `409 CONNECTION_UNREADABLE` (a `APP_SECRET` mudou), `503 ACTUAL_ERROR`.

### `PUT /api/settings`

`{ defaultAccountId: "uuid" | null }`. A conta precisa estar na lista atual do usuário (`409 ACCOUNT_UNAVAILABLE` se não estiver).

## Chat

### `POST /api/chat/preview`

`{ accountId, message, categoryId? }` (mensagem com até 500 caracteres). Não grava nada.

`categoryId` é opcional: é enviado quando o usuário escolhe uma das sugestões de categoria. Ele substitui a categoria escrita na mensagem, depois de validado contra o orçamento. Categoria desconhecida devolve `400` (`VALIDATION_ERROR` para transações, `CATEGORY_NOT_FOUND` para perguntas de saldo) com `suggestions: [{ id, name }]` (até 3).

- Transação: `{ kind: "transaction", pendingId, expiresAt, preview: { command, account, category, transaction, text } }`. Em compras divididas, `category` é `null`, `preview.splits` traz `[{ amount, category: { id, name } }]` e `transaction.subtransactions` traz as partes. `categoryId` não pode ser usado com divisões (`400`).
- `Quanto tenho em X?`: `{ kind: "category-available", message, category, month, available }`.
- `Posso gastar R$ N com X?`: `{ kind: "category-can-spend", message, category, month, available, requested, remaining, canSpend }`.

Valores em centavos, exceto `command.amount`. Erros: `400 INVALID_COMMAND | VALIDATION_ERROR | CATEGORY_NOT_FOUND | INVALID_INPUT`, `409 ACCOUNT_UNAVAILABLE | CONNECTION_REQUIRED`, `503 ACTUAL_ERROR`.

### `POST /api/chat/confirm`

`{ pendingId }`. Grava uma vez, na conta da prévia.

- `200 { synced: true, account, message }`: gravada e sincronizada.
- `200 { synced: false, account, message }`: gravada na cópia local; será enviada ao servidor na próxima sincronização. **Não reenvie.**
- `409 NO_PENDING_TRANSACTION | PENDING_EXPIRED | CONNECTION_CHANGED | ACCOUNT_UNAVAILABLE`: nada foi gravado.
- `503 ACTUAL_ERROR`: falha antes da gravação, nada foi gravado.
- `503 WRITE_UNCERTAIN`: a própria gravação falhou. Verifique no Actual antes de tentar de novo.

A confirmação também devolve `undoId`, `undoExpiresAt` e `undoTtlMs` quando a transação criada pôde ser identificada.

### `POST /api/chat/undo`

`{ accountId, undoId? }`: desfaz a última transação confirmada nesta conversa. Sem `undoId`, usa a mais recente; a mensagem `desfazer` em `/api/chat/preview` faz o mesmo e responde com `kind: "undo"`.

- `200 { kind: "undo", undoneId, synced, message }`: transação apagada (com `synced: false`, apagada na cópia local e enviada na próxima sincronização).
- `409 NO_UNDO | UNDO_EXPIRED`: não há o que desfazer (outra conversa, outro usuário, já desfeita ou prazo de 10 minutos esgotado).
- `409 UNDO_NOT_FOUND | UNDO_CHANGED`: a transação foi apagada ou alterada no Actual; nada foi feito.
- `409 CONNECTION_CHANGED`: a conexão mudou depois do registro.
- `503 ACTUAL_ERROR`: Actual indisponível; nada foi feito e o desfazer continua disponível.
- `503 UNDO_UNCERTAIN`: a exclusão falhou no meio. Verifique no Actual.

### `POST /api/chat/cancel`

`{ pendingId }`: `200 { message: "Movimentação cancelada." }`. Idempotente.

## Arquivos estáticos

`GET /` serve `public/index.html`. Arquivos `.html`, `.css`, `.js` e `.svg` dentro de `public/` são servidos com `Cache-Control: no-cache`. Qualquer outro caminho devolve `404`.

## Mudanças em relação à versão 0.1

- `/preview`, `/confirm` e `/cancel` viraram `/api/chat/*` e exigem `accountId` e `pendingId`.
- `/parse`, `/validate` e `/api/categories` foram removidas: não eram usadas pelo frontend e não tinham autenticação.
- `CORS_ORIGIN` foi removida: frontend e API ficam sempre na mesma origem.
