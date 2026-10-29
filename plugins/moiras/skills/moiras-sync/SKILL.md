---
name: moiras-sync
description: "Traz para a máquina o que foi mergeado nos repositórios de knowledge compartilhados (projeto, grupo, global), só avançando o clone local, e mostra o que chegou. Nunca envia nada. Use antes de uma triagem quando algum knowledge tiver `repository`, ou quando o usuário pedir para sincronizar (ex.: \"sincroniza o knowledge do time\", \"traz as novidades do knowledge\")."
argument-hint: "[knowledge...] [--auto] [--github <dono/repo>... [--since AAAA-MM-DD] [--label NOME]...]"
allowed-tools: Bash(node:*), Bash(gh pr list:*), Bash(gh issue list:*)
---

# Sincronização do knowledge

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Use esse caminho em toda leitura, escrita e comparação do knowledge local.

Os knowledges com `repository` no `.moiras/sources.json` são clones de repositórios git privados, criados a partir do template público de knowledge. A triagem lê esses clones direto (ver `moiras-triage/SKILL.md`, "Knowledge"), então sincronizar é deixar cada clone igual à branch padrão do repositório dele. **Só traz, nunca envia**: quem publica é o `moiras-publish`.

A skill nunca altera `<local-dir>` (escopo `local`), o Jira, o Slack nem os repositórios de código.

## Modos

| Modo | Como | Comportamento |
|---|---|---|
| Interativo (padrão) | o usuário chama a skill | pode clonar um knowledge que ainda não existe, depois do "sim"; mostra o que chegou |
| Automático | `--auto` (ex.: antes do cron da triagem) | nunca pergunta; só avança clones que já existem; salva o relatório em `<runs.dir>/sync-<sync_id>.md` |

`sync_id` = horário de início em ISO 8601 UTC. No `--auto`, o ambiente precisa permitir os comandos git abaixo (`status`, `fetch`, `merge --ff-only` e os de leitura), porque nada é perguntado.

Os argumentos limitam a execução a knowledges pelo `name`; sem nome, vale todo knowledge com `repository`.

## Passos (por knowledge)

1. **Verificar o clone.**
   - `dir` não existe: no modo interativo, pergunte e, com o "sim", rode `git clone <repository> <dir>`; no `--auto`, pule e avise.
   - `dir` existe: confira que é um repositório git e que o `origin` é o `repository` declarado (ignore `.git` no fim e a diferença entre ssh e https). Se não for, **pare** nesse knowledge e avise: a pasta pode ser de outro repositório.
2. **Garantir que o clone está limpo e na branch padrão.** `git status --porcelain` precisa vir vazio, e a branch atual precisa ser a padrão (`git symbolic-ref --short refs/remotes/origin/HEAD`, sem o prefixo `origin/`). Se houver alteração local ou outra branch (por exemplo, uma branch de `moiras-publish` ainda aberta), **pare** nesse knowledge, diga o motivo e deixe a decisão com o usuário. Nunca faça `stash`, `checkout`, `reset` nem descarte nada.
3. **Buscar.** `git fetch origin`.
4. **Conferir o histórico.** Depois do fetch, exija upstream configurado e igual a `origin/<padrão>`. Rode `git rev-list --count @{u}..HEAD`: se falhar, for inconclusivo ou maior que zero, pare e relate commits locais, inclusive divergência. Confirme também `git merge-base --is-ancestor HEAD @{u}`; falha ou resultado inconclusivo interrompe a atualização. Confira novamente que a árvore está limpa. Nunca faça `stash`, `reset`, `checkout` ou `clean`.
5. **Avançar.** `git merge --ff-only origin/<padrão>`. Se não for possível avançar (o clone tem commits locais ou divergiu), **pare** e avise. Nunca faça merge com commit, rebase, `reset` ou `pull --force`.
6. **Conferir o que chegou.** Compare o commit anterior com o novo: `git log --oneline <antes>..<depois>` e `git diff --name-status <antes> <depois>`. Agrupe por pasta (`glossary/`, `criteria/`, `learnings/`) e por ação (novo, alterado, removido). Não mostre o conteúdo dos arquivos.
7. **Validar.** Rode a checagem no clone e relate só caminho e regra:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <dir>
   ```

   Registro fora das regras (segredo, caminho pessoal, código acima de 20 linhas, sem `indexed_at`/`created_at`) é apontado, não corrigido: o clone é um espelho. Quem corrige é quem mantém o repositório de origem (por PR); o `moiras-audit` só ajusta o knowledge local.
8. **Procurar duplicados com o knowledge local.** Rode `plan` com o local e o clone; registros iguais no compartilhado (`skip` com motivo `unchanged`) foram publicados e mergeados; `skip` com motivo `shared-is-newer` é um glossário local diferente e mais antigo, e não prova publicação:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" plan --local <local-dir> --shared <dir> --shared-name <name>
   ```

   Liste-os no relatório como "já no compartilhado". A cópia local **não é apagada** por esta skill (aprendizado não se apaga); na leitura, o `local` já tem precedência sobre o compartilhado.

## Coleta do GitHub (opcional, `--github`)

