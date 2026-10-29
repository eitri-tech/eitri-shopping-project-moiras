---
name: moiras-learn
description: "Aprende com o histórico: lê as issues já concluídas do escopo (épicos e/ou categorias) no Jira (com os PRs e o comentário de fechamento), agrupa as recorrentes por repositório e componente e propõe registros de aprendizado (soluções já resolvidas, padrões e decisões) para o knowledge local, sempre com a lista exata aprovada pelo usuário. Use para dar partida num knowledge vazio ou ao entrar num projeto com muito histórico (ex.: \"aprende com as issues concluídas\", \"importa o histórico do épico PROJ-100 dos últimos 90 dias\"). Com `--from-git`, aprende de qualquer provedor git (GitHub e Bitbucket): PR mergeado vira solução e PR fechado sem merge, com motivo explícito no próprio PR, vira abordagem rejeitada (ex.: \"aprende com os PRs mergeados do acme-shop-checkout em outubro\"). `--from-github` continua como atalho do GitHub."
argument-hint: "[EPIC...] [--since AAAA-MM-DD] [--limit N] | --from-git [--provider github|bitbucket] <dono/repo>... [--since AAAA-MM-DD] [--until AAAA-MM-DD] [--label NOME]... | --from-github <dono/repo>... [--since AAAA-MM-DD] [--until AAAA-MM-DD] [--label NOME]... | --from-github --pending"
allowed-tools: Bash(node:*), Bash(gh pr list:*), Bash(gh issue list:*), Bash(gh pr view:*), Bash(gh issue view:*)
---

# Aprender com o histórico

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Sem `.moiras/sources.json`, ofereça `/moiras:moiras-init` e encerre.

A triagem só aprende com o que ela mesma tria. Esta skill dá a partida a frio: transforma o que o time já resolveu em registros que a Láquesis e a Átropos passam a consultar. Ela **não substitui** a Cloto nem a indexação: a Cloto continua coletando só o que está pendente, e o glossário continua vindo só do `moiras-index`.

Só roda no modo interativo: não existe `--auto`, porque todo registro depende do "sim" do usuário à lista exata. A coleta automática do GitHub (dentro do `moiras-sync`) só monta uma **lista pendente**; quem grava é esta skill, com `--from-github --pending`, depois do "sim" (ver "Aprender com o GitHub").

## O que ela lê e o que ela escreve

- **Lê** o Jira, só leitura: as issues concluídas do escopo, o comentário que fechou cada uma e os PRs ligados a ela (links do desenvolvimento ou links remotos). Segue as regras de leitura de `stages/clotho.md` (paralelo, `agency_field` opcional, falha de fonte sem inventar dados). Não lê o Slack.
- **Lê** o knowledge (glossário e critérios) para achar repositório e componente, como a Láquesis, e o `learnings/` local para não repetir o que já existe.
- **Escreve** só `learnings/{solutions,patterns,decisions}/<id>.md` no knowledge de escopo `local`, depois do "sim" (a abordagem rejeitada de um provedor git também é `learnings/decisions/`, com `outcome: rejected`). Nada em `glossary/` (só o `moiras-index`), `criteria/`, Jira, Slack ou repositórios, e nada na memória das etapas.
- O caminho para um knowledge compartilhado continua sendo o `moiras-publish`, por PR.

## Passos

1. **Período e escopo.** O escopo vem dos argumentos (um ou mais épicos, que substituem os da configuração) ou de `jira` (`epic`, `epics` e `categories`), montados como na Cloto (`stages/clotho.md`, passo 0). `--since` limita pela data de resolução; sem ele, **pergunte** o recorte (sugestão: os últimos 90 dias) e quantas issues no máximo (`--limit`, sugestão 30 por rodada). Não leia o épico inteiro sem o usuário pedir.
2. **Coletar (Cloto, só leitura).** Busque as issues concluídas do escopo, da mais recente para a mais antiga:

   ```
   <ESCOPO> AND statusCategory = Done AND resolved >= "<AAAA-MM-DD>"
   ORDER BY resolved DESC
   ```

   (`"Epic Link" in (...)` nos projetos que ainda usam o campo antigo.) Uma categoria de estado (`status`, `statusCategory`, `resolution`) pode contradizer o `statusCategory = Done` acima e a busca voltar vazia. Categoria compatível (ex.: `statusCategory` = `Done`) segue como está. Se houver contradição **ou dúvida**, **avise e pergunte** ao usuário como ajustar o recorte nesta rodada; nunca tire o filtro por conta própria, e um resultado vazio nunca é relatado em silêncio. Peça resumo, tipo, resolução, `resolved_at` e `agency` (quando configurado). Para cada issue, leia o comentário de fechamento e os PRs ligados (repositório e número). Issue sem PR **e** sem comentário de fechamento fica de fora com o motivo `no-evidence`.
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

