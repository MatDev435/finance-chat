# Decisões técnicas

## Node.js nativo, sem Docker

O projeto roda como uma pasta Node.js comum, gerenciada pelo systemd. Docker não faz parte do runtime.

## Sem frameworks

`node:http` com uma tabela de rotas pequena, e frontend em HTML, CSS e módulos ES nativos. Não há etapa de build, e as dependências de produção são só três.

## SQLite com `better-sqlite3`

`better-sqlite3` já era dependência do `@actual-app/api`, que guarda os orçamentos em SQLite. Usá-lo diretamente não acrescenta pacote nem compilação nativa. O `node:sqlite` foi descartado porque exige Node ≥ 22.5, e a versão do Node no servidor não é garantida.

## Parser determinístico, sem IA

Regras fixas em `src/parser.js`. Nenhum modelo de linguagem ou serviço externo interpreta mensagens.

## Contas por ID estável

A versão 0.1 procurava a conta pelo nome fixo `Bradesco` e quebrou quando a conta foi renomeada no Actual. Agora cada conversa corresponde a um `id` de conta do Actual (UUID). O nome serve apenas para exibição e é atualizado a cada sincronização. Um ID desconhecido é erro, nunca fallback.

## Contas listadas

Só contas abertas e dentro do orçamento viram conversas. Contas fechadas não devem receber lançamentos. Contas fora do orçamento não usam categorias, e o parser exige categoria.

## Fila exclusiva para a API do Actual

A API oficial mantém um servidor e um orçamento abertos por processo. Um processo por usuário isolaria melhor, mas multiplicaria a memória (cada cópia carrega a API e o orçamento). A fila exclusiva com troca de contexto é simples, leve e segura: o lock só é liberado quando a operação termina. Somada à revalidação da conta por ID antes de gravar, ela torna impossível gravar no orçamento de outro usuário.

## `addTransactions`, não `importTransactions`

`importTransactions` evita duplicatas por `imported_id`, mas faz **reconciliação**: pode associar ou atualizar transações existentes parecidas. Como o Finance Chat não deve alterar transações existentes, continua usando `addTransactions` e evita duplicatas no próprio fluxo (prévia com ID de uso único, removida antes da gravação, sem retry automático).

## Desfazer sem `imported_id`

O ID da transação criada é descoberto pela diferença entre duas leituras da conta (antes e depois de `addTransactions`), dentro da fila exclusiva. Não usamos `imported_id`, que o Actual reserva para importação bancária e reconciliação. O desfazer vale só para a última transação de cada conversa, por 10 minutos, e só apaga se conta, data e valor continuarem iguais. Assim o Finance Chat nunca apaga algo que o usuário alterou no Actual.

## Sessões com access e refresh token em cookies

Access token curto (HMAC) e refresh token opaco, rotativo e guardado como hash. Ficam em cookies `HttpOnly`/`SameSite=Strict`, nunca em `localStorage`. O access token é conferido contra a sessão no banco, então o logout tem efeito imediato. Com SQLite local, essa consulta custa microssegundos.

## `scrypt` nativo

Evita dependência nativa extra (argon2). Os parâmetros seguem a OWASP para scrypt.

## Cadastro restrito por padrão

Como o servidor Actual é informado pelo usuário, cadastro aberto permitiria que qualquer pessoa usasse o homelab para fazer requisições a endereços arbitrários. O primeiro usuário sempre se cadastra, e os demais dependem de `ALLOW_SIGNUP=true`.

## Histórico só no navegador

O histórico das conversas é apenas visual: até 10 mensagens por conversa no `localStorage`, separadas por usuário e ID da conta. Ele não vai para o servidor e não é usado em operações financeiras. A fonte oficial é o Actual. O logout apaga o histórico do usuário naquele navegador.

## Sem CORS

Com autenticação por cookie, liberar outra origem exigiria `SameSite=None` e enfraqueceria a proteção contra CSRF. O frontend é sempre servido pelo próprio Finance Chat.

## Versão do `@actual-app/api`

A versão do pacote fica travada no `package-lock.json`. Atualize-a junto com o servidor Actual, porque versões muito diferentes podem ser incompatíveis (o erro aparece como `version`).
