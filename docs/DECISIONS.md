# Decisões técnicas

## Node.js nativo, sem Docker

O projeto roda como uma pasta Node.js comum, gerenciada pelo systemd. Docker não faz parte do runtime.

## Sem frameworks

`node:http` com uma tabela de rotas pequena, e frontend em HTML, CSS e módulos ES nativos. Não há etapa de build, e as dependências de produção são só três.

## SQLite com `better-sqlite3`

`better-sqlite3` já era dependência do `@actual-app/api`, que guarda os orçamentos em SQLite. Usá-lo diretamente não acrescenta pacote nem compilação nativa. O `node:sqlite` foi descartado porque exige Node ≥ 22.5, e a versão do Node no servidor não é garantida.

## Parser determinístico primeiro, IA opcional

Regras fixas em `src/parser.js` continuam interpretando as mensagens, sem serviços externos. Desde a versão 0.4, cada usuário pode ativar um modo IA (OpenAI), desativado por padrão. O parser é sempre a primeira tentativa: a IA só é chamada quando ele não entende a mensagem ou quando o resultado pode ser parcial (`isCompleteParse`). Detalhes em [AI.md](AI.md).

## Structured Outputs com um plano, sem ciclos de ferramentas

O modelo devolve um único plano JSON (Structured Outputs, `strict: true`) e o backend decide o que executar. Tool calling com ciclos exigiria várias chamadas por mensagem e mandaria resultados financeiros à OpenAI; as buscas não precisam disso, porque o modelo só traduz a pergunta em filtros e o backend calcula tudo. As respostas são textos fixos, sem segunda chamada.

## A IA não escolhe categorias, não apaga e não grava

A categoria vem sempre do usuário (escrita ou escolhida na tela); as sugestões do modelo são só sugestões. Lançamentos sempre terminam numa prévia confirmada. O `desfazer` continua sendo apenas comando ou botão. Mensagens que misturam perguntas e lançamentos só respondem às perguntas.

## Desfazer lotes só quando completos e conferidos

Um lote é confirmado uma vez e gravado em ordem, parando na primeira falha. Só um lote **completo** cujos IDs foram identificados com certeza (diferença entre duas leituras da conta, pareada por data e valor) pode ser desfeito, e só inteiro: todas as movimentações são conferidas antes da primeira exclusão, e qualquer diferença cancela tudo. Lotes interrompidos têm resultados possivelmente incertos no meio; desfazê-los seria arriscado, então não são desfeitos, e o desfazer da conversa é encerrado.

## Resumo do mês calculado no servidor

O modelo só identifica o mês pedido; os números vêm do Actual e o texto é um template. Mandar os valores para o LLM escrever uma análise exporia dados financeiros, custaria uma segunda chamada e arriscaria números errados.

## Busca pela AQL, restrita à conta da conversa

A busca usa `q()` + `aqlQuery()` do `@actual-app/api`, executadas em SQL na cópia local, com filtros montados pelo backend. A conta é sempre a da conversa. O comportamento de divisões e transferências foi verificado no motor real (`test/search-aql.test.js`).

## Custo gravado com a tabela de preços vigente

Cada chamada guarda os tokens informados pela OpenAI e o custo calculado com a tabela de preços vigente naquele momento (versionada em `src/ai/pricing.js`), em nanodólares inteiros. Novos preços nunca reescrevem o histórico, e um preço desconhecido nunca é inventado.

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

## Conversa sem `aria-live` e foco ao trocar de painel

A conversa é reconstruída sempre que um chat é aberto. Como região `aria-live`, ela fazia leitores de tela (TalkBack) lerem todo o histórico a cada abertura. Agora só as respostas novas do Finance Chat são anunciadas, por uma região `role="status"` separada (`#chat-announcer`). No mobile, ao trocar de painel, o foco vai para o título da conversa ou para a conta de onde o usuário voltou, em vez de ficar num botão que sumiu. A animação da lista de contas é apenas visual: o painel que sai fica `inert` durante o deslize e nada espera por ela.

## Sem CORS

Com autenticação por cookie, liberar outra origem exigiria `SameSite=None` e enfraqueceria a proteção contra CSRF. O frontend é sempre servido pelo próprio Finance Chat.

## App para computador com Tauri, voz com Whisper local

O PWA não consegue atalhos globais nem ficar na bandeja. O Tauri usa a webview do sistema (instaladores pequenos, pouca memória) e oferece bandeja, atalho global e instância única como plugins. A Web Speech API não funciona nas webviews embutidas, então a voz do app usa whisper.cpp no próprio computador: sem custo por uso e sem enviar áudio a terceiros. O app abre o mesmo site, em vez de levar uma cópia da interface, para não duplicar regras, sessões e telas. O atalho é "tocar para digitar, segurar para falar", com sons e anúncios marcando a gravação. Ctrl+Enter aprova (nunca Enter) e há uma pausa curta antes de aceitá-lo, para que um Enter dado por reflexo não aprove uma prévia que ainda não foi lida.

## Versão do `@actual-app/api`

A versão do pacote fica travada no `package-lock.json`. Atualize-a junto com o servidor Actual, porque versões muito diferentes podem ser incompatíveis (o erro aparece como `version`).