## Aprender com qualquer provedor git (`--from-git`)

O `--from-git` lê PRs pela **camada de provedor** (`scripts/providers.ts`): GitHub (com `gh`) e Bitbucket, no mesmo formato normalizado. `--from-github <dono/repo>` é o atalho de `--from-git --provider github`, com o mesmo fluxo (dedup, revert, segredo, marca d'água e lista pendente). A seleção genérica está em `scripts/learn-git.ts`.

**Formato normalizado de cada PR** (sem texto bruto na saída): `provider`, `url` (tem de ser do dono e do repositório informados), `state` (`merged`; `closed`, fechado sem merge; `superseded`, substituído por outro PR; `open`, ainda aberto), `revert`, `closes` (issues do mesmo dono e repositório que a PR fecha; vazio no Bitbucket), `mergedAt` ou `closedAt`, e os comentários e revisões que a coleta trouxe (cada um com `author`, o login ou nickname, e `bot`). O motivo do fechamento é decidido pelo seletor, a partir desses dados.

**Regras.**
- PR **mergeado e não revertido** é **solução** (`outcome: resolved`).
- PR **fechado sem merge** ou **substituído** só vira **abordagem rejeitada** (`outcome: rejected`, nunca solução) com motivo explícito no próprio PR, que é um destes: (a) comentário ou revisão escrito até 7 dias antes do fechamento (`reason_candidates` com `kind` `comment` ou `review` e `at`); (b) outro PR que diz, no início de uma linha do título ou do corpo, "Replaces #n", "Supersedes #n" ou "Substitui o #n" (`kind: superseded`, com `superseded_by`).
- PR fechado sem merge ou substituído **sem motivo** fica de fora com `no-reason` (PR aberto fica de fora como `not-merged`). Comentário ou revisão de **bot** (login terminando em `[bot]`, tipo `Bot`, ou os logins conhecidos `copilot`, `codex`, `chatgpt-codex-connector` e `github-actions`) **não conta** como motivo, e nem um comentário que só dá comandos a um bot (cada linha começa com `@codex` ou `/`, como `@codex review` ou `/retest`). O seletor já desconsidera esses comentários.
- **Leitura dos motivos.** O seletor não escolhe um só motivo: `reason_candidates` traz **todos** os comentários e revisões humanos da janela, em ordem cronológica (o mais antigo primeiro), e, por último, o PR que substitui, se houver. Um agradecimento escrito depois do motivo real ("Obrigado!") não esconde o motivo. Leia o texto de **cada** candidato e decida se algum deles explica o fechamento. Se algum explica, ele é o motivo do registro (`reason` em uma frase sua; o texto bruto não vai para a saída, e o `reason_candidates` não é gravado). Só descarte com `no-reason` quando **nenhum** candidato explica (um "ok", um agradecimento, um aviso automático, só um pedido de revisão, uma menção sem razão). O seletor só dá a data e o autor; o conteúdo é a sua leitura. Os itens descartados entram só como referência no relatório.
- Reversão, segredo, dedup e período valem como no `--from-github`: PR de revert e item com segredo ficam de fora.

**Coleta (só leitura).**
- **GitHub**: `gh pr list --repo <dono/repo> --state all --limit <N> --search 'updated:>=AAAA-MM-DD' --json number,title,url,state,mergedAt,closedAt,headRefName,labels,body,closingIssuesReferences,files` e `gh issue list` como no passo 1 de "Aprender com o GitHub". Para cada PR **fechado sem merge** (`state` `CLOSED`), leia `gh pr view <número> --repo <dono/repo> --json comments,reviews` e junte o resultado ao item. Passe esse texto pelo `scan` antes de usar (ver "Contexto adicional e segredos").
- **Bitbucket**: o plugin **não chama** a API do Bitbucket (não há comando nem permissão para ela). O usuário entrega um arquivo JSON com a lista de PRs da API (`GET /2.0/repositories/<workspace>/<repo>/pullrequests` com `state=MERGED`, `state=DECLINED` e `state=SUPERSEDED`, todas as páginas em `values`), e, em cada PR, os `comments` que tiver (`content.raw`, `created_on`, e o `user` com `nickname` e `type`; `type` `Bot` marca bot). Datas com deslocamento (`+00:00`) são convertidas para UTC. Mapeamento: `MERGED` -> `merged`, `DECLINED` -> `closed`, `SUPERSEDED` -> `superseded`. A data de fechamento é `updated_on`. Nesta versão não há issues nem labels no Bitbucket. O formato está documentado, mas **não foi verificado contra uma conta real**.

**Seleção.** Rode, com o `dir` de **todos** os knowledges em disco:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/learn-git.ts" eligible --provider <github|bitbucket> --repo <dono/repo> [--since AAAA-MM-DD] [--until AAAA-MM-DD] [--label <nome>]... --state .moiras/learn-github --knowledge <local-dir> [--knowledge <dir>]... < <arquivo>
```

A saída tem `candidates` (com `outcome`, `reason_candidates` quando for rejeitado, e `superseded_by` quando houver) e `skipped` (referência e motivo). Ela nunca imprime texto de PR, de comentário ou de revisão. Para o aprendizado **resolvido** de um PR, o passo de síntese e de aprovação é o dos passos 3 a 6 acima. Para a **abordagem rejeitada**, o registro é o da seção "Modelos de reserva" (`learnings/decisions/`), com `outcome: rejected`, `reason` (uma frase, sem texto bruto, até 300 caracteres), `reference_url` do PR e `imported_from: git`. Solução de Bitbucket leva `imported_from: git`, e a de GitHub, `imported_from: github`. O candidato traz `key` (a identidade de dedup: a referência do GitHub, e `bitbucket:dono/repo#número` no Bitbucket) e, quando é rejeitado e o PR fecha uma issue do mesmo dono e repositório, `issue` (`dono/repo#número`). Nos registros, `issue` do registro rejeitado é esse campo, opcional: sem `issue` no candidato, o campo é omitido. Na solução (PR mergeado), o `issue` do candidato é a issue que o PR fecha, quando fecha uma, e o registro segue a regra do `issue` de "Aprender com o GitHub" (chave do Jira primeiro).

**Lista pendente.** Nesta versão só o GitHub tem lista pendente (`--from-github --pending`). O Bitbucket é aprendido direto, com o "sim" à lista exata.

## Aprender com o GitHub (`--from-github`)

Atalho de `--from-git --provider github`. Mesmo fluxo dos passos 3 a 9 acima (dedup, classificação, proposta, aprovação, gravação, conferência e relatório), trocando só a fonte: em vez das issues do Jira, os **PRs mergeados** (e os fechados sem merge, com motivo) e as **issues fechadas como resolvidas** de repositórios do GitHub. A coleta de PRs é a mesma do `--from-git --provider github` (todos os estados, com os comentários e revisões de cada PR fechado sem merge). O PR costuma ter o que a issue não tem: os arquivos alterados e a conversa da revisão.

**Fontes válidas.** PR **mergeado e não revertido** vira solução; PR fechado sem merge (ou substituído) só entra com motivo explícito no próprio PR, como abordagem rejeitada (ver "Aprender com qualquer provedor git"); issue fechada como `COMPLETED`. Ficam de fora, com o motivo: PR aberto (`not-merged`), PR fechado sem merge sem motivo (`no-reason`), PR revertido (`reverted`) e o próprio PR de revert (`is-revert`: título que começa com Revert, Reverte, Reverter, Revertendo, Desfaz ou Desfazer, ou texto, no título ou no corpo, que diga "This reverts #n", "Reverte o #n" ou "Desfaz o #n"), issue fechada como não planejada ou duplicada (`not-completed`) e issue que um PR já cobre (`covered-by-pr`, o aprendizado é o do PR; só vale a referência `closingIssuesReferences` do **mesmo dono e repositório**, a de outro repositório ou sem dono e repositório é ignorada). Só leitura: `gh pr list`, `gh issue list` e `gh pr view`/`gh issue view`; nada é comentado, rotulado nem fechado.

**Repositórios.** Os do argumento (`<dono/repo>`) ou, sem argumento, os clones que o `github.ts local` encontra para o padrão de `index.github` (o dono vem do padrão). Só entra PR ou issue cuja URL é do **dono e** do repositório informados (um fork ou outro repositório de mesmo nome é `invalid`). A referência gravada continua `repositório#número`.

**Filtros.** `--since` e `--until` (`AAAA-MM-DD`, inclusivos; filtram `mergedAt` do PR e `closedAt` da issue) e `--label` (repetível; basta uma das labels). Servem também para reprocessar um período: o que o knowledge já cita é pulado, então rodar duas vezes não duplica.

**Passos.**

1. **Coletar** (só leitura), por repositório (`<dono/repo>`), com os comandos exatos abaixo. `<N>` é um limite alto o bastante para o período (sugestão 500; se a lista vier com `<N>` itens, **avise**: pode ter sido cortada). `AAAA-MM-DD` é o `--since` (ou, sem ele, o início do recorte combinado com o usuário). **Sem `--until`** na busca: os PRs vão até hoje, porque o revert costuma vir depois do período e é preciso vê-lo para descartar o PR revertido; o `--until` é aplicado pelo `eligible`, no passo seguinte.

   ```bash
   gh pr list --repo <dono/repo> --state all --limit <N> --search 'updated:>=AAAA-MM-DD' --json number,title,url,state,mergedAt,closedAt,headRefName,labels,body,closingIssuesReferences,files
   gh issue list --repo <dono/repo> --state closed --limit <N> --search 'closed:>=AAAA-MM-DD' --json number,title,url,state,stateReason,closedAt,labels,body
   ```

   Junte as duas saídas em `{ "prs": [...], "issues": [...] }` num arquivo temporário (fora do repositório do plugin e do knowledge) e apague-o ao terminar. O `gh` falhar (rede, permissão) é "não coletado", nunca "sem resultados".
2. **Selecionar.** Rode, passando o `dir` de **todos** os knowledges em disco (como no passo 3 de "Passos"):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/learn-github.ts" eligible --repo <dono/repo> [--since AAAA-MM-DD] [--until AAAA-MM-DD] [--label <nome>]... --state .moiras/learn-github --knowledge <local-dir> [--knowledge <dir>]... < <arquivo>
   ```

   A saída tem `candidates` (referência `dono/repo#número`, `url`, `closed_at`, `jira_key` quando o título ou a branch do PR tem a chave, `closes` e `suggested_id`) e `skipped` (referência e motivo: os acima, mais `outside-period`, `label-mismatch`, `already-known`, `already-pending`, `secret` e `invalid`). Ela nunca imprime texto de PR ou de issue. **Segredo**: item com segredo em qualquer texto (título, descrição, branch, labels, arquivos, comentários) sai com `secret` e nunca vira registro; mostre-o ao usuário só pela referência.

   > **Falsos positivos do revert.** A detecção é por texto e **erra para o lado de não aprender**. "Não desfaz o #n", "não reverte o #n" e "does not reverts #n" são lidos como negação; mas um PR que cita "reverte", "desfaz" ou "reverts" seguido de um `#n` por outro motivo (por exemplo, "o que desfaz o #5 é outro PR") vira `is-revert` e o #n citado vira `reverted`, e um `#n` sem dono e repositório não se distingue de um PR do mesmo repositório. Referência qualificada (`outro/repo#5`) é ignorada. Quem precisar do item pode escrever a síntese à mão depois de conferir no GitHub.

   > **Nota.** PR ou issue que **fala do próprio detector de segredos** (por exemplo, um PR que altera o `hasSecret` ou que cita um token de exemplo no texto) pode ser barrado como `secret`. Isso é **intencional**: o detector não distingue um segredo de um exemplo dele, e é preferível perder esse aprendizado a gravar algo que pareça um segredo. Se o usuário quiser aprender com esse item, escreva a síntese à mão, sem o trecho que parece segredo, e rode o `check`; a skill não contorna o bloqueio.
3. **Pular, classificar e propor** como nos passos 3 a 5: o `issues` do `knowledge.ts` já foi aplicado pelo `--knowledge` (cobre a referência `dono/repo#número`, a chave do Jira e a referência derivada do `reference_url` dos registros, então um PR continua conhecido mesmo que a chave do Jira suma do título e da branch); a Láquesis usa o glossário e os arquivos do PR para repositório e componente; a síntese (problema, causa, solução e arquivos) é sua, em português, lida do PR (`gh pr view`, só o necessário) e nunca copiada.

   **Contexto adicional e segredos.** O que você ler além do JSON do passo 1 (comentários, revisões e conversa do PR ou da issue, com `gh pr view <número> --repo <dono/repo> --json comments,reviews,files` ou `gh issue view ... --json comments`) passa **antes de propor** pelo detector, com a saída do `gh` na entrada:

   ```bash
   gh pr view <número> --repo <dono/repo> --json comments,reviews,files | node "${CLAUDE_PLUGIN_ROOT}/scripts/learn-github.ts" scan
   gh issue view <número> --repo <dono/repo> --json comments | node "${CLAUDE_PLUGIN_ROOT}/scripts/learn-github.ts" scan
   ```

   (o primeiro para um PR, o segundo para uma issue)

   `{"secret":true}` (código de saída 1) **bloqueia o item inteiro**: nada dele é proposto nem sintetizado, o usuário o vê só pela referência (`dono/repo#número`, motivo `secret`) e ele sai da lista pendente (`pending remove`), porque seria barrado de novo. `{"secret":false}` libera a leitura; o texto lido continua sendo só insumo da síntese.
4. **Aprovar e gravar** como nos passos 6 e 7, com um registro por item:
   - `issue`, nesta ordem: a chave do Jira quando o PR a traz (`jira_key`); senão a issue que o PR fecha (`issue` do candidato, `dono/repo#número`, do mesmo dono e repositório, quando há `closes`); senão a referência `dono/repo#número` do PR (`key`). O `knowledge.ts check` aceita os três formatos (registros da primeira versão, com `repositório#número` sem dono, e com `bitbucket:dono/repo#número`, continuam válidos e contam como conhecidos). O campo guarda uma só chave: com chave do Jira, a issue fechada pelo PR não entra no `issue`, então uma abordagem rejeitada que fecha a mesma issue não casa com essa solução; a dedup dela continua pela referência do PR (`reference_url`).
   - `reference_url`: a `url` do PR ou da issue. **Obrigatória** neste modo (`reference-url-missing` no `check`): é como se audita e se remove o registro depois.
   - `imported_from: github` e, na `Observação`, "Importado do GitHub; confira antes de publicar."
   - `result: resolved` só para PR mergeado (a evidência é o merge); issue fechada sem PR ligado precisa do comentário de fechamento dizendo o que foi feito, senão não vira solução (`no-evidence`).
   - `id` e nome de arquivo: `suggested_id`.
   Depois do "sim", **tire** da lista pendente o que foi gravado ou descartado: `learn-github.ts pending remove --state .moiras/learn-github --ref <ref>...`.
5. **Conferir e relatar** como nos passos 8 e 9. O `check` roda sobre o que foi gravado; registro que falhar não é entregue.

**Onde fica.** Só `learnings/` do knowledge `local`, fora do repositório do plugin. A lista pendente e a marca d'água ficam em `.moiras/learn-github/` (`pending.json` e `watermark.json`), estado da máquina que nunca vai para um knowledge nem para um PR.

### Lista pendente da coleta automática

O `moiras-sync` (`--auto`, ou o interativo, depois da sincronização) roda `learn-github.ts auto`: primeiro **tira da lista pendente** o que deixou de ser elegível (PR que um PR novo reverteu, mesmo que o original nem venha na coleta, issue que não está mais fechada como resolvida, item que o knowledge já cita ou que passou a ter segredo) e depois pega só o que fechou **desde a rodada anterior** (marca d'água por `dono/repo`, uma para PRs e outra para issues), aplica as mesmas regras e filtros e **só acrescenta à lista pendente**. A marca d'água é por `dono/repo`: marcas da versão anterior (só o nome do repositório) não são lidas, e a primeira rodada de cada repositório pede `--since` de novo. Não grava nenhum registro: a regra de que o `moiras-learn` só escreve com o "sim" do usuário à lista exata continua valendo.

Com `--from-github --pending`, esta skill **revalida a elegibilidade antes de propor**: um item entrou na lista no passado e o PR pode ter sido revertido depois.

1. `learn-github.ts pending list --state .moiras/learn-github` e, por repositório, a data (`closed_at`) do item mais antigo.
2. Colete de novo com os comandos do passo 1 de "Passos" (`--search 'updated:>=<essa data>'` para PRs e `'closed:>=<essa data>'` para issues), para ver também os reverts que vieram depois.
3. Rode `learn-github.ts revalidate --repo <dono/repo> --state .moiras/learn-github --knowledge <local-dir> [--knowledge <dir>]... < <arquivo>`. A saída tem `valid` (pode propor), `removed` (já saiu da lista, com o motivo: `reverted`, `is-revert`, `not-completed`, `already-known`, `secret`...) e `unverified` (a coleta não mostrou o item: **não proponha**; refaça com data mais antiga ou `--limit` maior). Mostre ao usuário o que saiu da lista e por quê, só pela referência.
4. Só o que está em `valid` segue: releia no GitHub cada item (síntese, arquivos), passe o contexto pelo `scan` (ver "Contexto adicional e segredos") e siga pelos passos de 3 a 5 acima, com a aprovação do usuário à lista exata. A lista pendente nunca tem texto de PR ou de issue: só referência, URL, data e chave do Jira.

> **Ponto de decisão.** A escolha de a coleta automática só montar a lista é única e está marcada em `autoDisposition`, em `scripts/learn-github.ts`. Gravar direto, sem o "sim", seria outra decisão: exigiria mudar essa constante, o ramo correspondente do `auto`, esta seção e a regra do `AGENTS.md`. Não está implementado.

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

Abordagem rejeitada (`--from-git`), em `learnings/decisions/acme-shop-checkout-pr-5.md`. Este é o formato fixo: sem `source`, com `outcome`, `reason`, `reference_url` e `imported_from: git`.

```markdown
---
id: acme-shop-checkout-pr-5
type: decision
created_at: 2026-01-15
chosen_by: reviewer-01
outcome: rejected
reason: Guardar a lista de sellers em cache quebra a troca de seller.
reference_url: https://github.com/acme/acme-shop-checkout/pull/5
imported_from: git
---

# Não guardar a lista de sellers em cache

**Decisão:** a lista de sellers é buscada a cada troca, sem cache no cliente.

**Por quê:** a PR foi fechada sem merge; o cache mantinha um seller antigo depois da troca.
```

Campo opcional `issue` (só na abordagem rejeitada de GitHub, quando o PR fecha uma issue do mesmo dono e repositório): `issue: acme/acme-shop-checkout#3`, no formato `dono/repo#número`, ou a chave do Jira (`ABC-123`). Sem issue fechada pelo PR, o campo é omitido. O `knowledge.ts check` confere o formato.

## O que vai em cada registro

- Siga o modelo do tipo em `_templates/` ou, sem ele, nos "Modelos de reserva". O corpo é uma **síntese curta em português**, escrita por você; nunca cole título, descrição, comentário ou mensagem da issue.
- `Fontes` leva a chave da issue e o PR (`repositório#número`; no modo `--from-git` ou `--from-github`, a referência `dono/repo#número` do PR ou da issue de origem) e, se ajudar, `caminho@commit`; nunca URL interna nem cópia de código (no máximo um trecho de 20 linhas, com referência). A abordagem rejeitada não tem `Fontes` no corpo: a fonte é o `reference_url` e a síntese é o campo `reason`.
- `agency` do registro segue a seção 3 de `stages/lachesis.md`: o campo configurado (`jira.agency_field`) e, sem ele, o `agency` do glossário quando todos os repositórios concordam; ambíguo ou vazio fica `null`. De issue de agência ficam a síntese técnica e a chave; nada da conversa com a agência nem de outros clientes.
- `confidence` reflete a evidência: PR mergeado e ligado, mais alta; só o comentário de fechamento, mais baixa. Sem critérios aplicáveis, vale o limite do fallback e o aviso `criteria-missing`.
- Datas dos registros em `AAAA-MM-DD`.

## Limites

- Só leitura no Jira, no Slack e nos provedores git (GitHub e Bitbucket); nunca comenta, transiciona, rotula, fecha nem reage.
- `result: resolved` só com evidência; na dúvida, a issue fica de fora.
- Nada de nomes reais de pessoas, e-mails, identificadores de conta, segredos nem texto bruto de issue ou conversa.
- Não apaga nem reescreve registros; não edita o glossário nem os critérios.
- Conteúdo antigo é sinalizado: aprendizado com `created_at` de mais de 6 meses é velho para a triagem, e o histórico importado tem a data da importação, não a da issue.
- Identificadores (campos, valores fixos, pastas) em inglês; descrições e relatórios em português.
