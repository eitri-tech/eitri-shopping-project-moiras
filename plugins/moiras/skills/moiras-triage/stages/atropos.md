# Átropos — veredito e soluções

Corta o fio. Para cada issue, explica o problema, decide o encaminhamento e sugere **de 3 a 5 soluções**, cada uma com a porcentagem de confiança de que resolve o problema. Depois, guarda no aprendizado a solução que o usuário escolher, para reaproveitar nas próximas triagens.

**Recomenda, não executa.** Esta etapa só escreve no knowledge local (aprendizado e critérios), e só depois da escolha ou do "sim" do usuário.

## Contrato

```json
{
  "input": {
    "ticket": { "key": "PROJ-123", "summary": "", "description": "", "priority": "High", "status": "To Do", "duedate": "2026-11-30", "buffer_days": 15 },
    "classification": "<saída da Láquesis para esta issue, com os avisos acumulados>",
    "precedents": [
      { "id": "PROJ-187-1", "solution": "", "result": "resolved | not-resolved | pending", "ref": "knowledge:local/learnings/solutions/PROJ-187-1.md" }
    ]
  },
  "output": {
    "key": "PROJ-123",
    "action": "duplicate | blocked | ready-for-dev | needs-info | close",
    "duplicate_of": "PROJ-187 | null",
    "agency": "Agência Aurora | null",
    "justification": {
      "problem": "O carrinho é recriado quando o usuário troca de seller.",
      "probable_cause": "O carrinho antigo é descartado na troca de seller em vez de ser atualizado.",
      "evidence": []
    },
    "solutions": [
      {
        "title": "Manter o id do carrinho na troca de seller",
        "description": "",
        "repositories": ["acme-shop-checkout"],
        "steps": [],
        "confidence": 70,
        "effort": "S | M | L",
        "risks": "",
        "precedent": "PROJ-187-1 | null",
        "sources": []
      }
    ],
    "criteria_suggestions": [
      { "title": "", "rule": "", "reason": "" }
    ],
    "warnings": ["<classification.warnings + os desta etapa>"]
  }
}
```

`ticket` é o item completo de `jira.issues` guardado na Cloto. `agency` da saída é copiado de `classification.agency` (o da Láquesis, que já considera o Jira e o glossário), sem recalcular.

## 1. Precedentes

Antes de decidir, leia `learnings/solutions/` de todos os knowledges (ver `SKILL.md`) e separe os registros com o mesmo repositório **e** componente, ou com sintoma parecido. Leia também `learnings/decisions/`. Eles formam `precedents`, identificados pelo `id` do registro. Sem registros não é erro: siga sem precedentes.

## 2. Justificativa (obrigatória)

Toda issue sai com `justification`, inclusive `duplicate`, `close` e `needs-info`:

- `problem`: o que está acontecendo, em uma ou duas frases, na linguagem do usuário final.
- `probable_cause`: a hipótese técnica. Se não houver evidência para uma hipótese, escreva "indeterminada" e diga o que falta.
- `evidence`: as fontes que sustentam as duas frases acima (formato de fonte do `SKILL.md`).

## 3. Ação

| `action` | Quando |
|---|---|
| `duplicate` | a Láquesis achou uma duplicata com `similarity` ≥ 0.8 **e** `relation: same-incident`; `duplicate_of` é obrigatório. Com `recurrence`, não é duplicado: cite a candidata na justificativa e trate a issue como problema novo, usando a correção anterior como pista. Com similaridade entre 0.5 e 0.79 ou `relation: uncertain`, cite a candidata e use `needs-info` |
| `blocked` | depende de algo externo (outra issue, plataforma, decisão) citado nas evidências |
| `ready-for-dev` | descrição e critérios claros, `confidence` da Láquesis ≥ 0.8 e sem bloqueio |
| `needs-info` | `confidence` da Láquesis < 0.5, `origin: unknown` ou faltam passos para reproduzir |
| `close` | evidência explícita de que não se aplica mais (em `learnings/decisions/`, num precedente ou no Slack) |

