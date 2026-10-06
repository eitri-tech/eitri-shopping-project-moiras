# Átropos — veredito e soluções

Corta o fio: para cada issue, explica o problema, decide o encaminhamento e sugere **no máximo 3 soluções**, cada uma com a porcentagem de confiança de que resolve o problema. Depois, anota a solução que o usuário escolher, para ser reaproveitada nas próximas triagens.

**Recomenda, não executa.** A única escrita desta etapa é no registro de soluções, e só depois da escolha do usuário.

## Contrato

```json
{
  "entrada": {
    "ticket": { "key": "PROJ-1423", "resumo": "", "descricao": "", "prioridade": "High", "status": "To Do", "duedate": "2026-11-30", "folga_dias": 15 },
    "classificacao": "<saída da Láquesis para esta issue, com os avisos acumulados>",
    "precedentes": [
      { "id": "PROJ-1187-1", "solucao": "", "resultado": "resolveu | nao-resolveu | pendente", "ref": ".moiras/solucoes.md#proj-1187-1" }
    ]
  },
  "saida": {
    "key": "PROJ-1423",
    "acao": "duplicado | bloqueado | pronto-para-dev | precisa-de-info | fechar",
    "duplicado_de": "PROJ-1187 | null",
    "justificativa": {
      "problema": "O carrinho é recriado quando o usuário troca de seller.",
      "causa_provavel": "O orderForm antigo é descartado na troca de seller em vez de ser atualizado.",
      "evidencias": []
    },
    "solucoes": [
      {
        "titulo": "Manter o orderFormId na troca de seller",
        "descricao": "",
        "repositorios": ["acme-shop-shared"],
        "passos": [],
        "confianca": 70,
        "esforco": "P | M | G",
        "riscos": "",
        "precedente": "PROJ-1187-1 | null",
        "fontes": []
      }
    ],
    "avisos": ["<classificacao.avisos + os desta etapa>"]
  }
}
```

`ticket` é o item completo de `jira.issues` guardado na Cloto.

## 1. Precedentes

Antes de decidir, leia o registro de soluções (caminho em `memoria.solucoes` de `.moiras/sources.json`, padrão `.moiras/solucoes.md`, relativo à raiz do projeto) e separe as entradas com o mesmo repositório **e** componente, ou com sintoma parecido. Elas formam `precedentes`, identificadas pelo `id` da entrada. Registro ausente ou vazio não é erro: siga sem precedentes.

## 2. Justificativa (obrigatória)

Toda issue sai com `justificativa`, inclusive `duplicado`, `fechar` e `precisa-de-info`:

- `problema`: o que está acontecendo, em uma ou duas frases, na linguagem do usuário final.
- `causa_provavel`: a hipótese técnica. Se não houver evidência para uma hipótese, escreva "indeterminada" e diga o que falta.
- `evidencias`: as fontes que sustentam as duas frases acima (formato de fonte do `SKILL.md`).

## 3. Ação

| Ação | Quando |
|---|---|
| `duplicado` | a Láquesis achou uma duplicata com `similaridade` ≥ 0.8 **e** `relacao: mesmo-incidente`; `duplicado_de` é obrigatório. Com `recorrencia`, não é duplicado: cite a candidata na justificativa e trate a issue como problema novo, usando a correção anterior como pista. Com similaridade entre 0.5 e 0.79 ou `relacao: incerta`, cite a candidata e use `precisa-de-info` |
| `bloqueado` | depende de algo externo (outra issue, plataforma, decisão) citado nas evidências |
| `pronto-para-dev` | descrição e critérios claros, `confianca` da Láquesis ≥ 0.8 e sem bloqueio |
| `precisa-de-info` | `confianca` da Láquesis < 0.5, `origem: desconhecida` ou faltam passos para reproduzir |
| `fechar` | evidência explícita de que não se aplica mais (decisão em `${CLAUDE_PLUGIN_ROOT}/knowledge/decisions.md`, no registro de soluções ou no Slack) |

