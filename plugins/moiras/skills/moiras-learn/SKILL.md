---
name: moiras-learn
description: "Aprende com o histórico: lê as issues já concluídas do épico no Jira (com os PRs e o comentário de fechamento), agrupa as recorrentes por repositório e componente e propõe registros de aprendizado (soluções já resolvidas, padrões e decisões) para o knowledge local, sempre com a lista exata aprovada pelo usuário. Use para dar partida num knowledge vazio ou ao entrar num projeto com muito histórico (ex.: \"aprende com as issues concluídas\", \"importa o histórico do épico PROJ-100 dos últimos 90 dias\")."
argument-hint: "[EPIC] [--since AAAA-MM-DD] [--limit N]"
allowed-tools: Bash(node:*)
---

# Aprender com o histórico

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Sem `.moiras/sources.json`, ofereça `/moiras:moiras-init` e encerre.

A triagem só aprende com o que ela mesma tria. Esta skill dá a partida a frio: transforma o que o time já resolveu em registros que a Láquesis e a Átropos passam a consultar. Ela **não substitui** a Cloto nem a indexação: a Cloto continua coletando só o que está pendente, e o glossário continua vindo só do `moiras-index`.

Só roda no modo interativo: não existe `--auto`, porque todo registro depende do "sim" do usuário à lista exata.

## O que ela lê e o que ela escreve

- **Lê** o Jira, só leitura: as issues concluídas do épico, o comentário que fechou cada uma e os PRs ligados a ela (links do desenvolvimento ou links remotos). Segue as regras de leitura de `stages/clotho.md` (paralelo, `agency_field` opcional, falha de fonte sem inventar dados). Não lê o Slack.
- **Lê** o knowledge (glossário e critérios) para achar repositório e componente, como a Láquesis, e o `learnings/` local para não repetir o que já existe.
- **Escreve** só `learnings/{solutions,patterns,decisions}/<id>.md` no knowledge de escopo `local`, depois do "sim". Nada em `glossary/` (só o `moiras-index`), `criteria/`, Jira, Slack ou repositórios, e nada na memória das etapas.
- O caminho para um knowledge compartilhado continua sendo o `moiras-publish`, por PR.

## Passos

1. **Período e épico.** O épico vem do argumento ou de `jira.epic`. `--since` limita pela data de resolução; sem ele, **pergunte** o recorte (sugestão: os últimos 90 dias) e quantas issues no máximo (`--limit`, sugestão 30 por rodada). Não leia o épico inteiro sem o usuário pedir.
2. **Coletar (Cloto, só leitura).** Busque as issues concluídas do épico, da mais recente para a mais antiga:

   ```
   parent = <EPIC> AND statusCategory = Done AND resolved >= "<AAAA-MM-DD>"
   ORDER BY resolved DESC
   ```

   (`"Epic Link" = <EPIC>` nos projetos que ainda usam o campo antigo.) Peça resumo, tipo, resolução, `resolved_at` e `agency` (quando configurado). Para cada issue, leia o comentário de fechamento e os PRs ligados (repositório e número). Issue sem PR **e** sem comentário de fechamento fica de fora com o motivo `no-evidence`.
3. **Pular o que o knowledge já cobre.** Rode:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" issues <local-dir> <dir-do-knowledge-compartilhado>...
   ```

   Passe o `dir` de **todos** os knowledges de `knowledge` (o local e os compartilhados que existam em disco). A saída tem `issues` (chave → ids de soluções e padrões que a citam, só de registros que passam no `check`) e `ids` (todo id e nome de arquivo em uso). Issue já citada vira `already-known` e não entra na proposta; os `ids` evitam colisão de identificador e de caminho, também com o que já existe nos compartilhados. Registro inválido não cobre a issue: rode `moiras-audit` para ele.
4. **Classificar (Láquesis).** Para cada issue restante, identifique repositório e componente pelo glossário (`knowledge:<name>/glossary/<repo>.md`) e pela referência do PR; categoria e confiança seguem `stages/lachesis.md`, inclusive `criteria-missing` e o limite de `confidence` sem critérios. Repositório que não está no glossário fica sem repositório e a issue sai da proposta (`repository-unknown`), com a sugestão de rodar `moiras-index`: não invente.
5. **Propor (Átropos, adaptada).** Agrupe por repositório e componente e monte a lista numerada:
   - **Solução** (`learnings/solutions/<KEY>-<n>.md`): uma por issue, com `result: resolved` **somente** com evidência de que a correção foi entregue (PR mergeado e ligado, ou comentário de fechamento que diga o que foi feito). Sem isso, a issue não vira solução.
   - **Padrão** (`learnings/patterns/<id>.md`): problema que se repete em **duas ou mais** issues do grupo; `issues` lista todas, e `Soluções que funcionaram` aponta os ids das soluções.
   - **Decisão** (`learnings/decisions/<id>.md`): só quando duas ou mais soluções resolveram do mesmo jeito (`source` com os ids delas).
   Cada item mostra: tipo, id, caminho, repositório, componente, categoria, confiança, evidência (chave da issue e `PR` como `repositório#número`) e a síntese em uma frase. Mostre também as que ficaram de fora (`no-evidence`, `already-known`, `repository-unknown`, `agency`) para o usuário conferir.
6. **Aprovar.** O usuário diz "sim" à lista exata, ou tira e ajusta itens. Peça um pseudônimo (`reviewer-01`, `user-7`; ver "Regras de escrita" em `moiras-triage/SKILL.md`) para `chosen_by`: é quem aprovou a importação, **não** quem corrigiu a issue. Item que surgir depois precisa de novo "sim".
7. **Gravar** só o aprovado, usando os modelos `_templates/` do knowledge, e marcar cada registro com `imported_from: history` no frontmatter e, na `Observação`, a frase "Importado do histórico; confira antes de publicar." `created_at` é a data de hoje. Um arquivo por registro, nunca sobrescreve um existente.
8. **Conferir** e corrigir o que falhar:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <local-dir> --only learnings
   ```

9. **Relatar**, sem texto de issue: quantos registros por tipo, o que ficou de fora e por quê, os avisos (`criteria-missing`, `knowledge-stale`) e a sugestão de `moiras-audit learnings` e, se o knowledge tem `repository`, de `moiras-publish`.

## O que vai em cada registro

- Siga o modelo do tipo em `_templates/`. O corpo é uma **síntese curta em português**, escrita por você; nunca cole título, descrição, comentário ou mensagem da issue.
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