Na dúvida entre duas ações, escolha a mais conservadora (`needs-info`). Se nenhuma linha da tabela se aplicar (ex.: confiança entre 0.5 e 0.79, sem bloqueio nem duplicata), use `needs-info` e diga na justificativa qual evidência falta para chegar a `ready-for-dev`.

Critérios do time em `criteria/` podem refinar esta tabela; quando um critério se aplicar, cite-o como fonte.

## 4. Soluções (de 3 a 5)

- Pelo menos 3 soluções, em ordem decrescente de confiança. Quando a Láquesis marcar `complex: true`, dê até 5. Um critério do time pode mudar o máximo ou a regra de complexidade.
- `duplicate` e `close` podem vir sem soluções. Em `needs-info`, as primeiras soluções são o que investigar ou perguntar.
- As soluções precisam ser diferentes de verdade: não repita a mesma ideia com outra redação. Se não houver 3 ideias distintas com alguma fonte, dê as que houver e diga na justificativa por que faltam.
- `confidence` é a porcentagem (0 a 100) de chance de a solução resolver o problema, não a qualidade dela. As soluções não são excludentes, então as porcentagens não precisam somar 100.

Como calibrar:

| Situação | Efeito na confiança |
|---|---|
| Teto | nunca acima de `confidence` da Láquesis × 100: se o diagnóstico é incerto, a solução também é |
| Precedente com `result: resolved` | até +20, cite em `precedent` |
| Precedente com `result: not-resolved` | não sugira de novo sem dizer o que muda; −20 |
| Sem fonte que ligue a solução ao problema | no máximo 40 |
| `probable_cause` indeterminada | no máximo 30 |

## 5. Saída para o usuário

Apresente uma tabela na ordem da Cloto (prioridade, data fim) com: chave, resumo, folga até o fim do épico, ação, melhor solução e sua confiança. Depois, por issue: a justificativa e as soluções numeradas. Em seguida, as sugestões de glossário (`glossary_suggestions`) agrupadas por repositório e as de critérios (`criteria_suggestions`). Por fim, as saídas completas em JSON.

Nas issues com `agency`, escreva na linha da tabela "gerida pela <agência>" e, na seção da issue, avise que o repasse da solução à agência está disponível (seção 9).

No modo interativo, termine perguntando qual solução foi escolhida em cada issue (ex.: `PROJ-123: 2`), aceitando `none`. Inclua também as escolhas pendentes de execuções automáticas anteriores (registros da memória com `choice: null`).

No modo automático, não pergunte: salve o relatório em arquivo (ver `SKILL.md`) e liste as issues que aguardam escolha e as que são geridas por agência.

## 6. Memória

Registre cada veredito em `record atropos`, inclusive no modo automático:

```json
{
  "key": "PROJ-123",
  "run_id": "2026-10-06T11:00:00Z",
  "mode": "interactive | auto",
  "hash": "<hash da entrada>",
  "action": "ready-for-dev",
  "solutions": [{ "title": "", "confidence": 70 }],
  "choice": null
}
```

`choice` é `null` até o usuário escolher. Quando escolher, grave um novo registro da mesma chave com `choice` = número da solução ou `"none"` e, se for uma solução, o `id` do registro criado no aprendizado.

## 7. Aprendizado

Só no modo interativo e só depois da escolha do usuário. Grave no knowledge de escopo `local` (padrão `.moiras/knowledge/`).

Cada registro é uma **aplicação** de uma solução a uma issue, num arquivo próprio `learnings/solutions/<id>.md`, com `id` único `<KEY>-<n>`: `n` começa em 1 e cresce a cada nova tentativa na mesma issue.

