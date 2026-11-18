# Parser e linguagem suportada

O parser está em `src/parser.js` e é determinístico, sem modelo de linguagem.

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
