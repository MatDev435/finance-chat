# Deploy no Ubuntu Server (systemd)

Instalação do zero. Para atualizar uma instalação existente da versão 0.1, siga o [guia de atualização](UPGRADE-HOMELAB.md).

O modelo é: código em `/opt/finance-chat`, dados em `/var/lib/finance-chat`, serviço systemd rodando com um usuário próprio e Caddy na frente com HTTPS. Docker não é usado.

## 1. Node.js

É preciso Node.js 20 ou mais recente:

```bash
node --version
```

Se não houver um Node adequado, instale um LTS pelo repositório da NodeSource ou pelo gerenciador que você já usa. Anote o caminho com `command -v node`: ele vai no `ExecStart` do systemd.

## 2. Usuário do sistema

```bash
sudo adduser --system --group --home /var/lib/finance-chat --no-create-home finance-chat
```

O serviço roda sem privilégios e sem shell de login.

## 3. Código

Exemplo com `git` (o repositório é privado: use uma *deploy key* somente leitura):

```bash
sudo git clone git@github.com:SEU_USUARIO/finance-chat.git /opt/finance-chat
sudo chown -R root:root /opt/finance-chat
cd /opt/finance-chat
sudo npm ci --omit=dev
```

O código pertence ao `root` e é só leitura para o serviço, que escreve apenas em `/var/lib/finance-chat`. Confira se o SQLite nativo carregou:

```bash
node -e "new (require('better-sqlite3'))(':memory:'); console.log('better-sqlite3 ok')"
```

Se falhar, rode `sudo npm rebuild better-sqlite3`.

## 4. Configuração

```bash
sudo install -d -m 750 /etc/finance-chat
sudo install -m 600 /dev/null /etc/finance-chat/finance-chat.env
sudo nano /etc/finance-chat/finance-chat.env
```

Conteúdo mínimo (gere a chave com o comando do `.env.example`):

```dotenv
APP_SECRET=cole-aqui-a-chave-gerada
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=true
COOKIE_SECURE=auto
ALLOW_SIGNUP=false
APP_TIME_ZONE=America/Sao_Paulo
```

`DATA_DIR` é definido na unit (`/var/lib/finance-chat`). **Guarde a `APP_SECRET` também num gerenciador de senhas.**

## 5. Serviço systemd

```bash
sudo cp /opt/finance-chat/deploy/finance-chat.service /etc/systemd/system/
sudo nano /etc/systemd/system/finance-chat.service   # ajuste ExecStart com o caminho do node
sudo systemctl daemon-reload
sudo systemctl enable --now finance-chat
systemctl status finance-chat
```

`StateDirectory=finance-chat` faz o systemd criar `/var/lib/finance-chat` com dono `finance-chat` e modo `700`. O banco e as migrações são criados na primeira inicialização.

## 6. Caddy

```caddyfile
chat.exemplo.com {
    reverse_proxy 127.0.0.1:3000
}
```

O Caddy envia `X-Forwarded-Proto`/`X-Forwarded-For` e preserva o `Host`. Com `TRUST_PROXY=true` e `COOKIE_SECURE=auto`, os cookies saem com `Secure` e o limite de login usa o IP real.

Com o Caddy em outra máquina, use `HOST=0.0.0.0` (ou o IP da VM), restrinja a porta no firewall ao IP do Caddy e aponte o `reverse_proxy` para o IP da VM. Com nginx, inclua `proxy_set_header Host $host;` e `proxy_set_header X-Forwarded-Proto $scheme;`.

## 7. Primeiro acesso

Abra `https://chat.exemplo.com` e crie a primeira conta (o primeiro usuário sempre pode se cadastrar). Depois, informe os dados do Actual na tela guiada.

Para cadastrar outra pessoa: coloque `ALLOW_SIGNUP=true`, rode `sudo systemctl restart finance-chat`, peça o cadastro e volte para `false`.

## Operação

```bash
sudo systemctl restart finance-chat        # reiniciar
journalctl -u finance-chat -f              # logs ao vivo
journalctl -u finance-chat --since today   # logs de hoje
curl -i http://127.0.0.1:3000/health       # saúde do processo
```

## Backup

O que importa:

1. `/var/lib/finance-chat/finance-chat.sqlite`: usuários, sessões, conexões e preferências;
2. a `APP_SECRET`: sem ela, as conexões salvas não podem ser decifradas.

Os caches em `/var/lib/finance-chat/actual/` são cópias dos orçamentos e podem ser baixados de novo do servidor Actual. Não precisam de backup.

Backup manual (seguro com o serviço rodando, usa a API de backup online do SQLite):

```bash
cd /opt/finance-chat
sudo -u finance-chat env DATA_DIR=/var/lib/finance-chat node scripts/backup.js
ls -l /var/lib/finance-chat/backups/
```

Backup diário automático:

```bash
sudo cp /opt/finance-chat/deploy/finance-chat-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now finance-chat-backup.timer
systemctl list-timers finance-chat-backup.timer
```

Copie `/var/lib/finance-chat/backups/` periodicamente para fora da máquina (outro disco, NAS etc.).

## Restauração

```bash
sudo systemctl stop finance-chat
sudo -u finance-chat cp /var/lib/finance-chat/backups/finance-chat-AAAAMMDD-HHMMSS.sqlite /var/lib/finance-chat/finance-chat.sqlite
sudo rm -f /var/lib/finance-chat/finance-chat.sqlite-wal /var/lib/finance-chat/finance-chat.sqlite-shm
sudo systemctl start finance-chat
```

Use a mesma `APP_SECRET` da época do backup.

## Atualização de versões

```bash
cd /opt/finance-chat
sudo -u finance-chat env DATA_DIR=/var/lib/finance-chat node scripts/backup.js
sudo git pull
sudo npm ci --omit=dev
sudo systemctl restart finance-chat
journalctl -u finance-chat -n 50
```

As migrações rodam sozinhas na inicialização. Para voltar uma versão, faça `git checkout <commit anterior>`, `npm ci --omit=dev` e reinicie. Se a versão nova tiver migrado o banco, restaure o backup feito antes da atualização: a versão antiga recusa iniciar com um banco mais novo.
