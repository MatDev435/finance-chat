# Finance Chat

Aplicação self-hosted para registrar movimentações no [Actual Budget](https://actualbudget.org) escrevendo em português, como numa conversa:

```text
Gastei 40 reais no mercado categoria alimentação
Ganhei 250,50 de freelance categoria salário
Gastei 10 reais e 94 centavos no Uber, categoria transporte, notas indo para o trabalho
Quanto ainda tenho em Alimentação?
Posso gastar R$ 50 com Alimentação?
```

A interpretação é feita por um **parser determinístico** (regras fixas, sem serviços externos). Opcionalmente, cada usuário pode ativar um **modo IA** com a própria chave da OpenAI, para mensagens livres, vários lançamentos de uma vez e buscas no histórico: o parser continua sendo a primeira tentativa, e toda gravação continua exigindo confirmação. A aplicação é um único processo Node.js leve, com três dependências e SQLite embutido. Docker não é necessário.

## Funcionalidades

- **Cadastro e login** com nome de usuário e senha. A sessão persiste entre visitas e é renovada automaticamente.
- **Vários usuários**, cada um com a **própria conexão** com o Actual Budget (servidor, arquivo e credenciais próprios). Um usuário nunca vê nem altera os dados de outro.
- **Uma conversa por conta**, com organização parecida com a do WhatsApp Web: lista de contas à esquerda e a conversa da conta selecionada à direita. No celular, as duas telas se alternam.
- **Contas identificadas pelo ID estável do Actual.** Renomear uma conta no Actual não quebra nada, e o novo nome aparece na próxima atualização da lista.
- **Confirmação explícita:** toda movimentação passa por uma prévia, e só é gravada quando você clica em **Aprovar**.
- **Conta padrão:** a conversa aberta automaticamente ao entrar.
- **Histórico visual** das últimas 10 mensagens de cada conversa, guardado só no navegador (`localStorage`).
- **Configuração guiada** da conexão com o Actual, com tutorial e teste de conexão.
- **Datas no texto** (`ontem`, `dia 12`, `12/11`), **compras divididas** em várias categorias, **sugestão de categoria** para erros de digitação e **desfazer** o último lançamento. Tudo por regras fixas, sem IA.
- **App instalável (PWA)** no celular e no computador: ícone na tela inicial, abre em tela cheia, sem loja e sem rastreamento.
- **Modo IA opcional (OpenAI)**, desativado por padrão e configurado por usuário (chave própria, cifrada no servidor, e modelo GPT-6 à escolha, com GPT-6 Luna como padrão). Entende mensagens livres, vários lançamentos numa mensagem, compras divididas descritas livremente, saldos, simulações e buscas como "quanto gastei no McDonald's nos últimos 3 meses?". A IA só interpreta: nunca grava sem confirmação, nunca escolhe a categoria e nunca apaga nada. O consumo de tokens e o custo estimado de cada usuário aparecem nas configurações. Veja [docs/AI.md](docs/AI.md).

## Requisitos

- Node.js 20 ou mais recente (testado no 24).
- Um servidor Actual Budget acessível pela máquina do Finance Chat.
- Linux, macOS ou WSL. Em produção, um Ubuntu Server com systemd e, de preferência, um reverse proxy com HTTPS (Caddy, por exemplo).

## Instalação local

```bash
npm ci
cp .env.example .env
# gere a chave da aplicação e cole em APP_SECRET no .env:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npm start
```

Abra `http://localhost:3000` pelo endereço do servidor. Não abra o `public/index.html` direto pelo sistema de arquivos. O primeiro acesso mostra **Criar conta**. Depois do cadastro, o Finance Chat pede os dados do Actual.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `APP_SECRET` | (obrigatória) | Chave com pelo menos 32 caracteres aleatórios. Cifra as credenciais do Actual guardadas no SQLite e assina as sessões. **Faça uma cópia segura**: se ela se perder, as conexões salvas com o Actual precisam ser refeitas. |
| `HOST` | `127.0.0.1` | Interface de escuta. |
| `PORT` | `3000` | Porta HTTP. |
| `DATA_DIR` | `./data` | Diretório persistente com o banco `finance-chat.sqlite`, os caches do Actual (`actual/<id do usuário>/`) e os backups. Em produção, deixe fora da pasta do código (`/var/lib/finance-chat`). |
| `TRUST_PROXY` | `false` | Use `true` atrás de um reverse proxy, para que o limite de tentativas de login use o IP real do cliente. |
| `COOKIE_SECURE` | `auto` | `auto` marca os cookies como `Secure` quando a requisição chega por HTTPS (direto ou via `X-Forwarded-Proto`). Também aceita `true` e `false`. |
| `ALLOW_SIGNUP` | `false` | O primeiro usuário sempre pode se cadastrar. Os demais só com `true`. |
| `APP_TIME_ZONE` | `America/Sao_Paulo` | Fuso da data das movimentações e do mês das consultas. |
| `BACKUP_KEEP` | `14` | Quantos backups o `npm run backup` mantém. |

As credenciais do Actual **não** ficam no `.env`. Cada usuário informa as suas na interface.

## SQLite

O banco fica em `DATA_DIR/finance-chat.sqlite` e é criado na primeira execução. As migrações rodam automaticamente na inicialização: são versionadas com `PRAGMA user_version`, idempotentes e transacionais. O banco guarda:

- usuários (hash `scrypt` das senhas);
- sessões (somente o hash dos refresh tokens);
- conexão de cada usuário com o Actual (senhas cifradas com AES-256-GCM);
- preferências (conta padrão);
- configuração de IA de cada usuário (ativação, modelo e chave da OpenAI cifrada com AES-256-GCM);
- consumo da OpenAI por chamada (tokens e custo estimado, nunca o conteúdo das mensagens).

Mensagens do chat **não** são guardadas no servidor. O arquivo é criado com permissão `600` e o diretório com `700`.

## Autenticação

- Senhas com `scrypt` (parâmetros recomendados pela OWASP).
- Access token de 15 minutos e refresh token de até 30 dias sem uso (máximo de 90 dias), ambos em cookies `HttpOnly` com `SameSite=Strict`, e `Secure` em HTTPS. O refresh token é trocado a cada renovação, e o reuso de um token antigo encerra a sessão.
- Logout invalida a sessão imediatamente no servidor.
- Limite de tentativas de login por usuário e por IP.
- Proteção contra CSRF: cookies `SameSite=Strict`, JSON obrigatório e checagem de `Origin`/`Sec-Fetch-Site`.

## Conexão com o Actual Budget

Depois do primeiro login, a tela **Conectar ao Actual Budget** pede:

| Campo | Onde encontrar |
| --- | --- |
| Endereço do servidor | O endereço que você usa para abrir o Actual no navegador. |
| Sync ID | No Actual: *Configurações* → *Mostrar configurações avançadas* → *Sync ID*. |
| Senha do servidor **ou** chave de API | A senha de login do Actual, ou uma chave criada em *Configurações → Geral → Segurança → Chaves de API* (versões recentes). |
| Senha de criptografia (opcional) | Só se o orçamento usa criptografia de ponta a ponta. |

O botão **Testar conexão** abre o orçamento e conta as contas encontradas, sem gravar nada. A conexão só é salva depois de um teste bem-sucedido. Ela pode ser revisada depois em **Configurações → Revisar conexão**.

## Múltiplas contas

Cada conta **aberta** e **dentro do orçamento** do Actual vira uma conversa. Tudo o que é enviado numa conversa é registrado **somente** naquela conta, identificada pelo ID.

- A lista é atualizada ao entrar e pelo botão de atualizar (⟳), sem polling.
- Contas novas aparecem na próxima atualização. Contas renomeadas mantêm a conversa e o histórico.
- Contas fechadas, excluídas ou fora do orçamento (que não usam categorias) não aparecem. Se a conta sumir entre a prévia e a confirmação, nada é gravado e nenhuma outra conta é usada no lugar.
- Perguntas de saldo por categoria funcionam em qualquer conversa, porque valem para o orçamento inteiro.

## Conta padrão

Em **Configurações → Conta padrão**, escolha a conversa que abre automaticamente ao entrar. A preferência usa o ID da conta: sobrevive a renomeações, e se a conta deixar de existir o Finance Chat avisa e mostra a lista, em vez de abrir outra conta.

## Instalar como app

Com o Finance Chat servido por **HTTPS** (ou em `localhost`):

- **Android (Chrome):** menu ⋮ → *Instalar app* (ou *Adicionar à tela inicial*).
- **iPhone (Safari):** botão Compartilhar → *Adicionar à Tela de Início*.
- **Computador (Chrome/Edge):** ícone de instalar na barra de endereços.

O service worker guarda só os arquivos da interface, para abrir rápido e mostrar uma mensagem clara sem conexão. Respostas da API (contas, transações, sessão) nunca são guardadas. Não há notificações push, sincronização em segundo plano ou analytics.

## Comandos

```bash
npm start        # inicia o servidor
npm test         # testes (node:test, sem dependências extras)
npm run backup   # backup online do SQLite em DATA_DIR/backups
```

Os testes usam SQLite em memória e um Actual simulado. Nenhum teste acessa um orçamento real. A busca também é verificada no motor real do `@actual-app/api`, offline, com um orçamento fictício criado numa pasta temporária. Nenhum teste chama a OpenAI: as respostas do modelo são simuladas, então `npm test` não precisa de chave, créditos nem internet.

## Deploy, atualização e backup

- [Deploy no Ubuntu Server com systemd](docs/DEPLOYMENT.md)
- [Guia de atualização da instalação existente no homelab](docs/UPGRADE-HOMELAB.md)

## Documentação técnica

- [Arquitetura](docs/ARCHITECTURE.md)
- [API HTTP](docs/API.md)
- [Parser](docs/PARSER.md)
- [Modo IA (OpenAI)](docs/AI.md)
- [Segurança](docs/SECURITY.md)
- [Decisões técnicas](docs/DECISIONS.md)
