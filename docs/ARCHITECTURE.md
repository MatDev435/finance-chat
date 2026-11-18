# Arquitetura do Finance Chat

## Visão geral

Um único processo Node.js, sem framework de backend nem de frontend, sem etapa de build e sem Docker:

```text
navegador ── HTTP ──> src/server.js ─> src/app.js (rotas)
                                          ├─ auth.js        (usuários, sessões)        ─┐
                                          ├─ user-store.js  (conexão e preferências)  ─┴─> SQLite (better-sqlite3)
                                          ├─ parser.js / validation.js / transaction-mapping.js
                                          └─ actual.js (fila exclusiva) ─> @actual-app/api ─> servidor Actual do usuário
```

O mesmo processo serve o frontend estático (`public/`) e a API (`/api/*`) na mesma origem.

## Backend (`src/`)

| Arquivo | Responsabilidade |
| --- | --- |
| `server.js` | Ponto de entrada: valida a configuração, instala o timeout do `fetch`, importa a API do Actual, abre o banco, inicia o HTTP e encerra de forma limpa no `SIGTERM`. |
| `app.js` | `createApp()`: tabela de rotas, autenticação das rotas, CSRF, limites de tentativas, mapeamento de erros e textos das respostas. |
| `http.js` | Utilitários HTTP: JSON com limite de tamanho, cookies, IP do cliente, detecção de HTTPS, cabeçalhos de segurança, arquivos estáticos. |
| `config.js` | Lê e valida variáveis de ambiente. Recusa iniciar sem `APP_SECRET`. |
| `db.js` | Abre o SQLite (WAL, chaves estrangeiras, permissão 600) e aplica as migrações. |
| `auth.js` | Hash `scrypt`, access token HMAC, sessões com refresh token rotativo e detecção de reuso. |
| `rate-limit.js` | Contador em memória com janela fixa e memória limitada. |
| `secrets.js` | AES-256-GCM com chave derivada da `APP_SECRET` (HKDF) e dados vinculados ao usuário e ao campo. |
| `user-store.js` | Conexão de cada usuário com o Actual (cifrada) e preferência de conta padrão. Valida o formulário de conexão. |
| `actual.js` | Gerenciador da API do Actual: fila exclusiva, troca de contexto por usuário, cache por usuário, mensagens de erro claras. |
| `budget-operations.js` | Operações sobre o orçamento aberto: listar contas, preparar a prévia, gravar a transação confirmada. |
| `accounts.js` | Regras de conta: só contas abertas e dentro do orçamento; seleção estritamente por ID. |
| `parser.js` | Parser determinístico de comandos e perguntas em português. |
| `validation.js` | Valida conta (por ID) e categoria (por nome) contra o orçamento. |
| `transaction-mapping.js` | Converte o comando para o formato do Actual (centavos, `payee_name`, `notes`). |
| `budget-availability.js`, `category-queries.js` | Consultas de saldo por categoria. |
| `undo.js` | Última transação confirmada de cada conversa, desfazível por 10 minutos, de uso único (em memória). |
| `pending.js` | Prévias aguardando confirmação: em memória, uma por usuário e conta, com ID de uso único e expiração. |
| `backup.js` | Backup online do SQLite com rotação. |
| `fetch-timeout.js` | Prazo de 60 s para todo `fetch`. |

## A API do Actual é um singleton

O `@actual-app/api` mantém **um servidor e um orçamento abertos por processo**: `init()` define o servidor e o diretório de dados, e `downloadBudget()` abre um orçamento. Para atender vários usuários com segurança, `actual.js`:

1. executa **todas** as operações numa fila exclusiva, e só libera a fila quando a operação termina de fato;
2. antes de cada operação, compara a conexão do usuário (servidor, arquivo e credenciais) com a que está aberta. Se for diferente, executa `shutdown()`, `init()` e `downloadBudget()`;
3. usa um diretório de cache por usuário: `DATA_DIR/actual/<id do usuário>/`;
4. fecha o orçamento após qualquer falha do Actual, para que a próxima operação reconecte do zero.

Com cache local, reabrir um orçamento é barato: a API carrega o arquivo local e sincroniza. Por isso a troca de contexto entre usuários custa pouco numa instalação pessoal ou familiar. Como as operações são serializadas, um servidor Actual lento atrasa os demais usuários, no máximo até o prazo de 60 s do `fetch`.

Medições com servidores Actual 26.9.0 locais (Node 24, orçamentos de teste com 8 contas e 30 categorias):

| Situação | Memória (RSS) | Tempo por requisição |
| --- | --- | --- |
| Processo ocioso (API carregada) | ~120 MB | (não se aplica) |
| Um usuário com o orçamento aberto | ~165–180 MB | ~4 ms (listar contas, com sync) |
| Alternância contínua entre dois usuários em servidores diferentes | estabiliza em ~290 MB, sem crescimento após 300 trocas | ~80 ms (troca de contexto) |

Cada troca de contexto faz login e sincronização no servidor Actual do usuário. O servidor Actual limita cada IP a 500 requisições por minuto, um volume muito acima do uso real de um chat pessoal.

## Fluxo de uma transação

1. `POST /api/chat/preview` com `{ accountId, message }`: o parser interpreta a mensagem; dentro da fila, o Finance Chat sincroniza, valida a conta (por ID) e a categoria e monta a transação. **Nada é gravado.** A prévia fica em memória com um `pendingId` aleatório.
2. `POST /api/chat/confirm` com `{ pendingId }`: a prévia é **removida antes** da gravação (não há duplicata em confirmações repetidas), conta e categoria são revalidadas com dados recém-sincronizados, a transação é gravada com `addTransactions()` e o orçamento é sincronizado.
3. Se a sincronização depois da gravação falhar, a resposta informa que a transação ficou na cópia local e será enviada na próxima sincronização. Não há retry automático.
4. `POST /api/chat/cancel` descarta a prévia.
5. Como `addTransactions()` não devolve o ID criado, a confirmação lista as transações da conta naquela data antes e depois da gravação, dentro da mesma operação exclusiva e sem sincronizar entre as duas leituras. A transação nova é a diferença. Esse ID permite **desfazer** (`POST /api/chat/undo`), que só apaga a transação se ela continuar na mesma conta, data e valor.

## Frontend (`public/`)

HTML, CSS e JavaScript (módulos ES nativos), sem framework e sem build.

| Arquivo | Responsabilidade |
| --- | --- |
| `index.html` | Telas: carregando, login/cadastro, configuração do Actual, workspace (contas, conversa e configurações). |
| `app.css` | Identidade visual original (tema escuro roxo), layout em duas colunas e regras responsivas. |
| `app.js` | Controlador: telas, lista de contas, troca de conversas, envio, confirmação, menu, navegação mobile. |
| `js/api.js` | Cliente JSON com renovação automática da sessão. |
| `js/chat-view.js` | Renderização das mensagens e dos cards (prévia e disponibilidade). |
| `js/history.js` | Histórico visual em `localStorage` (10 mensagens por conversa, por usuário e ID da conta). |
| `js/navigation.js` | Regras puras de navegação (conta inicial, seleção, painel visível). |
| `js/setup.js`, `js/settings.js` | Formulário de conexão e painel de configurações. |

## Testes (`test/`)

Testes nativos do Node (`node:test`). `test/support/fake-actual.js` simula a API do Actual, inclusive o comportamento singleton, e `test/app.test.js` exercita a API HTTP completa com SQLite em memória. Nenhum teste acessa um servidor Actual real.
