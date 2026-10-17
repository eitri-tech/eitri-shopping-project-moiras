---
name: moiras-learn
description: "Aprende com o histórico: lê as issues já concluídas do escopo (épicos e categorias, ou uma consulta) no Jira (com os PRs e o comentário de fechamento), agrupa as recorrentes por repositório e componente e propõe registros de aprendizado (soluções já resolvidas, padrões e decisões) para o knowledge local, sempre com a lista exata aprovada pelo usuário. Use para dar partida num knowledge vazio ou ao entrar num projeto com muito histórico (ex.: \"aprende com as issues concluídas\", \"importa o histórico do épico PROJ-100 dos últimos 90 dias\")."
argument-hint: "[EPIC...] [--since AAAA-MM-DD] [--limit N]"
allowed-tools: Bash(node:*)
---

# Aprender com o histórico

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Sem `.moiras/sources.json`, ofereça `/moiras:moiras-init` e encerre.

A triagem só aprende com o que ela mesma tria. Esta skill dá a partida a frio: transforma o que o time já resolveu em registros que a Láquesis e a Átropos passam a consultar. Ela **não substitui** a Cloto nem a indexação: a Cloto continua coletando só o que está pendente, e o glossário continua vindo só do `moiras-index`.

Só roda no modo interativo: não existe `--auto`, porque todo registro depende do "sim" do usuário à lista exata.

## O que ela lê e o que ela escreve

- **Lê** o Jira, só leitura: as issues concluídas do escopo, o comentário que fechou cada uma e os PRs ligados a ela (links do desenvolvimento ou links remotos). Segue as regras de leitura de `stages/clotho.md` (paralelo, `agency_field` opcional, falha de fonte sem inventar dados). Não lê o Slack.
- **Lê** o knowledge (glossário e critérios) para achar repositório e componente, como a Láquesis, e o `learnings/` local para não repetir o que já existe.
- **Escreve** só `learnings/{solutions,patterns,decisions}/<id>.md` no knowledge de escopo `local`, depois do "sim". Nada em `glossary/` (só o `moiras-index`), `criteria/`, Jira, Slack ou repositórios, e nada na memória das etapas.
- O caminho para um knowledge compartilhado continua sendo o `moiras-publish`, por PR.

## Passos

1. **Período e escopo.** O escopo vem dos argumentos (um ou mais épicos, que substituem os da configuração) ou de `jira` (`epic`, `epics` e `categories`, ou então só `jql`), montados como na Cloto (`stages/clotho.md`, passo 0). `--since` limita pela data de resolução; sem ele, **pergunte** o recorte (sugestão: os últimos 90 dias) e quantas issues no máximo (`--limit`, sugestão 30 por rodada). Não leia o épico inteiro sem o usuário pedir.
2. **Coletar (Cloto, só leitura).** Busque as issues concluídas do escopo, da mais recente para a mais antiga:

   ```
   <ESCOPO> AND statusCategory = Done AND resolved >= "<AAAA-MM-DD>"
   ORDER BY resolved DESC
   ```

   (`"Epic Link" in (...)` nos projetos que ainda usam o campo antigo.) Com `jira.jql`, a consulta entra como veio, então um filtro de estado dela (`status`, `statusCategory`, `resolution`) contradiz o `statusCategory = Done` acima e a busca volta vazia. Se a `jira.jql` tiver um filtro assim, **avise e peça** ao usuário uma consulta de histórico para esta rodada (a mesma sem o filtro de estado); nunca tire o filtro por conta própria, e um resultado vazio nunca é relatado em silêncio. Peça resumo, tipo, resolução, `resolved_at` e `agency` (quando configurado). Para cada issue, leia o comentário de fechamento e os PRs ligados (repositório e número). Issue sem PR **e** sem comentário de fechamento fica de fora com o motivo `no-evidence`.
