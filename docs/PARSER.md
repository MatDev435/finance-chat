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

## Perguntas de categoria

```text
Quanto ainda tenho disponível em Alimentação?
Quanto eu tenho disponível na categoria Alimentação este mês?
Posso gastar R$ 50 com Alimentação?
Tenho R$ 50 para gastar em Alimentação
```

Essas mensagens são somente leitura.

## Erros

Entradas inválidas usam `code: INVALID_COMMAND`. Conta ou categoria inexistente usam `VALIDATION_ERROR` na etapa de validação.
