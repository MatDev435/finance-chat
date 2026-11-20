# Modo IA (OpenAI)

O modo IA é **opcional, individual e desativado por padrão**. Cada usuário usa a própria chave de API da OpenAI e escolhe o modelo. Com a IA desativada, o Finance Chat funciona exatamente como antes, sem nenhuma chamada externa.

## O que muda com a IA ativada

| Pode | Não pode |
| --- | --- |
| Entender despesas e receitas escritas livremente ("ontem paguei 80 de combustível em transporte") | Gravar qualquer coisa sem a sua confirmação |
| Várias movimentações numa mensagem, com uma prévia única do lote | Escolher uma categoria por conta própria |
| Compras divididas descritas livremente ("metade alimentação, metade livre") | Editar, apagar ou transferir transações |
| Saldo de categorias e simulações ("se eu gastar 80 em transporte, quanto sobra?") | Desfazer lançamentos (o `desfazer` continua só por comando ou botão) |
| Buscar e somar transações da conta da conversa ("quanto gastei no McDonald's nos últimos 3 meses?"), inclusive pelo texto das notas ("quanto gastei com Monster?") | Ver outras contas, saldos ou o histórico do chat |
| Preencher as notas com o que foi comprado ou o motivo ("Gastei 10 no mercado com um monster": beneficiário "mercado", notas "Monster") | |
| Resumo de qualquer mês ("resumo de outubro", "como foi o mês passado?"); as frases fixas ("como estou esse mês?", "resumo do mês") nem passam pela IA | Receber valores do seu orçamento: o resumo é calculado no servidor |
| Perguntar o que falta e continuar a conversa ("Alimentação") | Executar código, consultas ou ações fora do contrato |

## Como ativar