3. **Pular o que o knowledge já cobre.** Rode:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" issues <local-dir> <dir-do-knowledge-compartilhado>...
   ```

   Passe o `dir` de **todos** os knowledges de `knowledge` (o local e os compartilhados que existam em disco). A saída tem `issues` (chave → ids de soluções e padrões que a citam, só de registros que passam no `check`) e `ids` (todo id e nome de arquivo em uso). Issue já citada vira `already-known` e não entra na proposta; os `ids` evitam colisão de identificador e de caminho, também com o que já existe nos compartilhados. Registro inválido não cobre a issue: rode `moiras-audit` para ele. Se o comando falhar (por exemplo, uma pasta de `learnings/` que é link simbólico ou não é diretório), **pare**: um índice parcial reimportaria issues ou repetiria ids. Relate o erro e peça ao usuário para corrigir o knowledge.
4. **Classificar (Láquesis).** Para cada issue restante, identifique repositório e componente pelo glossário (`knowledge:<name>/glossary/<repo>.md`) e pela referência do PR; categoria e confiança seguem `stages/lachesis.md`, inclusive `criteria-missing` e o limite de `confidence` sem critérios. Repositório que não está no glossário fica sem repositório e a issue sai da proposta (`repository-unknown`), com a sugestão de rodar `moiras-index`: não invente.
5. **Propor (Átropos, adaptada).** Agrupe por repositório e componente e monte a lista numerada:
   - **Solução** (`learnings/solutions/<KEY>-<n>.md`): uma por issue, com `result: resolved` **somente** com evidência de que a correção foi entregue (PR mergeado e ligado, ou comentário de fechamento que diga o que foi feito). Sem isso, a issue não vira solução.
   - **Padrão** (`learnings/patterns/<id>.md`): problema que se repete em **duas ou mais** issues do grupo; `issues` lista todas, e `Soluções que funcionaram` aponta os ids das soluções.
   - **Decisão** (`learnings/decisions/<id>.md`): só quando duas ou mais soluções resolveram do mesmo jeito (`source` com os ids delas).
   Antes de propor um **padrão** ou uma **decisão**, leia os de `learnings/patterns/` e `learnings/decisions/` de **todos** os knowledges configurados (o `issues` só devolve chaves e ids, não o conteúdo): título, `repositories`, `component` e sintoma/decisão, só de registros que passam no `check`. Se já existir um equivalente, com outras chaves de issue, **não proponha um novo**: cite a referência existente (`knowledge:<name>/learnings/...`) no relatório e use-a em `Soluções que funcionaram` ou em `source` dos registros novos. Não reescreva o registro existente.
   Cada item mostra: tipo, id, caminho, repositório, componente, categoria, confiança, evidência (chave da issue e `PR` como `repositório#número`) e a síntese em uma frase. Issue de agência entra normalmente, com o registro técnico descrito em "O que vai em cada registro". Mostre também as que ficaram de fora (`no-evidence`, `already-known`, `repository-unknown`) para o usuário conferir.
6. **Aprovar.** O usuário diz "sim" à lista exata, ou tira e ajusta itens. Peça um pseudônimo (`reviewer-01`, `user-7`; ver "Regras de escrita" em `moiras-triage/SKILL.md`) para `chosen_by`: é quem aprovou a importação, **não** quem corrigiu a issue. Item que surgir depois precisa de novo "sim".

   Ao tirar ou ajustar itens, **recalcule o que depende deles** antes de gravar: padrão que cite a issue ou o id de uma solução removida (em `issues` ou em `Soluções que funcionaram`) e decisão cujo `source` cite esse id. Solução ajustada também obriga a rever a síntese, o agrupamento e as evidências dos dependentes. Padrão que ficar com menos de duas issues e decisão que ficar com menos de duas soluções saem da lista; nos que sobrarem, as referências citam só ids que serão gravados (ou que já existem no knowledge). Depois peça um **novo "sim" à lista revisada**: só o que ela traz é gravado.
