# Guia de atualização: Finance Chat 0.1 → 0.2 no homelab

Este guia atualiza a instalação atual (Node.js direto no Ubuntu Server, gerenciado pelo systemd) para a versão com login, múltiplos usuários, múltiplas contas e SQLite. Cada comando vem com o motivo. Nada aqui usa Docker.

> **Importante:** a configuração do systemd do homelab **não estava documentada no repositório**. Nem o `docs/DEPLOYMENT.md` antigo nem outros arquivos citavam a unit. Por isso o passo 1 descobre a configuração real antes de qualquer mudança. Execute os passos na ordem e só avance quando o anterior estiver ok.

## O que muda

| Antes (0.1) | Agora (0.2) |
| --- | --- |
| Sem login | Cadastro, login, sessão persistente e logout |
| Uma conta fixa, procurada pelo nome `Bradesco` | Uma conversa por conta do Actual, identificada pelo ID estável |
| Credenciais do Actual no `.env` (`ACTUAL_*`) | Cada usuário informa as suas na interface; ficam cifradas no SQLite |
| Sem banco de dados | SQLite em `DATA_DIR` (usuários, sessões, conexões, preferências) |
| Cache do Actual em `ACTUAL_DATA_DIR` | Cache por usuário em `DATA_DIR/actual/<id>` |
| `CORS_ORIGIN` opcional | Removido: frontend e API sempre na mesma origem |
| Rotas `/preview`, `/confirm`, `/cancel` sem autenticação | Rotas `/api/chat/*` autenticadas |

Se algum script, atalho do celular ou automação chamava as rotas antigas diretamente, ele vai parar de funcionar.

**Variáveis removidas:** `ACTUAL_SERVER_URL`, `ACTUAL_SERVER_PASSWORD`, `ACTUAL_SYNC_ID`, `ACTUAL_ENCRYPTION_PASSWORD`, `ACTUAL_DATA_DIR`, `CORS_ORIGIN`.
**Variáveis novas:** `APP_SECRET` (obrigatória), `DATA_DIR`, `TRUST_PROXY`, `COOKIE_SECURE`, `ALLOW_SIGNUP`, `BACKUP_KEEP`.
**Mantidas:** `HOST`, `PORT`, `APP_TIME_ZONE`.

A estratégia é instalar a versão nova **numa pasta nova, ao lado da antiga**. A pasta antiga fica intacta, e o rollback é só apontar o serviço de volta para ela.

---

## 1. Descobrir a configuração atual (somente leitura)

Nada aqui altera o servidor.

```bash
# Qual é o nome do serviço?
systemctl list-units --type=service --all | grep -i -E 'finance|chat'
```

Anote o nome como **`<SERVICO>`** (exemplo: `finance-chat.service`).

```bash
# A unit completa: usuário, pasta, comando e arquivo de variáveis
systemctl cat <SERVICO>
systemctl show -p FragmentPath,User,Group,WorkingDirectory,ExecStart,EnvironmentFiles <SERVICO>
```

Anote:

- **`<UNIT>`**: o caminho em `FragmentPath` (exemplo: `/etc/systemd/system/finance-chat.service`);
- **`<USUARIO>`** e **`<GRUPO>`**: `User=`/`Group=`. Vazio significa `root`, o que vale corrigir agora (veja o passo 8);
- **`<PASTA_ANTIGA>`**: `WorkingDirectory=`;
- o comando de `ExecStart` (`node src/server.js` ou `npm start`) e o caminho do `node`;
- `EnvironmentFile=`, se existir. Se não existir, o `.env` está em `<PASTA_ANTIGA>/.env` e é lido pelo `dotenv`.

```bash
# Versões disponíveis para o usuário do serviço (precisa de Node >= 20)
sudo -u <USUARIO> -H bash -lc 'command -v node; node --version; npm --version'

# O processo em execução, para conferir
ps -o user,pid,cmd -C node

# A pasta antiga é um clone git?
sudo git -C <PASTA_ANTIGA> log --oneline -1 2>/dev/null || echo "não é git"

# Onde está o cache atual do Actual? (padrão: <PASTA_ANTIGA>/data/actual)
sudo grep -E '^(ACTUAL_DATA_DIR|HOST|PORT|APP_TIME_ZONE|CORS_ORIGIN)=' <PASTA_ANTIGA>/.env
```

