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
  "settings": { "defaultAccountId": "uuid-da-conta" },
  "ai": { "enabled": false, "model": "gpt-6-luna", "hasKey": false, "keyUpdatedAt": null }
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

## Modo IA

### `GET /api/ai`

`{ settings, models: [{ id, name, description, prices: { input, cachedInput, output } }], defaultModel, pricing: { version, source }, usage }`. Preços em US$ por 1M tokens. `usage` traz `month`, `total` e `currentMonth`, cada um com `requests`, `requestsWithoutUsage`, `requestsWithoutCost`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens`, `totalTokens` e `costNanoUsd` (1e-9 US$). Só do usuário da sessão.

### `PUT /api/ai/settings`

`{ enabled?: boolean, model?: string, apiKey?: string, removeKey?: true }`. Só muda o que for enviado; `apiKey` vazio mantém a chave salva. Devolve `{ settings }` (sem a chave). Erros: `400 INVALID_INPUT` com `field` (`enabled`, `model`, `apiKey`).

### `POST /api/ai/test`

`{ model?, apiKey? }` (sem `apiKey`, usa a chave salva). Não salva nada. Confere se a chave lista o modelo (`GET /v1/models`) e faz uma chamada com o schema real (registrada no consumo como teste). `200 { message, availableModels, usage }`. Erros: `400 INVALID_INPUT`, `502 AI_AUTH | AI_FORBIDDEN | AI_QUOTA | AI_MODEL_UNAVAILABLE | AI_BAD_REQUEST`, `429 AI_RATE_LIMIT` (com `Retry-After`) ou `TOO_MANY_ATTEMPTS` (10 testes a cada 5 minutos), `503 AI_UNAVAILABLE | AI_NETWORK`, `504 AI_TIMEOUT`, `409 AI_KEY_UNREADABLE`.

## Chat

### `POST /api/chat/preview`

`{ accountId, message, categoryId? }` (mensagem com até 500 caracteres). Não grava nada.

`categoryId` é opcional: é enviado quando o usuário escolhe uma das sugestões de categoria. Ele substitui a categoria escrita na mensagem, depois de validado contra o orçamento. Categoria desconhecida devolve `400` (`VALIDATION_ERROR` para transações, `CATEGORY_NOT_FOUND` para perguntas de saldo) com `suggestions: [{ id, name }]` (até 3).

- Transação: `{ kind: "transaction", pendingId, expiresAt, preview: { command, account, category, transaction, text } }`. Em compras divididas, `category` é `null`, `preview.splits` traz `[{ amount, category: { id, name } }]` e `transaction.subtransactions` traz as partes. `categoryId` não pode ser usado com divisões (`400`).
- `Quanto tenho em X?`: `{ kind: "category-available", message, category, month, available }`.
- `Posso gastar R$ N com X?`: `{ kind: "category-can-spend", message, category, month, available, requested, remaining, canSpend }`.
- Resumo do mês (`como estou esse mês?`, `resumo do mês passado`; outros meses pelo modo IA): `{ kind: "summary", message, summary: { month, from, to, account, expenses, expenseCount, incomes, incomeCount, net, topExpenses: [{ date, amount, payee, category, notes }], budget: { budgeted, spent, topCategories: [{ name, spent }], overspent: [{ name, balance }], overspentCount } | null } }` (centavos; `budget` é do orçamento inteiro, `null` se o orçamento não tem aquele mês).

Com o modo IA ativado, a mensagem que o parser não entende (ou entende só em parte) é interpretada pela IA, e a resposta pode ser também:

- Lote: `{ kind: "batch", pendingId, expiresAt, account, items: [preview], text }`. Confirmado de uma vez com `POST /api/chat/confirm`.
- Esclarecimento: `{ kind: "clarify", draftId, expiresAt, message, items, missing: [{ item, part, field, label, typed, suggestions }], categories: [{ id, name }] }`. Nada a confirmar ainda; responda no chat ou use `POST /api/chat/draft`.
- Busca: `{ kind: "search", message, search: { result, type, from, to, account, payees, notes, payeeAsNotes, category, minAmount, maxAmount, count, total, transactions: [{ date, amount, payee, category, notes }] } }` (centavos). `notes` é o texto procurado nas notas; `payeeAsNotes: true` quando nenhum beneficiário tinha o nome pedido e o termo foi procurado nas notas.
- Várias respostas: `{ kind: "answers", answers: [...] }`.
- Texto: `{ kind: "text", message }` (perguntas de esclarecimento, pedidos fora do escopo, rascunho descartado).

Toda resposta traz `source`: `parser`, `ai` ou `local` (rascunho completado sem IA), e pode trazer `notes: [texto]` (por exemplo, "não registrei nenhuma movimentação" numa mensagem mista). Erros do modo IA: `422 AI_INVALID_PLAN | AI_REFUSAL | AI_INCOMPLETE`, `502 AI_*`, `429 AI_TOO_MANY` (40 chamadas a cada 10 minutos) ou `AI_RATE_LIMIT`, `409 AI_DISABLED | AI_KEY_UNREADABLE`.

Valores em centavos, exceto `command.amount`. Erros: `400 INVALID_COMMAND | VALIDATION_ERROR | CATEGORY_NOT_FOUND | INVALID_INPUT`, `409 ACCOUNT_UNAVAILABLE | CONNECTION_REQUIRED`, `503 ACTUAL_ERROR`.

### `POST /api/chat/confirm`

`{ pendingId }`. Grava uma vez, na conta da prévia.

- `200 { synced: true, account, message }`: gravada e sincronizada.
- `200 { synced: false, account, message }`: gravada na cópia local; será enviada ao servidor na próxima sincronização. **Não reenvie.**
- `409 NO_PENDING_TRANSACTION | PENDING_EXPIRED | CONNECTION_CHANGED | ACCOUNT_UNAVAILABLE`: nada foi gravado.
- `503 ACTUAL_ERROR`: falha antes da gravação, nada foi gravado.
- `503 WRITE_UNCERTAIN`: a própria gravação falhou. Verifique no Actual antes de tentar de novo.

A confirmação também devolve `undoId`, `undoExpiresAt` e `undoTtlMs` quando a transação criada pôde ser identificada.

Para um lote (`kind: "batch"` na prévia), conta e categorias de todos os itens são revalidadas antes da primeira gravação (qualquer problema: nada gravado). Depois os itens são gravados em ordem, parando na primeira falha:

- `200 { kind: "batch", complete, synced, account, results: ["written" | "uncertain" | "skipped"], message }`. Com `complete: false`, `message` lista o que foi registrado, o que ficou incerto (verifique no Actual) e o que não foi enviado.
- Um lote completo cujos IDs foram identificados devolve também `undoId`, `undoExpiresAt` e `undoTtlMs`: o desfazer apaga o lote inteiro. Um lote interrompido não tem `undoId` e encerra o desfazer da conversa.

### `POST /api/chat/undo`

`{ accountId, undoId? }`: desfaz a última confirmação desta conversa (uma transação ou um lote inteiro). Sem `undoId`, usa a mais recente; a mensagem `desfazer` em `/api/chat/preview` faz o mesmo e responde com `kind: "undo"`.

- `200 { kind: "undo", undoneId, synced, message }`: transação apagada (com `synced: false`, apagada na cópia local e enviada na próxima sincronização).
- `409 NO_UNDO | UNDO_EXPIRED`: não há o que desfazer (outra conversa, outro usuário, já desfeita ou prazo de 10 minutos esgotado).
- `409 UNDO_NOT_FOUND | UNDO_CHANGED`: a transação (ou uma das transações do lote) foi apagada ou alterada no Actual; nada foi feito.
- `409 CONNECTION_CHANGED`: a conexão mudou depois do registro.
- `503 ACTUAL_ERROR`: Actual indisponível; nada foi feito e o desfazer continua disponível.
- `503 UNDO_UNCERTAIN`: a exclusão falhou no meio (num lote, a mensagem diz quantas já foram apagadas). Verifique no Actual.

### `POST /api/chat/cancel`

`{ pendingId }`: `200 { message: "Movimentação cancelada." }`. Idempotente.

`{ accountId, draftId }`: descarta o rascunho de um esclarecimento da IA. Idempotente.

### `POST /api/chat/draft`

`{ accountId, draftId, item, part, categoryId }`: escolhe, na tela, a categoria de um campo pendente de um esclarecimento (`item` e `part` numerados a partir de 1; `part: null` fora de divisões). Não chama a IA. Responde como `/api/chat/preview` (outro `clarify`, uma prévia ou um lote). `409 NO_DRAFT` se o rascunho expirou, foi substituído ou é de outro usuário ou conversa.

## Arquivos estáticos

`GET /` serve `public/index.html`. Arquivos `.html`, `.css`, `.js` e `.svg` dentro de `public/` são servidos com `Cache-Control: no-cache`. Qualquer outro caminho devolve `404`.

## Mudanças em relação à versão 0.1

- `/preview`, `/confirm` e `/cancel` viraram `/api/chat/*` e exigem `accountId` e `pendingId`.
- `/parse`, `/validate` e `/api/categories` foram removidas: não eram usadas pelo frontend e não tinham autenticação.
- `CORS_ORIGIN` foi removida: frontend e API ficam sempre na mesma origem.