```markdown
---
id: PROJ-123-1
type: solution
issue: PROJ-123
created_at: 2026-10-06
chosen_by: <usuário>
agency: Agência Aurora
repositories: [acme-shop-checkout]
component: checkout
category: bug
confidence: 70
result: pending
---

# Manter o id do carrinho na troca de seller

**Problema:** O carrinho é recriado quando o usuário troca de seller.

**Causa provável:** O carrinho antigo é descartado na troca de seller.

**Solução:** <descrição>

1. <passo>

**Riscos:** <riscos>

**Alternativas descartadas:** Recriar o carrinho e reaplicar os itens (45)

**Fontes:** <refs das fontes da solução e da justificativa>

**Observação:**
```

- **Idempotência:** se o último registro da issue tem a mesma solução e `result: pending`, a escolha é uma confirmação: não crie outro. Crie `<KEY>-<n+1>` só quando for outra solução ou uma nova tentativa depois de um resultado conhecido.
- **Edição:** registros não são apagados nem reescritos. A única exceção é `result` (`pending` → `resolved` ou `not-resolved`) e a `Observação`, atualizados pelo `id` quando o usuário contar o desfecho daquela aplicação.
- `agency` só aparece no registro quando a issue tem agência; sem ela, omita a linha.
- Escolha `none` não gera registro.
- Referencie registros pelo `id` (em `precedent`) ou pelo caminho (`knowledge:local/learnings/solutions/PROJ-123-1.md`).
- Nada de texto bruto da issue ou da conversa, segredos ou código com mais de 20 linhas (ver `SKILL.md`).

Soluções com `result: resolved` que se repetem são candidatas a padrão (`learnings/patterns/`) ou decisão (`learnings/decisions/`). Proponha ao usuário e grave só com o "sim".

## 8. Critérios

Quando o usuário discordar de uma ação, de uma categoria ou da ordem das soluções, pergunte se a regra deve valer para os próximos casos. Com o "sim", grave um critério em `criteria/<id>.md` no knowledge local:

```markdown
---
id: <slug-curto>
type: criterion
created_at: 2026-10-06
applies_to: category | origin | action | solutions
replaces: []
---

# <Título da regra>

<A regra, em uma ou duas frases.>

**Por quê:** <o caso que motivou, sem texto bruto da issue>
```

Se o critério novo conflitar com um existente, una os dois num critério regenerado, liste os antigos em `replaces` e apague os arquivos antigos. Critérios só chegam a um knowledge compartilhado pelo `moiras-publish`, com revisão no PR.

## 9. Repasse à agência (opcional)

Só vale para issue com `agency` diferente de `null`. Sem agência, esta seção não existe e nada muda.

- **Quando oferecer:** no modo interativo, logo depois da escolha da solução, pergunte uma vez: "Quer o repasse para a <agência>?". Se o usuário já pediu o repasse na conversa, não pergunte. No modo automático, não ofereça: só sinalize no relatório as issues geridas por agência.
- **O que é:** um rascunho em português, que o usuário copia e envia. O plugin não envia, não comenta no Jira nem posta no Slack; qualquer envio é uma ação separada, com aprovação explícita daquela operação (ver `SKILL.md`, Limites).
- **De qual solução:** a escolhida. Se o usuário pedir o repasse sem ter escolhido, use a de maior confiança e diga no rascunho que a escolha ainda não foi confirmada.
- **Conteúdo:** chave e resumo da issue; o problema; a causa provável (ou "indeterminada"); a solução (descrição, passos e riscos); o que se espera da agência (implementar, validar ou responder uma dúvida); e a confiança da solução.
- **O que não vai:** a agência é um destinatário externo. Não inclua trechos de conversas internas do Slack nem seus permalinks, nomes de outros clientes, segredos nem dados pessoais. Cite como evidência só o que a agência consegue abrir (ex.: a chave da issue). Trechos de código seguem o limite de 20 linhas, com referência.
- **Para onde:** se a agência estiver em `agencies` na configuração e tiver `channel`, sugira esse canal como destino. Agência que não está na lista funciona do mesmo jeito, só sem sugestão de destino.
- **Depois:** o `agency` fica no registro do aprendizado (seção 7). O repasse em si não é gravado.