Anote `HOST`, `PORT` e `APP_TIME_ZONE`: os mesmos valores serão usados na versão nova, para que o Caddy continue funcionando sem mudanças. Se `CORS_ORIGIN` estiver preenchida, o frontend era servido de outra origem, e esse modo não existe mais: use o endereço do próprio Finance Chat.

Verifique também a versão do servidor Actual. O Finance Chat 0.2 usa `@actual-app/api` 26.11.0:

```bash
curl -s https://SEU-ACTUAL/info
```

Versões muito diferentes podem ser incompatíveis (a interface mostraria "versões incompatíveis").

---

## 2. Backup da instalação atual

Assim, qualquer passo pode ser desfeito.

```bash
# Pasta inteira, incluindo .env, node_modules e o cache do Actual
sudo tar -czpf /root/finance-chat-0.1-$(date +%F).tar.gz -C "$(dirname <PASTA_ANTIGA>)" "$(basename <PASTA_ANTIGA>)"

# Unit do systemd, para restaurar exatamente como está
sudo cp <UNIT> /root/finance-chat-0.1.service

# Se houver EnvironmentFile fora da pasta, copie também
# sudo cp /caminho/do/EnvironmentFile /root/finance-chat-0.1.env

sudo chmod 600 /root/finance-chat-0.1-*.tar.gz /root/finance-chat-0.1.service
ls -lh /root/finance-chat-0.1*
```

Você vai precisar destes valores na tela de configuração da versão nova: `ACTUAL_SERVER_URL`, `ACTUAL_SYNC_ID`, `ACTUAL_SERVER_PASSWORD` e, se houver, `ACTUAL_ENCRYPTION_PASSWORD`. Para consultar no momento de usar:

```bash
sudo grep '^ACTUAL_' <PASTA_ANTIGA>/.env
```

O comando mostra as senhas no terminal: não cole a saída em lugar nenhum.

---

## 3. Obter a nova versão

Escolha a pasta nova, **`<PASTA_NOVA>`**. Recomendo `/opt/finance-chat`, ou uma pasta irmã da antiga se preferir manter tudo no mesmo lugar.

### Opção A: copiar da sua máquina com rsync (parecido com o fluxo atual)

Na sua máquina de desenvolvimento, dentro do repositório atualizado:

```bash
# Primeiro em modo simulação (-n): mostra o que seria copiado
rsync -avn --exclude '.git/' --exclude 'node_modules/' --exclude '.env' --exclude 'data/' --exclude 'backups/' \
  ./ USUARIO_SSH@SERVIDOR:/tmp/finance-chat-0.2/

# Se a lista estiver certa, rode sem o -n
rsync -av --exclude '.git/' --exclude 'node_modules/' --exclude '.env' --exclude 'data/' --exclude 'backups/' \
  ./ USUARIO_SSH@SERVIDOR:/tmp/finance-chat-0.2/
```

No servidor:

```bash
sudo mv /tmp/finance-chat-0.2 <PASTA_NOVA>
sudo chown -R root:root <PASTA_NOVA>
```

O `.env`, `node_modules` e `data/` nunca são copiados: segredos e dados não saem da sua máquina, e as dependências nativas são instaladas no próprio servidor. O código pertence ao `root` e fica só leitura para o serviço.

### Opção B: git no servidor

O repositório é privado, então o servidor precisa de uma *deploy key* somente leitura:

```bash
sudo ssh-keygen -t ed25519 -f /root/.ssh/finance-chat-deploy -N '' -C 'finance-chat deploy'
sudo cat /root/.ssh/finance-chat-deploy.pub
```

Cadastre a chave pública em GitHub → repositório → *Settings → Deploy keys* (sem permissão de escrita). Depois:

```bash
sudo GIT_SSH_COMMAND='ssh -i /root/.ssh/finance-chat-deploy' git clone git@github.com:SEU_USUARIO/finance-chat.git <PASTA_NOVA>
```

---

## 4. Instalar as dependências

```bash
cd <PASTA_NOVA>
sudo npm ci --omit=dev
```

O `npm ci` instala exatamente as versões do `package-lock.json`, sem as dependências de desenvolvimento. Confira se o SQLite nativo carrega com o Node do serviço:

```bash
sudo -u <USUARIO> -H bash -lc 'cd <PASTA_NOVA> && node -e "new (require(\"better-sqlite3\"))(\":memory:\"); console.log(\"better-sqlite3 ok\")"'
```

Se aparecer erro de binário (`NODE_MODULE_VERSION`, `invalid ELF header`), rode `sudo npm rebuild better-sqlite3`. Isso acontece quando o Node do `npm ci` é diferente do Node do serviço.

---

## 5. Variáveis de ambiente

Gere a chave da aplicação:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Guarde essa chave **também num gerenciador de senhas**. Ela cifra as credenciais do Actual no banco: sem ela, cada usuário precisa reconfigurar a conexão.

Crie o `.env` da pasta nova:

```bash
sudo install -m 600 -o <USUARIO> -g <GRUPO> /dev/null <PASTA_NOVA>/.env
sudo nano <PASTA_NOVA>/.env
```

Conteúdo (troque os valores; `HOST`, `PORT` e `APP_TIME_ZONE` iguais aos do passo 1):

```dotenv
APP_SECRET=cole-aqui-a-chave-gerada
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/finance-chat
TRUST_PROXY=true
COOKIE_SECURE=auto
ALLOW_SIGNUP=false
APP_TIME_ZONE=America/Sao_Paulo
```

- `DATA_DIR` fora da pasta do código: o banco sobrevive a qualquer atualização ou troca de pasta.
- `TRUST_PROXY=true` porque o Caddy está na frente. Assim o limite de tentativas de login enxerga o IP real. Sem proxy, use `false`.
- `COOKIE_SECURE=auto` marca os cookies como `Secure` quando o acesso é por HTTPS.
- `ALLOW_SIGNUP=false`: você (primeiro usuário) consegue se cadastrar mesmo assim. Para outras pessoas, ligue temporariamente.
- **Não** copie as variáveis `ACTUAL_*` nem `CORS_ORIGIN`.

Se a unit usa `EnvironmentFile=`, você pode colocar essas variáveis nesse arquivo em vez do `.env` (permissão `600`). As variáveis do systemd têm prioridade sobre o `.env`.

---

## 6. Diretório do SQLite e permissões

```bash
sudo install -d -o <USUARIO> -g <GRUPO> -m 700 /var/lib/finance-chat
sudo -u <USUARIO> touch /var/lib/finance-chat/.teste && sudo -u <USUARIO> rm /var/lib/finance-chat/.teste && echo "escrita ok"
```

O diretório pertence ao usuário do serviço e só ele lê e escreve. Ali ficam o banco (`finance-chat.sqlite`, criado com permissão `600`), os caches do Actual por usuário (`actual/`) e os backups (`backups/`). Ele não é tocado por atualizações do código.

Se você preferir que o systemd crie e gerencie o diretório, use `StateDirectory=finance-chat` na unit (passo 8). O resultado é o mesmo.

---

## 7. Migrações (automáticas) e teste antes de trocar

As migrações do banco rodam sozinhas na inicialização. São versionadas (`PRAGMA user_version`), transacionais e idempotentes, e não há comando manual. Elas só criam as tabelas do próprio Finance Chat e **não tocam em dados do Actual**.

Para validar a configuração **sem parar a versão antiga**, suba a nova numa porta temporária:

```bash
cd <PASTA_NOVA>
sudo -u <USUARIO> -H bash -lc 'cd <PASTA_NOVA> && PORT=3999 node src/server.js'
```

Em outro terminal:

