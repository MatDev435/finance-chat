# Parser e linguagem suportada

O parser está em `src/parser.js` e é determinístico, sem modelo de linguagem.

Com o modo IA ativado ([AI.md](AI.md)), o parser continua sendo a primeira tentativa. O resultado só é usado quando `isCompleteParse` (`src/parse-check.js`) confirma que nenhum campo livre engoliu outro lançamento ou pergunta e quando a categoria existe exatamente no orçamento. Caso contrário, a mensagem inteira vai para a IA. Com a IA desativada, tudo abaixo funciona exatamente como antes.

## Operações

| Palavras iniciais | Tipo |
| --- | --- |
| `gastei`, `comprei`, `mandei` | `expense` |
| `ganhei`, `recebi` | `income` |

A comparação ignora maiúsculas/minúsculas.

## Transações

O formato precisa conter operação, valor, beneficiário e `categoria`:

```text
Gastei 40 reais no mercado categoria alimentação
Ganhei 250,50 de freelance categoria salário
Gastei R$ 10,94 no Uber categoria transporte
```

Valores aceitam inteiros, separadores brasileiro/americano, `R$`/`$` e a forma `10 reais e 94 centavos`. O resultado é convertido para centavos no mapeamento.

Preposições conhecidas antes do beneficiário, como `no`, `na`, `para`, `pra`, `pro`, `da`, `do`, `em` e `de`, são removidas.

## Notas

Uma nota deve vir depois da categoria e começar com `nota` ou `notas`:

```text
Gastei 10 reais e 94 centavos no Uber, categoria transporte, notas indo para tal lugar
```

Resultado relevante:

```js
{
  type: 'expense',
  amount: 10.94,
  description: 'Uber',
  category: 'Transporte',
  notes: 'Indo para tal lugar'
}
```

Sem o marcador, `notes` não é adicionado. `description` continua sendo o beneficiário e vira `payee_name`; `notes` vira o campo `notes` do Actual.

## Compra dividida em várias categorias

Troque `categoria` por `categorias` e liste as partes, cada uma com valor e categoria:

```text
Gastei 100 no mercado: categorias 70 alimentação, 30 limpeza
Gastei 100 no mercado categorias alimentação 70 e limpeza R$ 30
Gastei 100,50 no mercado categorias 70,50 alimentação; 30 limpeza notas compra do mês
Recebi 1.000 da empresa categorias 800 salário, 200 de bônus
```

- O valor pode vir antes ou depois da categoria (`70 alimentação` ou `alimentação 70`), com `R$` e `reais` opcionais.
- Separe as partes com `,`, `;` ou `e` ao lado de um número. Vírgula decimal (`70,50`) e categorias com "e" no nome (`Casa e jardim 40`) continuam funcionando.
- De 2 a 10 partes. **A soma das partes precisa ser igual ao total**, senão a mensagem é recusada com a diferença.
- Data e notas funcionam como em uma categoria só: a data no fim da lista, as notas depois de `notas`.
- No Actual, vira **uma** transação dividida (split), com uma subtransação por parte.
- `categoria` (singular) tem prioridade. Se a mensagem tiver as duas palavras, vale a categoria única, como antes.
- Formato `10 reais e 94 centavos` não é aceito dentro das partes. Use `10,94`.

## Categorias

A categoria é procurada pelo nome, nesta ordem:

1. mesmo nome, ignorando maiúsculas e espaços extras;
2. mesmas letras ignorando acentos (`alimentacao` → `Alimentação`), só quando existe **uma única** categoria assim;
3. se nada corresponder, o Finance Chat sugere até 3 categorias parecidas (distância de edição de Levenshtein, com prioridade para prefixos e trechos do nome). Categorias ocultas não são sugeridas.

```text
Gastei 12 no Uber categoria transprte
→ A categoria 'Transprte' não existe no Actual Budget. Você quis dizer: Transporte?   [Usar “Transporte”]
```

O botão repete a mesma mensagem com a categoria escolhida, e a movimentação ainda passa pela prévia normal. O mesmo vale para as perguntas de saldo (`Quanto tenho em Alimetação?`). Tudo é feito por regras fixas, sem IA.

## Datas

Sem data, a movimentação usa o dia de hoje (no fuso `APP_TIME_ZONE`). Para outra data, escreva uma destas expressões **antes do comando** ou **no fim da categoria** (antes de `notas`):

| Expressão | Significado |
| --- | --- |
| `hoje`, `ontem`, `anteontem` | relativo a hoje |
| `dia 12` | o dia 12 mais recente que não esteja no futuro (este mês ou um anterior) |
| `dia 12/11` ou `12/11` | 12 de novembro deste ano, ou do ano passado se ainda não chegou |
| `dia 12/11/2026`, `12/11/2026`, `12/11/26` | data exata |