1. Crie uma chave em [platform.openai.com](https://platform.openai.com) (uma chave de projeto, de preferência só com acesso a modelos/respostas). Confira se a conta tem créditos.
2. No Finance Chat, abra **Configurações → Inteligência artificial**.
3. Ative **Usar IA para interpretar mensagens**.
4. Cole a chave, escolha o modelo (o padrão é **GPT-6 Luna**) e clique em **Testar chave e modelo**. O teste faz uma chamada real e pequena (menos de um décimo de centavo de dólar no Luna) e aparece no consumo como "teste".
5. Clique em **Salvar**. O campo da chave é limpo; a partir daí a tela só informa que existe uma chave salva.

Para parar de usar, desligue o switch: nenhuma mensagem é enviada à OpenAI e a chave continua salva. **Remover a chave salva** apaga a chave do banco.

### Roteiro sugerido para o seu teste manual

Use uma conta de testes no Actual ou cancele as prévias (nada é gravado sem **Aprovar**):

1. `Gastei 40 no mercado categoria alimentação` → resolvido pelo parser, sem a nota "Interpretado pela IA".
2. `comi um lanche de 30 conto ontem` → a IA interpreta e pergunta a categoria. Responda `Alimentação` (resolvido localmente, sem nova chamada) ou toque numa sugestão.
3. `Gastei 50 no McDonald's em alimentação, 30 no mercado em livre e 20 na farmácia` → lote com a farmácia pendente; responda `saúde`.
4. `Passei 300 no supermercado, metade alimentação e metade livre` → uma compra dividida.
5. `Comprei 200 de coisas, 120 de alimentação e 70 de higiene` → recusado: a soma não fecha.
6. `Se eu gastar 80 em transporte, quanto sobra?` → simulação, nada é gravado.
7. `Qual foi a última vez que comi no McDonald's?` e depois `E quanto gastei no total?` → busca e continuação.
8. `Quanto tenho em livre? Se tiver mais de 100, registra uma compra de 80` → só a pergunta é respondida.
9. Veja o consumo em **Configurações**.

## Fluxo de uma mensagem

```text
navegador ─ POST /api/chat/preview { accountId, message }
  └─ src/chat.js
       ├─ "desfazer" → regra atual (nunca pela IA)
       ├─ resposta curta a uma pergunta pendente ("Alimentação", "50") → completa o rascunho localmente
       ├─ parser (sempre primeiro)
       │    ├─ IA desligada → fluxo determinístico de sempre
       │    └─ IA ligada → só usa o resultado se isCompleteParse() aceitar
       │                   e a categoria existir exatamente no orçamento
       └─ IA (uma chamada) → plano JSON validado (src/ai/plan.js)
            ├─ perguntas (saldo, simulação, busca) → serviços de leitura → textos fixos
            ├─ lançamentos → mesma validação do parser → prévia (1) ou lote (N)
            │                ou rascunho + pergunta, se faltar valor/categoria
            └─ desfazer / pedido fora do escopo → explicação fixa
POST /api/chat/confirm { pendingId } → revalidação → gravação controlada
```

### Verificação conservadora (`isCompleteParse`)

O parser é guloso: em `Gastei 50 no McDonald's categoria alimentação e 30 no mercado`, tudo depois de `categoria` vira a categoria. Sem IA isso já era recusado (a categoria não existe). Com IA, o resultado do parser só é aceito quando:

1. descrição, categoria (e partes de divisão) não têm números, `R$`/`reais`, outro verbo de lançamento (`gastei`, `paguei`, `recebi`…), palavras de pergunta (`quanto`, `qual`…) ou "e no/na/em…";
2. as notas não têm valores em dinheiro nem outro verbo de lançamento (números simples, como "parcela 3 de 10", são aceitos);
3. a categoria corresponde exatamente ao orçamento (mesmas regras do parser).

Qualquer dúvida manda a **mensagem inteira** para a IA. Um alarme falso custa uma chamada; aceitar meia mensagem perderia um lançamento.

## Contrato com o modelo

Uma chamada à **Responses API** com **Structured Outputs** (`text.format: json_schema`, `strict: true`), sem ferramentas e sem ciclos. O modelo devolve um plano, nunca executa nada:

```json
{
  "operations": [
    {
      "intent": "create_transaction",
      "transaction": {
        "type": "expense", "amount": "45.00", "payee": "Farmácia", "category": null,
        "categoryHints": ["Saúde"], "splits": null, "notes": null,
        "date": { "daysAgo": 1, "day": null, "month": null, "year": null }
      },
      "category": null, "amount": null, "search": null
    }
  ],
  "draftUpdates": [],
  "cancelDraft": false,
  "question": null
}
```

Intenções: `create_transaction`, `category_balance`, `simulate_spend`, `search_transactions`, `month_summary`, `undo`, `unsupported`. O schema completo e as instruções fixas estão em `src/ai/plan-schema.js`; a validação campo a campo, em `src/ai/plan.js` (tipos, enums, tamanhos, valores positivos, datas). Um plano fora do contrato é recusado inteiro (`AI_INVALID_PLAN`).

O que vai para a OpenAI em cada chamada:

- as instruções fixas e o schema (iguais em todas as chamadas, por isso podem ficar em cache);
- a data de hoje e o dia da semana, a moeda;
- os **nomes** das categorias visíveis do orçamento (sem IDs, sem saldos);
- o rascunho pendente, se houver (valores, beneficiários e categorias já conhecidas, sem IDs);
- os filtros da última busca, se houver (nunca os resultados);
- a mensagem.

Nunca vão: nomes de contas, saldos, transações, o histórico do chat, IDs, credenciais. As respostas são pedidas com `store: false`.

## Categorias

A IA **nunca escolhe** a categoria. `category` só recebe o que o usuário escreveu; `categoryHints` vira apenas sugestão na tela.

- Categoria escrita e encontrada (mesmo nome, ou única com as mesmas letras sem acento): usada.
- Ausente: o Finance Chat pergunta, com até 3 sugestões e uma lista com todas as categorias visíveis.
- Inexistente ou ambígua: pergunta de novo, com sugestões por semelhança (o mesmo `matchCategory` do parser).
- Em lotes e divisões, cada campo pendente é resolvido individualmente.

A resposta digitada ("Alimentação", "categoria saúde", "50") é resolvida **sem nova chamada** quando falta exatamente um campo e a resposta corresponde exatamente a uma categoria (ou é só um valor). Respostas livres ("a da farmácia é saúde") vão para a IA, que só pode **preencher campos que faltam**: valores e categorias já conhecidos nunca são alterados.

## Lotes, falhas parciais e desfazer

- Um lançamento: prévia e desfazer como sempre.
- Vários: uma prévia do lote inteiro, aprovada uma vez (`pendingId` de uso único, removido antes de gravar).
- Antes da primeira gravação, conta e todas as categorias são revalidadas: qualquer problema significa **nada gravado**.
- A gravação é em ordem e para na primeira falha. O resultado informa cada item: ✓ registrada, ? resultado incerto (verifique no Actual antes de reenviar), ✗ não registrada (nunca enviada). Não há reenvio automático.
- **Um lote completo pode ser desfeito inteiro** por 10 minutos (botão **↶ Desfazer** ou `desfazer`), como um lançamento único. Na gravação, os IDs criados são identificados pela diferença entre duas leituras da conta (no intervalo de datas do lote) e pareados com os itens por data e valor; se não fecharem exatamente, o desfazer não é oferecido.
- O desfazer de um lote confere **todas** as movimentações antes de apagar qualquer uma (mesma conta, data e valor). Se uma foi apagada ou alterada no Actual, **nada** é desfeito. Uma falha no meio da exclusão é informada como incerta, dizendo quantas já foram apagadas.
- Um lote interrompido (algum item incerto ou não enviado) não pode ser desfeito, e o `desfazer` da conversa é encerrado, para nunca apagar uma movimentação anterior por engano.
- Divisões seguem as regras do parser: de 2 a 10 partes e soma exata. Sem total, o total é a soma das partes informadas; com total diferente, a mensagem é recusada com a diferença.

## Rascunhos e continuidade

Dois contextos curtos, em memória, por usuário e conta, válidos por 15 minutos (`src/conversation.js`):

- **rascunho**: lançamentos que ainda não têm valor ou categoria. Um novo lançamento completo o substitui; "esquece"/"cancela" ou o botão **Descartar** o apagam. Se a conexão com o Actual mudar, ele é descartado.
- **última busca**: só os filtros. "E quanto gastei no total?" ou "e em outubro?" reaproveitam os filtros e trocam apenas o que mudou.

Reiniciar o servidor esquece os dois, como já acontecia com as prévias.

## Busca de transações

Implementada em `src/search.js` com a AQL do `@actual-app/api` (`q()` + `aqlQuery()`, executada em SQL na cópia local do orçamento). O modelo **não escreve consultas**: preenche filtros validados, e o backend monta a consulta.

- **Sempre e só a conta da conversa**, independentemente do que o modelo devolver.
- Filtros: beneficiário (ignora maiúsculas, acentos, espaços e pontuação; depois nomes que contêm o termo; depois grafias próximas), texto das notas, categoria (regras do parser), tipo (despesa, receita, qualquer), período, valor mínimo e máximo.
- **Notas**: "contém", sem diferenciar maiúsculas e acentos (`$like`, que o Actual executa sobre as notas normalizadas). Os curingas digitados (`%`, `?`) são tratados como texto. Em compras divididas, a nota fica na compra inteira: sem filtro de categoria a compra conta uma vez; com filtro de categoria, a parte daquela categoria conta pela nota da compra.
- Se o modelo indicar um beneficiário que não existe ("quanto gastei com Monster?"), o termo é procurado nas notas, e a resposta avisa isso.
- Resultados: lista (até 20, padrão 5), soma, contagem, maior e menor valor. Totais e contagens vêm do Actual; as respostas são textos fixos, **sem segunda chamada à IA**.
- Transferências entre contas e o saldo inicial ficam de fora.
- Divisões são contadas uma vez: com filtro de categoria, contam as partes daquela categoria (`splits: 'inline'`); sem filtro de categoria, conta a compra inteira (`splits: 'none'`).
- Períodos (`src/periods.js`) viram datas explícitas a partir de hoje, e a resposta mostra o intervalo usado.
- Comportamentos verificados no motor real (`test/search-aql.test.js`, offline, com dados fictícios): partes herdam o beneficiário da compra, cada condição AQL aplica só o primeiro operador (por isso os intervalos são listas de condições) e `$oneof` interpola valores no SQL (por isso recebe só IDs lidos do orçamento).

## Resumo do mês

Implementado em `src/summary.js`, só leitura. O modelo (ou o parser, nas frases fixas) só diz **qual mês**; nenhum valor do orçamento é enviado à OpenAI.

- **Conta da conversa** (AQL, mesmas regras da busca): despesas e receitas do período, com contagem, resultado e as 3 maiores despesas.
- **Orçamento do mês, todas as contas** (`getBudgetMonth`): total gasto e orçado nas categorias de despesa, as 3 categorias com mais gasto e as estouradas (saldo negativo).
- O mês atual vai do dia 1 até hoje; meses anteriores, inteiros. Um mês que ainda não começou é recusado. Se o orçamento não tem aquele mês, a parte da conta é respondida mesmo assim.
- Resposta por template fixo e um card no chat; sem segunda chamada à IA.

## Modelos

Somente modelos cuja página oficial lista Structured Outputs e a Responses API (verificado em 19/11/2026 em developers.openai.com):

| Nome | ID da API | Entrada | Entrada em cache | Escrita de cache (30 min) | Saída |
| --- | --- | --- | --- | --- | --- |
| GPT-6 Luna (padrão) | `gpt-6-luna` | US$ 0,10 | US$ 0,01 | US$ 0,125 | US$ 0,50 |
| GPT-6.1 Terra | `gpt-6.1-terra` | US$ 1,00 | US$ 0,05 | US$ 1,25 | US$ 5,00 |
| GPT-6.2 Sol | `gpt-6.2-sol` | US$ 2,00 | US$ 0,10 | US$ 2,50 | US$ 10,00 |
| GPT-6.2 Astra | `gpt-6.2-astra` | US$ 8,00 | US$ 0,40 | US$ 10,00 | US$ 40,00 |

Preços por 1 milhão de tokens, camada Standard, contexto curto (até 272 mil tokens de entrada). Todas as chamadas usam `reasoning.effort: "low"` (GPT-6.2 Sol e Astra recusam `none`). O teste de chave confere se o modelo aparece em `GET /v1/models` para a sua chave e faz uma chamada com o schema real.

## Consumo e custo estimado

Cada chamada à OpenAI vira uma linha em `ai_usage` (nunca a mensagem ou a resposta do modelo):

| Campo | Origem |
| --- | --- |
| `input_tokens`, `cached_input_tokens`, `cache_write_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens` | `usage` da Responses API (`input_tokens_details.cached_tokens`, `.cache_write_tokens`, `output_tokens_details.reasoning_tokens`) |
| `cost_nano_usd` | calculado na hora do registro, em nanodólares (inteiro, sem arredondamento acumulado) |
| `pricing_version` | versão da tabela de preços usada |
| `response_id` | ID da resposta da OpenAI (único: a mesma resposta nunca conta duas vezes) |
| `purpose`, `outcome`, `model`, `local_month` | chat ou teste; ok, recusa, truncada, inválida, rejeitada pelo backend, timeout |

Cálculo (`src/ai/pricing.js`): entrada sem cache = `input − cached − escritas de cache`; custo = sem cache × entrada + cache × entrada em cache + escritas (30 min/12 h) × escrita + saída × saída. A saída já inclui o raciocínio.

- A tabela de preços é **versionada**: um preço novo entra como uma nova versão com data de início. O custo fica gravado em cada linha, então mudanças futuras não alteram o histórico.
- Sem preço seguro (modelo desconhecido, outra camada de serviço, contexto longo, contadores inconsistentes), o consumo é registrado e o custo fica **sem estimativa**, sinalizado na tela.
- Chamada bem-sucedida, recusada, truncada ou com JSON inválido: os tokens informados são registrados. Plano rejeitado pelo backend: registrado e marcado `rejected`. Erro HTTP (chave inválida, sem créditos, limite): nada é registrado (não há uso). Timeout ou conexão perdida depois do envio: uma linha **sem dados de uso**, porque a chamada pode ter sido cobrada.
- O resumo nas configurações mostra só o consumo do próprio usuário (mês atual e acumulado). **Não é o saldo nem o consumo total da chave**: a mesma chave pode ser usada por outros aplicativos.

### Ordem de grandeza

As instruções fixas têm cerca de 1.000 tokens e o schema cerca de 1.000 tokens, ambos cobrados como entrada. Com 30 categorias e uma mensagem curta, uma chamada tem uns 2.200 tokens de entrada e de 200 a 600 de saída (plano mais raciocínio). No GPT-6 Luna, isso dá algo entre **US$ 0,0003 e US$ 0,0006 por mensagem** (cerca de US$ 0,30 a 0,60 a cada mil mensagens que precisarem da IA). Mensagens que o parser entende custam zero. Os números reais ficam registrados no consumo.

O cache de prompt usa o **modo explícito**, com um único ponto de cache depois das instruções fixas: o prefixo pode ser lido do cache (10% do preço de entrada) e a parte variável nunca gera escrita de cache. A primeira chamada depois de 30 minutos paga a escrita (125% do preço de entrada) só sobre esse prefixo.

## Segurança

- A chave é cifrada com AES-256-GCM (`src/secrets.js`), com uma chave derivada da `APP_SECRET` só para esta finalidade (`openai-api-key-v1`) e vinculada ao ID do usuário. A `APP_SECRET` não fica no banco.
- Ela só é decifrada no servidor, imediatamente antes de uma chamada, e só vai no cabeçalho `Authorization`. Nunca volta para o navegador, para logs, mensagens de erro ou URLs. As mensagens de erro da OpenAI (que às vezes citam parte da chave) nunca são repassadas nem registradas: o log guarda só códigos, status e IDs de requisição.
- Rotas com sessão, CSRF e limites: teste de chave (10 a cada 5 min) e chamadas de chat à IA (40 a cada 10 min) por usuário.
- O conteúdo do modelo é tratado como dado não confiável: validado campo a campo, sem caminho para gravar sem confirmação, sem apagar, sem escolher conta ou categoria, sem montar consultas.
- Uma tentativa de "prompt injection" na mensagem no máximo produz uma prévia errada, que você vê e cancela.

## Atualização para a versão 0.4

- Não há variáveis de ambiente novas: a chave e o modelo são configurados por cada usuário na interface.
- A migração 2 (tabelas `ai_settings` e `ai_usage`) roda sozinha na inicialização.
- Faça um backup antes (`npm run backup`). A versão 0.3 se recusa a abrir um banco migrado para a versão 2, então voltar para ela exige restaurar o backup.
- Com a IA em uso, o servidor precisa de saída HTTPS para `api.openai.com`.

## Limitações conhecidas

- A qualidade da interpretação depende do modelo e **não foi validada com chamadas reais**: os testes automatizados simulam as respostas da OpenAI (nenhum teste usa rede, chave ou créditos).
- Rascunhos e filtros de busca vivem em memória: reiniciar o servidor os apaga.
- Lotes interrompidos por uma falha não podem ser desfeitos pelo Finance Chat.
- A busca cobre só a conta da conversa.
- Perguntas mistas respondem só às perguntas; lançamentos condicionais nunca são executados.
- A tabela de preços precisa ser atualizada à mão quando a OpenAI mudar os preços (nova versão em `src/ai/pricing.js`).
