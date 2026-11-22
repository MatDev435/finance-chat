# Segurança

## Segredos

- **`APP_SECRET`** fica fora do banco (variável de ambiente, `.env` ou `EnvironmentFile` com permissão `600`). Dela derivam, via HKDF, chaves independentes para cifrar credenciais e assinar access tokens. Sem ela, as credenciais salvas não podem ser lidas e cada usuário precisa reconfigurar a conexão. As sessões continuam válidas, porque o refresh token não depende da chave. Para encerrar todas as sessões (por exemplo, após um vazamento), pare o serviço e apague a tabela `sessions`: `DELETE FROM sessions;`.
- **Credenciais do Actual** (senha do servidor ou chave de API e senha de criptografia) são cifradas com AES-256-GCM no SQLite. O ID do usuário e o nome do campo entram como dados autenticados, então um valor copiado para outro usuário ou campo não decifra.
- As credenciais nunca são enviadas ao navegador, gravadas em logs ou devolvidas pela API. Uma senha salva **nunca** é reaproveitada para um endereço de servidor diferente sem ser digitada de novo.
- A API do Actual é iniciada com `verbose: false`, porque no modo verboso ela registra o corpo de requisições que falharam, e esse corpo pode conter a senha.

## Senhas e sessões

- Senhas de usuário: `scrypt` (N=2^14, r=8, p=5, 16 MiB) com sal aleatório. Parâmetros antigos são atualizados no login. Usuários inexistentes custam o mesmo tempo de verificação.
- Access token: HMAC-SHA256, 15 minutos, contendo só os IDs do usuário e da sessão. Toda requisição confere também se a sessão continua ativa, então o **logout vale imediatamente**.
- Refresh token: 32 bytes aleatórios, guardado só como hash SHA-256. É **rotacionado** a cada renovação. Reapresentar um token já substituído (fora de uma janela de 60 s para abas paralelas) **revoga a sessão**. Expira após 30 dias sem uso e 90 dias no máximo.
- Cookies: `HttpOnly`, `SameSite=Strict`, `Secure` em HTTPS. O refresh token só é enviado para `/api/auth`. Nenhum token fica em `localStorage`.

## CSRF e navegador

- Cookies `SameSite=Strict`.
- `POST`/`PUT` exigem `Content-Type: application/json` (formulários HTML não conseguem enviar isso entre sites sem preflight).
- `Origin` e `Sec-Fetch-Site` precisam indicar a mesma origem.
- Cabeçalhos: CSP restritiva (`default-src 'self'`, sem scripts inline), `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`.
- O frontend insere texto só via `textContent`.

## Abuso

- Login: no máximo 5 falhas por usuário e 20 por IP a cada 15 minutos (`429` com `Retry-After`).
- Cadastro: 10 por IP por hora. Teste de conexão: 10 por usuário a cada 5 minutos.
- Corpo JSON limitado a 16 KB e mensagens a 500 caracteres.
- Atrás de proxy, use `TRUST_PROXY=true` para o limite considerar o IP real (último valor do `X-Forwarded-For`, adicionado pelo proxy).

## Cadastro e SSRF

O endereço do servidor Actual é informado pelo usuário, então o Finance Chat faz requisições para endereços escolhidos por quem tem conta. Por isso **só o primeiro usuário se cadastra livremente**. Os demais dependem de `ALLOW_SIGNUP=true`, que deve ficar ligado só enquanto alguém de confiança cria a conta.

## Isolamento entre usuários

- Cada consulta ao banco filtra pelo usuário autenticado (consultas parametrizadas, sem SQL concatenado).
- Prévias pendentes pertencem ao usuário que as criou.
- Cada usuário tem um diretório de cache do Actual (`DATA_DIR/actual/<id>`, modo `700`).
- As operações no Actual passam por uma fila exclusiva que abre o orçamento do usuário certo antes de cada operação.
- Antes de gravar, a conta é revalidada pelo ID dentro do orçamento aberto. Como os IDs são UUIDs únicos, uma conta de outro orçamento nunca é encontrada, e a operação falha sem gravar em lugar nenhum.

## Integridade financeira

- Prévia não grava. Gravar exige confirmação explícita e um `pendingId` de uso único.
- Confirmações repetidas ou simultâneas gravam no máximo uma vez.
- Conta e categoria são revalidadas logo antes da gravação. Nunca há fallback para outra conta.
- A interface só mostra "registrada" depois da confirmação do servidor.
- Falhas são classificadas: "nada foi registrado", "gravada mas não sincronizada" e "resultado incerto, verifique no Actual".
- Desfazer apaga somente a última confirmação do próprio usuário naquela conversa (uma transação ou um lote completo), por até 10 minutos, e somente se todas as transações continuarem com a mesma conta, data e valor; num lote, qualquer diferença cancela tudo antes da primeira exclusão.