Na dúvida entre duas ações, escolha a mais conservadora (`precisa-de-info`). Se nenhuma linha da tabela se aplicar (ex.: confiança entre 0.5 e 0.79, sem bloqueio nem duplicata), use `precisa-de-info` e diga na justificativa qual evidência falta para chegar a `pronto-para-dev`.

## 4. Soluções (no máximo 3)

- De 1 a 3 soluções, em ordem decrescente de confiança. `duplicado` e `fechar` podem vir sem soluções; em `precisa-de-info`, a primeira solução é o que investigar ou perguntar.
- Soluções diferentes de verdade: não repita a mesma ideia com outra redação.
- `confianca` é a porcentagem (0 a 100) de chance de a solução resolver o problema, não a qualidade dela. As soluções não são excludentes, então as porcentagens não precisam somar 100.

Como calibrar:

| Situação | Efeito na confiança |
|---|---|
| Teto | nunca acima de `confianca` da Láquesis × 100: se o diagnóstico é incerto, a solução também é |
| Precedente com `resultado: resolveu` | até +20, cite em `precedente` |
| Precedente com `resultado: nao-resolveu` | não sugira de novo sem dizer o que muda; −20 |
| Sem fonte que ligue a solução ao problema | no máximo 40 |
| `causa_provavel` indeterminada | no máximo 30 |

## 5. Saída para o usuário

Apresente uma tabela na ordem da Cloto (prioridade, data fim) com: chave, resumo, folga até o fim do épico, ação, melhor solução e sua confiança. Depois, por issue: a justificativa e as soluções numeradas (1 a 3). Em seguida, as sugestões de glossário (`glossario_sugestoes`) agrupadas por repositório. Por fim, as saídas completas em JSON.

Termine perguntando qual solução foi escolhida em cada issue (ex.: `PROJ-1423: 2`), aceitando "nenhuma".

## 6. Registro de soluções

Quando o usuário escolher, registre a escolha no arquivo de `memoria.solucoes` (o mesmo lido no passo 1; crie se não existir).

Cada entrada é uma **aplicação** de uma solução a uma issue, com `id` único `<KEY>-<n>`: `n` começa em 1 e cresce a cada nova tentativa na mesma issue.

```markdown
## PROJ-1423-1

- issue: PROJ-1423
- data: 2026-10-06
- problema: O carrinho é recriado quando o usuário troca de seller.
- causa_provavel: O orderForm antigo é descartado na troca de seller.
- repositorios: acme-shop-shared
- componente: checkout
- categoria: bug
- solucao: Manter o orderFormId na troca de seller
- descricao: <descrição da solução>
- passos:
  1. <passo>
- riscos: <riscos>
- fontes: <refs das fontes da solução e da justificativa>
- confianca: 70
- alternativas_descartadas: Recriar o carrinho e reaplicar os itens (45)
- escolhida_por: <usuário>
- resultado: pendente
- observacao:
```

- **Idempotência:** se a última entrada da issue tem a mesma `solucao` e `resultado: pendente`, a escolha é uma confirmação: não crie outra entrada. Crie `<KEY>-<n+1>` só quando for outra solução ou uma nova tentativa depois de um resultado conhecido.
- **Edição:** entradas não são apagadas nem reescritas. A única exceção são os campos `resultado` (`pendente` → `resolveu` ou `nao-resolveu`) e `observacao`, atualizados pelo `id` quando o usuário contar o desfecho daquela aplicação.
- Escolha "nenhuma" não gera entrada.
- Referencie entradas pelo `id` (em `precedente`) ou pela âncora (`<caminho>#proj-1423-1`).
- Soluções com `resultado: resolveu` que se repetirem são candidatas a virar decisão em `${CLAUDE_PLUGIN_ROOT}/knowledge/decisions.md` (via PR neste repositório).
