# API HTTP

As rotas estão implementadas em `src/server.js`.

## Rotas

### `GET /health`

Retorna `200` com `{ "ok": true }`. Verifica apenas o processo HTTP, não a conexão com o Actual.

### `POST /parse`

Recebe `{ "message": "..." }` e retorna o comando parseado. Mensagens inválidas retornam `400`.

### `POST /validate`

Interpreta a mensagem, consulta contas/categorias e valida `Bradesco` e a categoria. Erros de validação retornam `400`; falhas do Actual retornam `503`.

### `POST /preview`

É a rota principal do chat. Para uma transação, interpreta, valida, mapeia e guarda um preview pendente sem escrever no Actual. Para perguntas de categoria, retorna disponibilidade, valor solicitado, saldo restante e `canSpend` quando aplicável.

### `POST /confirm`

Escreve a transação pendente com `addTransactions`. Retorna `409` sem pendência ou durante outra confirmação e `503` quando o Actual falha.

### `POST /cancel`

Remove a pendência sem escrever e retorna `200`.

### `GET /api/accounts` e `GET /api/categories`

Retornam listas consultadas no Actual. Falhas retornam `503`.

## Arquivos estáticos

`GET /` serve `public/index.html`; `/app.js` e `/app.css` servem os assets. Caminhos inexistentes retornam `404`.

## CORS

`CORS_ORIGIN` é opcional e deve conter uma origem exata. Headers CORS são enviados somente quando o header `Origin` coincide exatamente. `OPTIONS` de origem não autorizada retorna `403`. Para frontend e backend na mesma origem, mantenha a variável vazia.

As respostas não incluem credenciais. A aplicação não implementa autenticação própria; proteção externa/rede confiável é necessária antes de exposição pública.