## App instalável (service worker)

- O service worker só armazena os arquivos estáticos da interface. Requisições para `/api/*` e `/health` passam direto para o servidor e nunca são guardadas, então contas, transações e tokens não ficam no cache.
- Estratégia "rede primeiro": online, sempre usa a versão mais nova dos arquivos; o cache é só fallback offline.
- Sem push, sincronização em segundo plano, analytics ou chamadas a terceiros.
- `Permissions-Policy: microphone=(self)`: o microfone só pode ser pedido pelo próprio Finance Chat (ditado por voz), nunca por frames ou outras origens. O ditado usa o reconhecimento de voz do navegador; o áudio vai para o serviço do navegador (Google no Chrome, Apple no Safari), não para o servidor do Finance Chat, e o texto reconhecido só preenche o campo, sem envio automático.

## App para computador

- O app (Tauri) abre o site configurado; sessões, CSRF e CSP continuam do servidor. O site só pode chamar um conjunto pequeno de comandos (janela rápida, abrir janelas, voz, resumo das configurações), concedido em tempo de execução apenas à origem configurada. Configurações e downloads de modelos ficam restritos às páginas embutidas do app. Detalhes em [DESKTOP.md](DESKTOP.md#segurança).
- A CSP do servidor só acrescenta os endereços do IPC do Tauri (`ipc:` e `http://ipc.localhost`) ao `connect-src`, necessários quando o site roda dentro do app.
- A voz é transcrita no próprio computador (whisper.cpp); o áudio nunca é enviado a servidores.
- Os instaladores (`/downloads/<nome>`) exigem sessão e só servem arquivos comuns de `DESKTOP_DIR` com nome e extensão de instalador (sem links simbólicos, subpastas ou `..`). O SHA-256 de cada arquivo aparece nas configurações para conferência.

## Dados locais

- `DATA_DIR` contém o banco e os caches do Actual (cópias dos orçamentos). Mantenha-o com dono igual ao usuário do serviço e modo `700`.
- O navegador guarda apenas o histórico visual das conversas (até 10 mensagens por conversa), sem tokens nem senhas. Ele é apagado no logout.

## Modo IA (OpenAI)

- Desativado por padrão, por usuário. Desativado, nenhuma requisição é feita à OpenAI.
- A chave da OpenAI é cifrada com AES-256-GCM com uma chave derivada da `APP_SECRET` só para esta finalidade (`openai-api-key-v1`) e vinculada ao ID do usuário. Uma chave copiada para outro usuário, ou lida com outra `APP_SECRET`, não decifra.
- Ela só é decifrada no servidor, logo antes de uma chamada, e só vai no cabeçalho `Authorization` para `https://api.openai.com/v1`. Nunca é devolvida pela API (`/api/me` e `/api/ai` informam apenas se existe uma chave), nunca vai para URLs, logs ou mensagens de erro, e não é guardada no navegador.
- As mensagens de erro da OpenAI não são repassadas nem registradas (algumas citam parte da chave). O log guarda só o código, o status e o ID da requisição.
- O que é enviado: instruções fixas, schema, data, nomes das categorias visíveis, o rascunho pendente (sem IDs), os filtros da última busca e a mensagem. Nunca: contas, saldos, transações, histórico do chat, IDs ou credenciais. As chamadas usam `store: false`.
- O plano devolvido pelo modelo é dado não confiável: validado campo a campo (`src/ai/plan.js`); ele não pode gravar sem prévia e confirmação, apagar, desfazer, escolher conta, escolher categoria ou montar consultas. A busca é sempre limitada à conta da conversa. O texto procurado nas notas é escapado (`%`, `?`, `\\`) e usado só como "contém". O resumo do mês envia ao modelo apenas a mensagem; os valores são calculados no servidor.
- Limites por usuário: teste de chave (10 a cada 5 minutos) e chamadas à IA pelo chat (40 a cada 10 minutos).
- O consumo (`ai_usage`) guarda contadores de tokens e custo, nunca mensagens ou respostas, e cada usuário só vê o próprio.
- Os testes automatizados nunca acessam a OpenAI: o transporte HTTP é substituído por um falso que falha em qualquer chamada inesperada.

## Rede

- Bind padrão em `127.0.0.1`. Exponha via reverse proxy com HTTPS.
- Se precisar de `HOST=0.0.0.0`, limite o acesso à porta com firewall.
- Com o modo IA em uso, o servidor precisa de saída HTTPS para `api.openai.com`.