Com `--github <dono/repo>...`, depois de sincronizar, a skill procura o que fechou no GitHub desde a última rodada para o `moiras-learn --from-github`. É **só uma lista pendente**: nenhum registro é criado, nem no `local` (o `<local-dir>` continua intocado). Quem grava é o `moiras-learn --from-github --pending`, com o "sim" do usuário à lista exata.

1. Leia (só leitura) os PRs (de todos os estados, como no `moiras-learn`: também os fechados sem merge e os reverts, que o seletor precisa ver) e as issues fechadas de cada repositório, com os comandos exatos abaixo. `AAAA-MM-DD` é a data da marca d'água (`learn-github.ts watermark get --state .moiras/learn-github --repo <dono/repo>`, só o dia) ou, na primeira rodada, o `--since`; `<N>` é um limite alto (sugestão 500; se a lista vier com `<N>` itens, ela pode ter sido cortada: ver "Coleta completa" abaixo). O `auto` descarta o que é anterior à marca d'água, então o dia inteiro pode ser lido sem duplicar.

   ```bash
   gh pr list --repo <dono/repo> --state all --limit <N> --search 'updated:>=AAAA-MM-DD' --json number,title,url,state,mergedAt,closedAt,headRefName,labels,body,closingIssuesReferences,files
   gh issue list --repo <dono/repo> --state closed --limit <N> --search 'closed:>=AAAA-MM-DD' --json number,title,url,state,stateReason,closedAt,labels,body
   ```

   Junte as saídas em `{ "prs": [...], "issues": [...] }` num arquivo temporário, apagado ao terminar. Os campos estão explicados em `moiras-learn/SKILL.md`, "Aprender com o GitHub".
2. Rode, por repositório (`--label` repetível filtra por label; `--since` só é exigido na primeira rodada, quando ainda não há marca d'água):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/learn-github.ts" auto --repo <dono/repo> --state .moiras/learn-github --limit <N> [--since AAAA-MM-DD] [--label <nome>]... --knowledge <local-dir> [--knowledge <dir>]... < <arquivo>
   ```

   `--limit` é **obrigatório** e tem de ser o mesmo `<N>` do `gh`. Antes de tudo, tira da lista pendente o que deixou de ser elegível (`pruned`: PR revertido por um PR novo, issue que não está mais fechada como resolvida, item já no knowledge). Depois pega só o que fechou depois da marca d'água (uma para PRs e outra para issues, **por `dono/repo`**), pula o que o knowledge já cita e o que já está pendente, bloqueia item com segredo e ignora PR não mergeado, revertido ou de revert (inclusive quando o corpo diz "This reverts #n" ou "Reverte o #n") e issue fechada como não planejada. A marca d'água só avança depois de a lista pendente ser salva: se falhar, a rodada seguinte pega os mesmos itens.
3. **Coleta completa.** Se o `gh` devolveu `<N>` PRs (ou `<N>` issues), a lista pode ter sido cortada e itens mais antigos podem faltar. O `auto` então **não avança a marca d'água** daquele tipo (`truncated` na saída) e os itens achados ficam na lista pendente. Rode de novo com um `<N>` maior até a coleta vir com menos de `<N>` itens: só uma coleta completa avança a marca. Nunca ajuste a marca d'água à mão para "pular" um corte.
4. Relate quantos itens entraram na lista pendente (`candidates`), quantos saíram da lista (`pruned`), quantos ficaram de fora e por quê (`skipped`, só referência e motivo), se houve corte (`truncated`) e sugira `/moiras:moiras-learn --from-github --pending`.

No `--auto` a coleta pergunta nada e só escreve `pending.json` e `watermark.json` em `.moiras/learn-github/` (estado local, fora de qualquer knowledge). PR ou issue que fala do próprio detector de segredos pode ser barrado como `secret` (intencional; ver `moiras-learn/SKILL.md`). Falha do `gh` (rede, permissão) é "não coletado", nunca "nada novo": a marca d'água não se mexe.

## Relatório

Por knowledge: `name`, `scope`, situação (`updated`, `unchanged`, `cloned`, `skipped`, `stopped`), commit efetivamente lido (`git rev-parse HEAD` depois da atualização, ou ao parar), commits trazidos, arquivos por pasta e ação, os achados da validação e os registros já no compartilhado. Quando parar ou pular, o motivo vem em uma frase. Sem texto bruto de issues ou conversas.

## Limites

- Só `git fetch` e `git merge --ff-only` num clone que já é do knowledge (e `git clone` de um knowledge declarado, com o "sim"). Nada de `push`, `commit`, `checkout`, `reset`, `rebase`, `stash` ou `clean`.
- O sync não cria nem altera registros em nenhum knowledge: não escreve no `local` e não altera o clone além de avançá-lo. A coleta do GitHub só escreve a lista pendente e a marca d'água em `.moiras/learn-github/`; no GitHub só lê.
- Se o knowledge declarado tem `repository` mas o usuário não quer sincronizar, a triagem funciona com o que já estiver no clone, e o conteúdo velho é sinalizado por `indexed_at` e `created_at`.
- Identificadores (campos, valores fixos) em inglês; relatórios em português.