Pode vir precedida de `em`, `no` ou `na`:

```text
Ontem gastei 40 reais no mercado categoria alimentação
Gastei 40 no mercado categoria alimentação, dia 12
No dia 3/11/2026, recebi 100 da empresa categoria salário
Gastei 10,94 no Uber, categoria transporte, 12/11, notas voltando para casa
```

Regras:

- Datas futuras e datas inexistentes (`31/04`, `29/02/2026`) são recusadas com uma mensagem clara.
- A data só é reconhecida nessas duas posições. Dentro das notas, "ontem" continua sendo texto.
- Uma categoria formada só por uma palavra de data (por exemplo, uma categoria chamada `Hoje`) continua sendo categoria.
- Informar a data duas vezes é erro.
- A prévia mostra a data antes da confirmação.

## Desfazer

Logo depois de registrar uma movimentação, você pode desfazê-la:

```text
desfazer
desfaz o último
desfazer o último lançamento
```

Ou use o botão **↶ Desfazer** que aparece na mensagem de sucesso. Regras:

- Só vale para a **última** movimentação confirmada **naquela conversa**, por **10 minutos**, e só uma vez.
- Só apaga se a transação continuar no Actual exatamente como foi criada (mesma conta, data e valor). Se você a alterou ou apagou no Actual, nada é desfeito.
- Uma compra dividida é desfeita inteira.
- Um lote de várias movimentações (modo IA) também pode ser desfeito inteiro, se todas tiverem sido registradas; se alguma tiver mudado no Actual, nada é desfeito.
- O botão aparece só enquanto a página está aberta. O comando `desfazer` funciona também depois de recarregar, dentro do prazo.

## Quanto gastei

Perguntas de gasto ou recebimento numa categoria ou num beneficiário, sem IA:

```text
quanto gastei com alimentação?
quanto gastei com alimentação em outubro?
quanto gastei com alimentação em março de 2025?
quanto paguei no mercado esse mês?
quanto recebi da empresa este ano?
quanto gastei em outubro?
quanto gastei com alimentação nos últimos 3 meses por mês?
quanto gastei por mês com alimentação?
```

- Verbos: `gastei`, `paguei`, `comprei` (despesas), `recebi`, `ganhei` (receitas).
- O nome depois de `com`, `em`, `no`, `na`, `de`... é **categoria** se for exatamente o nome de uma categoria (sem diferenciar maiúsculas e acentos); senão, é **beneficiário** (e, sem beneficiário com esse nome, é procurado nas notas).
- Períodos no fim: `hoje`, `ontem`, `esta semana`, `semana passada`, `este mês`, `mês passado`, `este ano`, `ano passado`, `em outubro` (o mais recente já iniciado), `em março de 2025`, `em 2025`, `nos últimos N dias` ou `meses` (N em algarismos ou por extenso, até doze). Sem período, todo o histórico.
- `por mês`, `em cada mês` ou `mês a mês` mostram o total de cada mês separadamente. Sem período, o ano atual; com `nos últimos N meses`, os N meses do calendário (o atual e os anteriores). No máximo 24 meses.
- Vale sempre só a conta da conversa, sem transferências nem saldo inicial.
- Com o modo IA ligado, se o nome não for exatamente uma categoria nem um beneficiário, ou se a frase tiver outros filtros ("quanto gastei hoje no uber"), a mensagem vai para a IA.
- `Quanto tenho em X?` continua sendo o saldo da categoria.

## Resumo do mês

Algumas frases fixas mostram o resumo do mês sem IA:

```text
resumo
resumo do mês
me mostra o resumo do mês
como estou esse mês?
como estão minhas finanças?
resumo do mês passado
como foi o mês passado?
```

O resumo traz despesas, receitas, resultado e as maiores despesas da conta da conversa, mais o gasto do orçamento do mês (todas as contas), as categorias com mais gasto e as estouradas. Outros meses ("resumo de outubro") precisam do modo IA.

## Perguntas de categoria

```text
Quanto ainda tenho disponível em Alimentação?
Quanto eu tenho disponível na categoria Alimentação este mês?
Posso gastar R$ 50 com Alimentação?
Tenho R$ 50 para gastar em Alimentação
```

Essas mensagens são somente leitura.

## Conta

A mensagem não informa a conta: ela vem da conversa em que a mensagem foi enviada, identificada pelo ID estável da conta no Actual. O parser não mudou com a introdução das múltiplas contas.

## Erros

Entradas inválidas usam `code: INVALID_COMMAND`. Categoria inexistente usa `VALIDATION_ERROR` (transações) ou `CATEGORY_NOT_FOUND` (perguntas de saldo). Conta inexistente, fechada ou fora do orçamento usa `ACCOUNT_UNAVAILABLE`.
