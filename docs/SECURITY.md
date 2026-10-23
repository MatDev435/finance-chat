# Segurança

## Segredos

Credenciais do Actual são lidas somente pelo backend através de `process.env`. Não devem aparecer no frontend, HTML, logs, respostas da API, issues ou chats. O `.env` real é local; `.env.example` contém placeholders.

## Cache do Actual

`ACTUAL_DATA_DIR` contém o cache local usado pelo `@actual-app/api` e pode conter dados sensíveis. O diretório deve ter permissões restritas ao usuário do serviço.

## Escrita e confirmação

Parsing, validação e preview não criam transações. A escrita só ocorre em `POST /confirm`, depois da confirmação explícita. A pendência é removida antes da chamada ao Actual, impedindo duplicação pela mesma pendência. Em falha da escrita, ela não é restaurada automaticamente.

## Rede

- O bind padrão é `127.0.0.1`.
- Use reverse proxy para HTTPS e exposição externa.
- Se `HOST=0.0.0.0` for necessário, limite firewall e rede ao reverse proxy.
- CORS não substitui autenticação nem firewall.
- A aplicação não possui autenticação de usuário própria.

## Dados enviados

Transações confirmadas usam a conta fixa validada `Bradesco`, valor inteiro em centavos, `payee_name`, ID de categoria e `notes` somente quando informado. Categorias não são criadas automaticamente.