```bash
curl -i http://127.0.0.1:3999/health
```

Deve responder `{"ok":true}`. O primeiro terminal mostra `Finance Chat ouvindo em http://127.0.0.1:3999 (dados em /var/lib/finance-chat)`. Pare com `Ctrl+C`. O banco já foi criado e migrado.

Se aparecer `Configuração inválida`, a mensagem diz qual variável corrigir. A `APP_SECRET` nunca é exibida.

O teste lê o `.env` da `<PASTA_NOVA>`. Se você preferiu um `EnvironmentFile`, crie temporariamente o `.env` para este teste, ou pule para o passo 8 e valide pelos logs do serviço.

---

## 8. Atualizar o serviço systemd

```bash
sudo systemctl edit --full <SERVICO>
```

Ajuste:

```ini
[Service]
# usuário sem privilégios (se estava vazio/root, crie um: sudo adduser --system --group finance-chat)
User=<USUARIO>
Group=<GRUPO>
WorkingDirectory=<PASTA_NOVA>
# caminho completo do node do passo 1; "npm start" também funciona
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
# arquivos novos (banco, caches, backups) visíveis só para o serviço
UMask=0077
```

- Se havia `EnvironmentFile=` apontando para a pasta antiga, aponte para o arquivo novo (ou remova, se as variáveis estão no `.env` da pasta nova).
- Se o serviço rodava como `root`, crie um usuário próprio e use-o em `User=`/`Group=` e no passo 6. Rodar como root não é necessário.

Endurecimento opcional (recomendado). Veja o exemplo comentado em `deploy/finance-chat.service`:

```ini
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/finance-chat
# use read-only se o código ou o node (nvm) estiverem em /home
ProtectHome=true
```

Com `ProtectSystem=strict`, o serviço só escreve em `ReadWritePaths`, que precisa conter o `DATA_DIR`. Recarregue:

```bash
sudo systemctl daemon-reload
systemctl cat <SERVICO>   # confira o resultado
```

---

## 9. Reiniciar a aplicação

```bash
sudo systemctl restart <SERVICO>
systemctl status <SERVICO> --no-pager
```

O `restart` para a versão antiga e inicia a nova a partir da `<PASTA_NOVA>`. A interrupção dura poucos segundos.

---

## 10. Verificar logs e testar

```bash
journalctl -u <SERVICO> -n 50 --no-pager
curl -i http://127.0.0.1:<PORT>/health
```

O log deve conter `Finance Chat ouvindo em ... (dados em /var/lib/finance-chat)`. Erros do Actual aparecem como `[actual] ACTUAL_ERROR <motivo>`, sem senhas.

No navegador, pelo endereço de sempre (via Caddy):

1. A tela abre em **Criar conta**. Crie o seu usuário.
2. Na tela **Conectar ao Actual Budget**, informe o endereço do servidor, o Sync ID e a senha do servidor (os valores do `.env` antigo; consulte com o comando do passo 2). Marque a criptografia só se havia `ACTUAL_ENCRYPTION_PASSWORD`.
3. Clique em **Testar conexão**. A resposta deve ser "Conexão funcionando! N contas encontradas".
4. Clique em **Salvar e continuar**. A lista mostra as suas contas (Nubank etc.).
5. Primeiro, um teste **somente leitura**: na conversa Nubank, envie `Quanto ainda tenho em <uma categoria sua>?`. Nada é gravado.
6. Na próxima movimentação real, use o Finance Chat e confira no Actual se ela apareceu **na conta da conversa**.
7. Em **⋯ → Configurações**, escolha a conta padrão.
8. Opcional: nas ferramentas do navegador (*Application → Cookies*), os cookies `fc_access` e `fc_refresh` devem estar marcados como `HttpOnly` e `Secure`.

Para acompanhar ao vivo durante os testes:

```bash
journalctl -u <SERVICO> -f
```

---

## 11. Rollback (voltar para a 0.1)

Como a pasta antiga não foi alterada, o rollback é restaurar a unit:

