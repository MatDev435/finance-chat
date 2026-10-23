# Deployment

## Requisitos

- Node.js compatível com `package.json`.
- Acesso do processo ao servidor Actual.
- Diretório gravável para `ACTUAL_DATA_DIR`.
- Reverse proxy opcional, como Caddy.

Docker não é necessário.

## Instalação

```bash
npm ci --omit=dev
cp .env.example .env
npm start
```

Preencha `.env` localmente e nunca compartilhe seu conteúdo. Verifique o processo com:

```bash
curl -i http://127.0.0.1:3000/health
```

## Configuração

- `ACTUAL_SERVER_URL`: URL base do Actual, com `http://` ou `https://`.
- `ACTUAL_SERVER_PASSWORD`: senha do servidor Actual.
- `ACTUAL_SYNC_ID`: Sync ID do orçamento.
- `ACTUAL_ENCRYPTION_PASSWORD`: senha E2E, se habilitada; pode ficar vazia caso contrário.
- `ACTUAL_DATA_DIR`: cache local da API; padrão `./data/actual`.
- `PORT`: porta HTTP; padrão `3000`.
- `HOST`: interface de bind; padrão `127.0.0.1`.
- `CORS_ORIGIN`: origem exata de frontend separado; normalmente vazia.
- `APP_TIME_ZONE`: timezone de data/mês; padrão `America/Sao_Paulo`.

## Caddy na mesma máquina

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

O navegador recebe frontend e API pela mesma origem HTTPS, portanto CORS não é necessário.

Se Caddy estiver em outro host, `127.0.0.1` aponta para o host do Caddy, não para a VM. Use o endereço real da VM e configure `HOST`/firewall para permitir somente o tráfego necessário:

```caddyfile
chat.example.com {
    reverse_proxy 192.0.2.10:3000
}
```

## Diagnóstico

Na VM:

```bash
ss -ltnp | grep ':3000'
curl -i http://127.0.0.1:3000/health
```

No host do Caddy:

```bash
curl -i http://IP_DA_VM:3000/health
caddy validate --config /etc/caddy/Caddyfile
```

Se o curl local funciona e o curl do Caddy falha, investigue bind, firewall ou rede da VM; não é CORS. DNS deve apontar o subdomínio para o endereço alcançável pelo Caddy. TLS pode terminar no Caddy enquanto o upstream usa HTTP local.
