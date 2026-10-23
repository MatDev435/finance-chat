# Decisões técnicas

## Node.js sem Docker

O projeto roda como uma pasta Node.js comum em uma VM. Docker não faz parte do runtime atual.

## Frontend vanilla

HTML, CSS e JavaScript sem framework ou etapa de build mantêm o deployment simples.

## Backend serve frontend e API

`src/server.js` serve `public/` e as rotas no mesmo processo/origem, reduzindo problemas de CORS.

## Sem banco e sem histórico

Não existe banco nem histórico de chat persistente. A única transação pendente fica em memória e é perdida ao reiniciar o processo.

## Confirmação explícita

Preview é somente leitura; criação exige `POST /confirm` para evitar gravações por interpretações incorretas.

## Conta e categorias

A conta é fixa em `Bradesco`. A categoria precisa existir no Actual e nunca é criada automaticamente.

## Mapeamento de transações

- `command.description` é o beneficiário e vira `payee_name`.
- `command.notes`, quando presente, vira `notes`.
- Valores viram centavos inteiros.
- Despesas são negativas e receitas positivas.

## Sincronização

Consultas de disponibilidade chamam `api.sync()` antes de ler categorias e o mês do orçamento para evitar dados obsoletos. Consultas sem dependência de saldo não adicionam essa chamada.

## API do Actual

O projeto usa `@actual-app/api`, não endpoints REST do Actual. A conexão chama `init()` e `downloadBudget()`. Escritas usam `addTransactions()` e depois `sync()`.

## Configuração local

Segredos vêm de variáveis de ambiente. O código não deve solicitar, registrar ou retornar valores secretos; mudanças devem usar `.env` local.
