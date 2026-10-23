# Arquitetura do Finance Chat

## Visão geral

O Finance Chat é uma aplicação Node.js sem framework de frontend e sem Docker:

```text
navegador -> src/server.js -> parser/validação/estado pendente -> @actual-app/api -> Actual Budget
```

O próprio backend serve o HTML, CSS, JavaScript e a API. Em uma instalação normal, tudo usa a mesma origem e CORS não é necessário.

## Estrutura

### `src/`

- `server.js`: servidor HTTP, arquivos estáticos, rotas e coordenação dos fluxos.
- `parser.js`: comandos e perguntas em português, valores e notas opcionais.
- `validation.js`: valida a conta fixa `Bradesco` e a categoria existente no Actual.
- `transaction-mapping.js`: converte comandos para o formato do Actual.
- `actual.js`: inicializa a API oficial, baixa o orçamento, consulta e cria transações.
- `budget-availability.js`: procura categorias/saldos e sincroniza antes de consultas de disponibilidade.
- `category-queries.js`: calcula saldo restante e possibilidade de gasto.
- `pending.js`: mantém uma única confirmação pendente em memória e bloqueia concorrência.

### `public/`

- `index.html`: estrutura da interface e mensagem inicial.
- `app.js`: estado do chat, chamadas HTTP, preview, confirmação, cancelamento, cards e agrupamento de mensagens.
- `app.css`: tema, layout responsivo, acessibilidade visual e animações.

### `test/`

Testes nativos do Node.js para parser, disponibilidade, regras de consulta, pendência, mapeamento e validação.

## Fluxo de transação

1. `POST /preview` interpreta e valida a mensagem.
2. O preview é guardado em memória; nenhuma escrita ocorre.
3. `POST /confirm` chama `addTransactions` e depois `sync()`.
4. `POST /cancel` limpa a pendência sem escrever.

## Fluxo de disponibilidade

Perguntas como `Quanto ainda tenho em Alimentação?` e `Posso gastar R$ 50 em Alimentação?` usam o mês atual em `APP_TIME_ZONE`. Antes de ler categorias e o mês do orçamento, `getCategoryAvailability` chama `api.sync()` para evitar dados obsoletos.

## Limitações

- Não há banco de dados nem histórico persistente.
- A pendência é perdida quando o processo reinicia.
- A conta de criação é sempre `Bradesco`.
- Categorias não são criadas automaticamente.
- A confirmação explícita é obrigatória para escrever uma transação.