7. **Gravar** só o aprovado, usando os modelos `_templates/` do knowledge (sem `_templates/`, como num knowledge recém-criado, os "Modelos de reserva" abaixo), e marcar cada registro com `imported_from: history` no frontmatter e, na `Observação` da solução (padrão e decisão não têm esse campo; neles vale o `imported_from`), a frase "Importado do histórico; confira antes de publicar." `created_at` é a data de hoje. Um arquivo por registro, nunca sobrescreve um existente.
8. **Conferir** e corrigir o que falhar. O `check` não confere se os ids citados em `source`, `issues` e `Soluções que funcionaram` existem: ele **não** pega referência pendurada, então confira por conta própria que todo id citado por padrão e decisão foi gravado (ou já existe) antes de relatar. Correção que mude o conteúdo de um registro volta ao usuário para um novo "sim":

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <local-dir> --only learnings
   ```

9. **Relatar**, sem texto de issue: quantos registros por tipo, o que ficou de fora e por quê, os avisos (`criteria-missing`, `knowledge-stale`) e a sugestão de `moiras-audit learnings` e, se o knowledge tem `repository`, de `moiras-publish`.

## Modelos de reserva

Use o `_templates/` do knowledge quando existir; senão, estes modelos, com os mesmos campos e corpo. Os valores abaixo são fictícios: troque todos pelos dados reais (a data é a de hoje, no formato `AAAA-MM-DD`). O `confidence` da solução é um inteiro de 0 a 100.

Solução, em `learnings/solutions/PROJ-123-1.md`:

```markdown
---
id: PROJ-123-1
type: solution
issue: PROJ-123
created_at: 2026-01-15
chosen_by: reviewer-01
agency:
repositories: [acme-shop-checkout]
component: checkout
category: bug
confidence: 70
result: resolved
imported_from: history
---

# Manter o orderFormId na troca de seller

**Problema:** o carrinho é recriado quando o usuário troca de seller.

**Causa provável:** o orderForm antigo é descartado em vez de atualizado.

**Solução:** reaproveitar o `orderFormId` ao trocar de seller.

**Riscos:** itens de sellers diferentes no mesmo carrinho.

**Alternativas descartadas:** recriar o carrinho e reaplicar os itens (45).

**Fontes:** PROJ-123, `acme-shop-checkout#42`.

**Observação:** Importado do histórico; confira antes de publicar.
```

Padrão, em `learnings/patterns/cart-loses-items-seller-switch.md`:

```markdown
---
id: cart-loses-items-seller-switch
type: pattern
created_at: 2026-01-15
repositories: [acme-shop-checkout]
component: checkout
issues: [PROJ-123, PROJ-187]
imported_from: history
---

# Carrinho perde itens ao trocar de seller

**Sintoma:** itens somem do carrinho depois da troca de seller.

**Onde olhar:** `acme-shop-checkout/src/views/checkout/`.

**Soluções que funcionaram:** PROJ-123-1, PROJ-187-1.
```

Decisão, em `learnings/decisions/single-orderform-per-session.md`:

```markdown
---
id: single-orderform-per-session
type: decision
created_at: 2026-01-15
source: [PROJ-123-1, PROJ-187-1]
imported_from: history
---

# Um orderForm por sessão

**Decisão:** o app mantém um único `orderFormId` por sessão, mesmo trocando de seller.

**Por quê:** as soluções PROJ-123-1 e PROJ-187-1 resolveram o mesmo problema assim.
```

## O que vai em cada registro

- Siga o modelo do tipo em `_templates/` ou, sem ele, nos "Modelos de reserva". O corpo é uma **síntese curta em português**, escrita por você; nunca cole título, descrição, comentário ou mensagem da issue.
- `Fontes` leva a chave da issue e o PR (`repositório#número`) e, se ajudar, `caminho@commit`; nunca URL interna nem cópia de código (no máximo um trecho de 20 linhas, com referência).
- `agency` do registro segue a seção 3 de `stages/lachesis.md`: o campo configurado (`jira.agency_field`) e, sem ele, o `agency` do glossário quando todos os repositórios concordam; ambíguo ou vazio fica `null`. De issue de agência ficam a síntese técnica e a chave; nada da conversa com a agência nem de outros clientes.
- `confidence` reflete a evidência: PR mergeado e ligado, mais alta; só o comentário de fechamento, mais baixa. Sem critérios aplicáveis, vale o limite do fallback e o aviso `criteria-missing`.
- Datas dos registros em `AAAA-MM-DD`.

## Limites

- Só leitura no Jira e no Slack; nunca comenta, transiciona nem reage.
- `result: resolved` só com evidência; na dúvida, a issue fica de fora.
- Nada de nomes reais de pessoas, e-mails, identificadores de conta, segredos nem texto bruto de issue ou conversa.
- Não apaga nem reescreve registros; não edita o glossário nem os critérios.
- Conteúdo antigo é sinalizado: aprendizado com `created_at` de mais de 6 meses é velho para a triagem, e o histórico importado tem a data da importação, não a da issue.
- Identificadores (campos, valores fixos, pastas) em inglês; descrições e relatórios em português.
