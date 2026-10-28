# AGENTS.md

Instruções para agentes de código (Claude Code, Codex, Copilot etc.) neste repositório.

## Sobre o projeto

**Moiras**: plugin para Claude que faz triagem de issues do Jira usando um knowledge do time.

A triagem segue três etapas, cada uma com entrada e saída verificáveis:

1. **Cloto**: coleta em paralelo das fontes configuradas e suportadas (as documentadas em `stages/clotho.md`; bloco de fonte ainda não documentada é ignorado). Das issues, as sem responsável do escopo (um ou vários épicos e categorias), por prioridade e data fim (a da própria issue; sem ela, a do épico; por último, a do projeto, que é opcional), comparando a data da issue com o teto do épico ou do projeto. Das conversas, as mensagens relevantes de pessoas e canais definidos. Hoje Jira e Slack são as fontes esperadas; outras podem ser adicionadas seguindo o padrão descrito em `stages/clotho.md`
2. **Láquesis**: identifica repositório e componente pelo glossário, classifica (categoria, origem, confiança) e avalia duplicados
3. **Átropos**: justifica o problema, decide a ação (`duplicate`, `blocked`, `ready-for-dev`, `needs-info`, `close`), sugere normalmente de 3 a 5 soluções com % de confiança e guarda a escolhida no aprendizado

O plugin fica em `plugins/moiras/` e é publicado pelo marketplace em `.claude-plugin/marketplace.json`. Jira e Slack vêm dos conectores do usuário; o plugin não traz servidor MCP.

Estrutura:

- `.claude-plugin/plugin.json`: manifesto
- `assets/logo-wordmark.svg` e `assets/logo-wordmark-dark.svg`: logo do README com o nome e os nomes das irmãs embaixo (SVG estático, só fontes de sistema; a versão escura vale para o tema escuro do GitHub, via `<picture>`)
- `assets/logo.svg`: logo do README (SVG estático, só fontes de sistema, legível em fundo claro e escuro)
- `skills/moiras-init/SKILL.md`: skill que cria o `.moiras/sources.json` conversando com o usuário (única que o cria, sem nunca sobrescrever)
- `skills/moiras-triage/SKILL.md`: skill que orquestra as três etapas, em ordem, e define como ler e escrever o knowledge; cada etapa fica em `stages/`
- `config/sources.example.json`: modelo da configuração lida de `.moiras/sources.json`
- `skills/moiras-learn/SKILL.md`: skill que importa aprendizado do histórico (issues já concluídas do Jira e, com `--from-github`, PRs mergeados e issues fechadas como resolvidas do GitHub), com o "sim" do usuário à lista exata
- `skills/moiras-teach/SKILL.md`: skill que transforma uma regra ditada pelo usuário em critério do knowledge local (gatilho, o que conferir e como), com o "sim" à lista exata
- `skills/moiras-audit/SKILL.md`: skill de auditoria do knowledge (revisão e ajustes aprovados por quem audita)
- `skills/moiras-index/SKILL.md`: skill que gera o glossário a partir do código (única que escreve em `glossary/`)
- `skills/moiras-sync/SKILL.md`: skill que traz o que foi mergeado nos knowledges compartilhados (só avança o clone)
- `skills/moiras-publish/SKILL.md`: skill que leva o knowledge local a um knowledge compartilhado, por PR
- `scripts/memory.ts`: grava e consulta a memória de cada etapa (`.moiras/memory/<stage>.jsonl`) com hash SHA-256
- `scripts/config.ts`: cria (`init`) e valida (`check`) o `.moiras/sources.json`; `init` nunca sobrescreve
- `scripts/github.ts`: repositórios do GitHub por padrão (`index.github`): `match` filtra a saída do `gh repo list` por glob, `plan-clone` diz o que já está em disco (`exists` só com o `origin` esperado, sempre sob o dono que o `match` informa), `local` lista os clones que casam com o padrão sem depender do `gh` e `clone` é o único comando que escreve (um clone novo, `https://github.com/<dono>/<nome>` com o dono do padrão, só por `https`, sem hooks nem submódulos, nunca por cima de pasta existente)
- `scripts/gitignore.ts`: leitor de `.gitignore` sem Git (casa por segmento, sem regex); usado pela busca recursiva do `hash`
- `scripts/learn-github.ts`: seleção do `moiras-learn --from-github` e da coleta automática do `moiras-sync`, sem chamar o GitHub (lê o JSON do `gh` na entrada): `eligible --repo <dono/repo>` (só PR mergeado e não revertido, com revert reconhecido em inglês e em português, e issue fechada como `COMPLETED`; a URL tem de ser do dono e do repositório; filtros por período e label; pula o que o knowledge ou a lista pendente já têm; bloqueia segredo; nunca imprime texto de PR ou issue), `auto` (só o que fechou desde a marca d'água; só monta a lista pendente), `watermark` e `pending` (estado em `.moiras/learn-github/`, fora de qualquer knowledge). A constante `autoDisposition` é o ponto único de decisão do modo automático
- `scripts/knowledge.ts`: ferramentas só de leitura para o knowledge: `hash` (fingerprint das fontes; ao percorrer pastas deixa de fora o que o `.gitignore` de cada pasta exclui; não lê o ignore global do usuário nem o `.git/info/exclude`; um `.gitignore` sem permissão de leitura interrompe o hash), `check` (regras dos registros), `issues` (chaves de issue e ids já presentes em `learnings/`), `plan` (o que o `moiras-publish` levaria) e `provenance` (commit, data do commit e estado do repositório indexado)

## Repositório público

Este repositório é público. Nada de informação da empresa nem dados sensíveis:

- Sem nomes reais de clientes, repositórios, sites, projetos do Jira, canais ou pessoas, nem URLs internas.
- Exemplos usam um universo fictício: empresa Acme, repositório `acme-shop-checkout`, issues `PROJ-123`, pessoas Fulano, Beltrana e Sicrano, canal `#proj-squad`.
- O knowledge real fica fora daqui: local em `.moiras/` (no `.gitignore`) ou em repositórios privados criados a partir do template público de knowledge.
- A regra vale também fora dos arquivos: título e corpo de PR, mensagens de commit e comentários não levam link, chave de issue nem domínio de tracker da empresa. A convenção de repositórios privados do time (link do Jira no corpo do PR) **não** vale aqui. O GitHub guarda o histórico de edição do texto, então apagar depois não basta: não escreva.

## Regras do domínio

- O plugin só lê e sugere no Jira e no Slack; nunca escreve sem aprovação humana. A única exceção são as interações opcionais da Cloto (reação no Slack, comentário curto no Jira): desligadas por padrão (`interactions.enabled`) e aplicadas depois do "sim" do usuário à lista exata. No `--auto` só a reação, se autorizada na configuração (`interactions.auto_types`, padrão reação), dispensa o "sim"; comentários sempre dependem dele e nunca vão para issue com agência.
- Cada etapa tem contrato `{input, output}`; saída fora do contrato interrompe a issue em vez de seguir adiante.
- Toda classificação sai em formato estruturado, com as fontes consultadas.
- O glossário é derivado do código (indexação). Só o `moiras-index` o escreve, no modo interativo e com o "sim" do usuário à lista exata de arquivos; a Láquesis e a auditoria não o editam: só sugerem a reindexação. A indexação só lê os repositórios (com `index.github`, lista os do GitHub por `gh repo list`, só leitura; o único acréscimo de escrita é o clone de um repositório que ainda não existe em `clone_dir`, depois do "sim" do usuário à lista exata e só pelo `github.ts clone`: nunca por cima de pasta existente, nunca `pull`/`fetch`/`checkout` num clone existente, URL sem credencial), não apaga registros e não leva cópia de código, caminho absoluto nem credencial em URL. Cada registro diz até onde o repositório foi lido (`indexed_commit`, `indexed_commit_date`, `indexed_dirty`; sem nome de branch nem de tag), só como informação: não entram no `sources_hash`, não decidem se o registro mudou (mesmo hash continua `unchanged`, e o `plan` do `moiras-publish` compara registros de glossário só pelo `sources_hash`) e a idade do glossário continua sendo a de `indexed_at`.
- Sincronização (`moiras-sync`) só traz: `git fetch` e `merge --ff-only` num clone de knowledge limpo, sem tocar no knowledge local. Publicação (`moiras-publish`) é só interativa, só com o "sim" à lista exata, sempre num branch novo e por PR: nunca push na branch principal, `force push`, merge ou aprovação, e nenhum registro sai sem passar no `knowledge.ts check`.
- Agência é opcional (`jira.agency_field` ou `agency` no glossário). Para issue com agência, a Átropos só oferece um rascunho de repasse, que o usuário envia: nada vai à agência (Jira, Slack ou outro canal) pelo plugin, e o rascunho não leva conversas internas nem dados de outros clientes.
- Auditoria (`moiras-audit`) é só interativa e só altera o knowledge local, com o "sim" de quem audita à lista exata de ajustes: mesmas regras da escrita da triagem (aprendizado só muda `result` e a observação; critério só por regeneração com `replaces`; glossário nunca é editado). O relatório da auditoria não repete conteúdo sensível.
- Regra ensinada (`moiras-teach`): só interativa, só com o "sim" à lista exata e só em `criteria/` do knowledge local, com `approved_by` pseudônimo; conflito vira critério regenerado (`replaces`) e critério equivalente não é duplicado. A regra manda conferir fontes e nunca embute dado que deve ser lido (domínio, pacote, identificador): se faltar, pergunta. Conferência ao vivo é só leitura e falha de rede é "não verificado", nunca "ausente".
- Aprendizado do histórico (`moiras-learn`): só interativo, só com o "sim" à lista exata e só em `learnings/` do knowledge local. A Cloto continua coletando só o pendente; a skill lê no Jira (só leitura) as issues concluídas do escopo, pula as que o knowledge já cita e marca o que grava com `imported_from: history`. `result: resolved` só com evidência (PR ligado ou comentário de fechamento); sem texto bruto de issue, só síntese e referência; ao tirar ou ajustar itens, padrões e decisões que dependiam deles são recalculados ou removidos e a lista revisada volta ao usuário para um novo "sim" (o `check` não detecta id de solução pendurado); `chosen_by` é o pseudônimo de quem aprovou a importação.
- Aprendizado do GitHub (`moiras-learn --from-github`): mesmas regras do histórico (só interativo, só com o "sim" à lista exata, só em `learnings/` do knowledge local, sem texto bruto, só síntese e referência) e `imported_from: github`. Só entra PR **mergeado e não revertido** e issue fechada como **resolvida** (`COMPLETED`); PR fechado sem merge, PR de revert e issue não planejada ficam de fora. Filtros por período (`--since`, `--until`) e por label; a mesma PR ou issue nunca é reaprendida (dedup pela referência `repositório#número` e pela chave do Jira que o `knowledge.ts issues` já conhece). Todo candidato passa pelo detector de segredos (item com segredo é bloqueado e só aparece pela referência; PR ou issue sobre o próprio detector de segredos pode ser barrado, e isso é intencional) e todo registro leva `reference_url` do PR ou da issue de origem (o `knowledge.ts check` recusa sem ela: `reference-url-missing`); sem chave do Jira, `issue` é `repositório#número`. A coleta automática no `moiras-sync` (`--github`) guarda uma marca d'água (último PR e última issue processados, por repositório) e **só monta uma lista pendente** (`.moiras/learn-github/`): ela nunca grava aprendizado; a gravação continua exigindo o "sim" do usuário à lista exata, em `moiras-learn --from-github --pending`. Gravar direto na coleta automática seria uma exceção a esta regra, ainda não decidida (ver `autoDisposition` em `scripts/learn-github.ts`). O plugin só lê o GitHub (`gh pr list`, `gh issue list`, `gh pr view`, `gh issue view`).
- Dois modos: interativo (padrão) e `--auto` (cron, sem perguntas, só o que mudou, relatório em `.moiras/runs/`).
- Memória das etapas só pelo script, só de acréscimo e sem conteúdo bruto (hash e metadados derivados da etapa, como ação, categoria e confiança). Ela é local e nunca vai para um knowledge.
- Configuração (`moiras-init`): só interativa, só com o "sim" ao arquivo inteiro, só pelo `config.ts init`. Cria apenas `.moiras/sources.json` e `.moiras/.gitignore`, nunca sobrescreve e recusa segredo (inclusive qualquer valor sob chave de credencial), credencial em URL, nome de repositório ou de knowledge que não seja um nome de arquivo seguro ou que se repita um `.moiras/.gitignore` existente que não cubra a pasta um `sources.json` que o Git ainda rastreia e qualquer link simbólico no caminho (pasta, ancestral, `.gitignore` ou arquivo). O `check` aplica as mesmas conferências como aviso (link simbólico, rastreado, não ignorado pelo Git) e não bloqueia a leitura. Os conectores só leem. O arquivo aceita blocos de outras fontes além de Jira e Slack, que hoje são o foco.
- Fora a memória, os relatórios, a configuração e o estado da coleta do GitHub (`.moiras/learn-github/`: marca d'água e lista pendente, sem texto de PR ou issue, local e nunca vai para um knowledge), o plugin só escreve no knowledge local (`glossary/` pelo `moiras-index`; `learnings/` pelas Moiras, pelo `moiras-learn` e pela auditoria; `criteria/` pelas Moiras, pelo `moiras-teach` e pela auditoria), no modo interativo e depois da escolha ou do "sim" do usuário. O único caminho para um knowledge compartilhado é o `moiras-publish`, por PR. Aprendizado não é apagado; só `result` e a observação mudam. Critérios conflitantes são unidos num critério regenerado (`replaces`).
- `reference_url` (opcional, só em aprendizado do tipo solução): URL de referência da solução, normalmente a PR do GitHub. Só `https`, sem credencial; o `knowledge.ts check` recusa o resto (`reference-url-invalid`) e o plugin nunca abre nem valida a URL.
- O knowledge nunca tem cópia de código: no máximo um trecho por registro, de até 20 linhas, sempre com referência (repositório, caminho, commit). Sem segredos.
- Arquivos do knowledge levam frontmatter com `indexed_at` ou `created_at`; conteúdo antigo deve ser sinalizado na saída.
- O que conta como problema de plataforma de terceiros ou do app vem dos critérios do time. Sem critérios aplicáveis, os padrões do plugin são apenas fallback, sempre sinalizado com `criteria-missing`; não são regras do time.
- Nunca commite tokens nem URLs com segredo (no `.mcp.json` inclusive).

## Idioma

O que a máquina lê é em inglês: flags, pastas, nomes de arquivo, chaves de configuração e de frontmatter, campos dos contratos e valores fixos (ex.: `action: needs-info`, `change: unchanged`, `result: resolved`). O que pessoas leem é em português: documentação, justificativas, relatórios e descrições.

Datas seguem a ISO 8601: no knowledge, só a data (`AAAA-MM-DD`, ex.: `indexed_at`, `created_at`); na coleta e na memória, data e hora com fuso, de preferência em UTC (ex.: `2026-10-06T18:00:00Z` em `run_id`, `ts`, `resolved_at`). A issue tem o seu `created_at` com hora; o do knowledge é só data.

## Ambiente

- `nix develop` (ou `direnv allow`, que usa o `.envrc` com `use flake`) entra num shell com Node LTS, TypeScript (`tsc`), Python 3 e jq, fixados pelo `flake.lock`. O shell também expõe o `@types/node` em `.direnv/types` para o `tsc` e o editor.
- Sem Nix, use `nvm use` (`.nvmrc` = `lts/*`). O Node precisa ser ≥ 22.18 (`engines` em `scripts/package.json`): antes disso os scripts falham.
- Para atualizar as versões: `nix flake update` e commite o `flake.lock`.

## Convenções

- Documentação e textos voltados ao time em português; código, identificadores e mensagens de commit em inglês.
- Worktrees do Git ficam dentro da pasta do repositório, em `.worktrees/<nome>` (por exemplo, `git worktree add .worktrees/minha-correcao -b fix/minha-correcao origin/main`), nunca em `/tmp` nem em pastas irmãs. A pasta `.worktrees/` está no `.gitignore` e deve continuar assim: nada dela vai para um commit. Em cada worktree novo, ligue o `.direnv/types` ao do checkout principal com caminho absoluto. Ao terminar, remova o worktree (`git worktree remove`) e o branch.
- Mantenha mudanças pequenas e focadas; não adicione dependências sem necessidade.
- Scripts em TypeScript executado direto pelo Node LTS mais recente (`.nvmrc` = `lts/*`; use `nvm use`), sem build: só sintaxe apagável (sem `enum`, `namespace` nem parameter properties) e imports locais com extensão `.ts`. ESM; Python 3 só quando Node não servir. Use a biblioteca padrão (`node:*` ou stdlib do Python); dependência externa só com justificativa no PR.
- Testes dos scripts com `node:test`, ao lado do script (`*.test.ts`). Antes de commitar, rode `node --test plugins/moiras/scripts/*.test.ts` e `tsc -p tsconfig.json`.
- O Node executa os `.ts`; o `tsc` (pacote TypeScript do shell Nix) serve só para checar tipos (`noEmit`). Não gere `.js`.
- Ao criar um plugin novo, siga a estrutura de `plugins/moiras/` e registre-o no `README.md`.

## Commits e PRs

- Commits em inglês, no imperativo (`Add ...`, `Fix ...`).
- PRs com título curto e descrição em português, curta: o que muda em poucos bullets e como testar.
