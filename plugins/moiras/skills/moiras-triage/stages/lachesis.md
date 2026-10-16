# Láquesis — classificação

Mede cada issue: diz qual repositório e componente ela toca, se o problema é da plataforma de terceiros ou do próprio app, e se já existe outra issue para o mesmo problema.

Ela lê o glossário de repositórios e os critérios do knowledge (ver `SKILL.md`) e avalia duplicados. Não decide nada: só mede. A decisão é da Átropos.

## Contrato

Uma chamada por issue, na ordem da Cloto.

```json
{
  "input": {
    "key": "PROJ-123",
    "summary": "Carrinho zera ao trocar de seller",
    "description": "...",
    "priority": "High",
    "agency": "Agência Aurora | null",
    "evidence": [
      { "ref": "<permalink do Slack>", "excerpt": "...", "verified_at": "2026-10-03" }
    ],
    "siblings": [
      { "key": "PROJ-187", "summary": "Carrinho perde itens no checkout", "status": "Done", "assignee": "Fulano", "resolved_at": "2026-08-20" }
    ],
    "warnings": ["no-due-date"]
  },
  "output": {
    "key": "PROJ-123",
    "category": "bug",
    "component": "checkout",
    "repositories": [
      { "repo": "acme-shop-checkout", "reason": "app de checkout da loja citada" }
    ],
    "origin": "platform | app | unknown",
    "agency": "Agência Aurora | null",
    "complex": false,
    "confidence": 0.78,
    "duplicates": [
      { "key": "PROJ-187", "similarity": 0.85, "reason": "mesmo sintoma no mesmo componente", "status": "Done", "relation": "same-incident | recurrence | uncertain" }
    ],
    "sources": [
      { "ref": "knowledge:acme/glossary/acme-shop-checkout.md", "excerpt": "...", "verified_at": "2026-10-06" },
      { "ref": "PROJ-187", "excerpt": "...", "verified_at": null }
    ],
    "warnings": ["no-due-date"],
    "glossary_suggestions": [
      { "repo": "acme-shop-checkout", "field": "keywords", "value": "troca de seller", "reason": "termo recorrente nas issues" }
    ]
  }
}
```

`siblings` são todas as outras issues do épico, de qualquer status e responsável, usadas na busca de duplicados. `warnings` da saída são os recebidos mais os desta etapa.

## 1. Repositório e componente

- Leia o glossário (`glossary/` de todos os knowledges, ver `SKILL.md`) e case o texto da issue e das evidências com as `keywords`, `apps` e `platform` de cada repositório.
- Uma issue pode tocar mais de um repositório (ex.: app da loja + biblioteca compartilhada). Liste todos, cada um com o motivo.
- Categorias, componentes e o que conta como `platform` ou `app` vêm de `criteria/`. Sem critérios aplicáveis do time, use os padrões abaixo apenas como fallback e acrescente `criteria-missing`, mesmo que exista glossário. O fallback não define uma regra do time.
- `origin`: `platform` quando o problema está na plataforma de terceiros em que o app roda (e-commerce, pagamento, CMS); `app` quando está no código do time; `unknown` quando a evidência não basta.
- `complex: true` quando a issue toca mais de um repositório, quando `confidence` < 0.5, ou quando há um padrão recorrente com solução que não resolveu. A Átropos usa isso para decidir quantas soluções dar. Um critério do time pode mudar essa regra.

Categorias padrão (valem quando `criteria/` não define outras):

| `category` | Quando |
|---|---|
| `bug` | algo que funcionava, ou deveria funcionar, não funciona |
| `tech-debt` | funciona, mas o código ou a estrutura atrapalha mudanças futuras |
| `feature` | pede um comportamento que ainda não existe |
| `question` | pede informação, não mudança |
| `unknown` | a evidência não basta para escolher |

Sem nenhum critério nem glossário no knowledge, use `confidence` ≤ 0.3 e o aviso `criteria-missing`.

## 2. Duplicados

Procure, nesta ordem:

1. **No épico:** compare com `siblings` (todas, inclusive atribuídas e concluídas, sem limite de data).
2. **No Jira:** busque issues parecidas no mesmo projeto, incluindo as já concluídas (um duplicado resolvido também conta):

   ```
   project = <PROJ> AND key != <KEY> AND text ~ "<2 a 4 termos do sintoma>"
   AND created >= -180d ORDER BY updated DESC
   ```

   Limite a 10 resultados e leia só resumo, status e descrição dos candidatos.