```bash
sudo cp /root/finance-chat-0.1.service <UNIT>
sudo systemctl daemon-reload
sudo systemctl restart <SERVICO>
journalctl -u <SERVICO> -n 30 --no-pager
```

A versão 0.1 volta a rodar da `<PASTA_ANTIGA>` com o `.env` antigo. Ela ignora `/var/lib/finance-chat`, que pode ficar onde está para uma nova tentativa. Se algo na pasta antiga tiver sido alterado por engano, restaure o tar do passo 2:

```bash
sudo systemctl stop <SERVICO>
sudo mv <PASTA_ANTIGA> <PASTA_ANTIGA>.quebrada
sudo tar -xzpf /root/finance-chat-0.1-AAAA-MM-DD.tar.gz -C "$(dirname <PASTA_ANTIGA>)"
sudo systemctl start <SERVICO>
```

---

## 12. Limpeza (depois de alguns dias funcionando)

As credenciais do Actual não precisam mais ficar em texto puro no `.env` antigo:

```bash
sudo shred -u <PASTA_ANTIGA>/.env        # ou remova a pasta antiga inteira
sudo rm -rf <PASTA_ANTIGA>/data/actual   # cache antigo do orçamento
```

Guarde o tar do passo 2 num local seguro (ele contém o `.env` antigo com senhas) ou apague-o quando não precisar mais de rollback.

---

## 13. Rotina de backup

O que proteger: `/var/lib/finance-chat/finance-chat.sqlite` e a `APP_SECRET`. Os caches do Actual são baixados de novo automaticamente.

Backup manual, seguro com o serviço rodando:

```bash
sudo -u <USUARIO> -H bash -lc 'cd <PASTA_NOVA> && npm run backup'
ls -l /var/lib/finance-chat/backups/
```

Backup diário com timer do systemd:

```bash
sudo cp <PASTA_NOVA>/deploy/finance-chat-backup.service <PASTA_NOVA>/deploy/finance-chat-backup.timer /etc/systemd/system/
sudo systemctl edit --full finance-chat-backup.service   # ajuste User, Group, WorkingDirectory, ExecStart, EnvironmentFile
sudo systemctl daemon-reload
sudo systemctl enable --now finance-chat-backup.timer
systemctl list-timers finance-chat-backup.timer
```

Copie `/var/lib/finance-chat/backups/` para outro disco ou máquina de tempos em tempos. Para restaurar, siga [DEPLOYMENT.md → Restauração](DEPLOYMENT.md#restauração).

---

## Problemas comuns

| Sintoma | Causa provável e solução |
| --- | --- |
| Serviço não sobe; log `Configuração inválida: APP_SECRET…` | Faltou a `APP_SECRET` ou ela é curta demais (passo 5). |
| `SqliteError: unable to open database file` ou `EACCES` | Dono ou permissão de `/var/lib/finance-chat` (passo 6), ou `ReadWritePaths` ausente com `ProtectSystem=strict`. |
| Erro de binário do `better-sqlite3` | Node diferente entre instalação e execução: `sudo npm rebuild better-sqlite3`. |
| `status=203/EXEC` ou `226/NAMESPACE` | Caminho do `node` errado no `ExecStart`, ou `ProtectHome=true` com node/código em `/home` (use `read-only`). |
| "Origem não permitida" ao entrar | O proxy está alterando o `Host`. O Caddy preserva por padrão. No nginx, use `proxy_set_header Host $host;`. |
| Login funciona mas a sessão não fica salva | Acesso por HTTP puro com `COOKIE_SECURE=true`. Use `auto`, ou acesse por HTTPS. |
| "O servidor Actual recusou a senha" | Senha do servidor errada, ou o servidor usa OpenID. Nesse caso use uma chave de API. |
| "versões incompatíveis" | Servidor Actual e `@actual-app/api` muito distantes. Atualize o servidor Actual, ou peça a atualização do pacote no Finance Chat. |
| Login bloqueado por tentativas | Espere o tempo indicado ou reinicie o serviço (o contador fica em memória). |