3. **No Slack:** evidências que descrevem o mesmo problema citando outra chave.
4. **No aprendizado:** `learnings/patterns/` e `learnings/solutions/` com o mesmo repositório e componente.

Similaridade:

| Faixa | Quando |
|---|---|
| ≥ 0.8 | mesmo sintoma, mesmo componente e mesma plataforma |
| 0.5 a 0.79 | mesmo sintoma, mas componente ou plataforma incertos |
| < 0.5 | não liste |

Compartilhar só o componente não é duplicado.

`relation` diz se a candidata é o mesmo problema ou uma volta dele:

- `same-incident`: a candidata está aberta, ou foi resolvida depois da criação desta issue, ou as evidências dizem explicitamente que é o mesmo caso.
- `recurrence`: a candidata foi resolvida **antes** desta issue ser criada e o sintoma voltou. Não é duplicado: é sinal de que a correção anterior não bastou.
- `uncertain`: não dá para saber com as evidências disponíveis.

## 3. Agência (opcional)

`agency` diz quem gerencia a issue quando não é o time. É opcional: sem agência o valor é `null`, sem aviso, e nada muda no resto da etapa.

A resolução desta seção roda em toda execução para todas as issues coletadas, inclusive `unchanged`, antes do filtro incremental da Cloto. Resolva os repositórios pelo glossário atual (seção 1), sem depender de uma classificação em cache; substitua os avisos de agência antigos pelos atuais.

1. Se a entrada trouxe `agency` (campo do Jira lido pela Cloto), use-o.
2. Senão, olhe o campo opcional `agency` do arquivo de cada repositório de `repositories` no glossário. Se todos que têm o campo concordam, use esse valor e cite o arquivo do glossário em `sources`.
3. Se os repositórios apontam agências diferentes e a entrada não trouxe nenhuma, use `null` e acrescente o aviso `agency-ambiguous:<agência 1>,<agência 2>`. Na dúvida, a Cloto trata a issue como possivelmente gerida por agência e não comenta no Jira.

A Láquesis só informa a agência; quem oferece o repasse da solução é a Átropos.

## 4. Glossário

- A Láquesis **lê** o glossário, mas não o edita: ele é derivado do código pelo `moiras-index`. Termos novos que só aparecem nas issues, repositórios que faltam ou dados desatualizados vão em `glossary_suggestions`; a Átropos os apresenta e, com o "sim" do usuário, eles viram aprendizado (`learnings/patterns/`), não uma edição do glossário.
- Repositório citado na issue que não está no glossário gera o aviso `repo-not-in-glossary:<nome>`.

## Memória

Antes de classificar, calcule o hash da entrada (`hash`, com a entrada completa no stdin) e consulte o último registro da issue (`query lachesis --key <KEY>`).

- Mesmo hash e sem `--full`: reaproveite os campos do registro (`category`, `component`, `repositories`, `origin`, `complex`, `confidence`, `duplicates`), cite o registro como fonte (`ref` = `memory:lachesis/<KEY>@<ts>`) e acrescente o aviso `classification-reused:<ts>`. Se a Átropos precisar de detalhes que o registro não tem, classifique de novo. O `agency` não é guardado no registro: recalcule-o a cada execução (seção 3), porque ele pode mudar no Jira ou no glossário sem que a entrada da classificação mude.
- Caso contrário, classifique e registre:

```json
{
  "key": "PROJ-123",
  "run_id": "2026-10-06T11:00:00Z",
  "hash": "<hash da entrada>",
  "category": "bug",
  "component": "checkout",
  "repositories": ["acme-shop-checkout"],
  "origin": "app",
  "complex": false,
  "confidence": 0.78,
  "duplicates": ["PROJ-187"]
}
```

## Confiança

Número de 0 a 1:

| Faixa | Significado |
|---|---|
| ≥ 0.8 | critério atendido, repositório identificado e pelo menos uma fonte verificada |
| 0.5 a 0.79 | indícios fortes, mas fonte indireta ou desatualizada |
| < 0.5 | palpite; a Átropos deve pedir informação |

Toda afirmação precisa de uma fonte em `sources`.
