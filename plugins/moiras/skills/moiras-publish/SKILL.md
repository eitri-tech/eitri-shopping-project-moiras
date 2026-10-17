---
name: moiras-publish
description: "Leva o que é novo no knowledge local (glossário, critérios e aprendizado) para um repositório de knowledge compartilhado, abrindo um pull request. Confere as regras do knowledge antes, mostra a lista exata de arquivos e só publica com o \"sim\" do usuário. Nunca faz push na branch principal nem merge. Use quando o usuário quiser compartilhar o que aprendeu (ex.: \"publica o aprendizado no knowledge do time\")."
argument-hint: "<knowledge>"
allowed-tools: Bash(node:*)
---

# Publicação do knowledge

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Use esse caminho em toda leitura, escrita e comparação do knowledge local.

O argumento é o `name` de um knowledge com `repository` no `.moiras/sources.json` (o destino). Sem argumento, ou com um nome que não tem `repository`, liste os possíveis e pergunte. A skill só roda no modo interativo: não existe `--auto`, porque publicar depende do "sim" do usuário à lista exata.

Ela copia do knowledge `local` (`<local-dir>`) para um clone do destino, num branch novo, e abre um PR. Quem faz o merge são as pessoas que revisam o repositório; a skill nunca o faz.

## Antes de começar

1. **Sincronizar.** O clone do destino (`dir`) precisa estar limpo, na branch padrão e igual à `origin`. Se não estiver, peça para rodar o `moiras-sync` e pare: não tente consertar o clone.
2. **Conferir a identidade do destino.** Leia o `origin` do clone com `git -C <dir> remote get-url origin` e compare com o `repository` configurado, normalizando SSH/HTTPS e o sufixo `.git` para `owner/name` no mesmo host. Diferença, URL ambígua ou leitura inconclusiva interrompe a publicação.
3. **Conferir a visibilidade.** Rode `gh repo view <host>/<owner>/<name> --json visibility,isPrivate`, com o host normalizado do `repository` configurado (nunca o host padrão ou o `GH_HOST` do ambiente, que podem apontar para outro servidor). Exija `visibility: PRIVATE` e `isPrivate: true`; destino público, desconhecido, respostas inconsistentes, falta de `gh`, autenticação ou permissão interrompem a publicação. Knowledge real só vai para repositório privado.
4. **Planejar.** Compare o local com o destino:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" plan --local <local-dir> --shared <dir> --shared-name <name>
   ```

5. **Validar a seleção.** Depois de escolher os itens e antes de pedir o "sim", monte uma pasta temporária só com os arquivos exatos a copiar, preservando os caminhos relativos, e rode `node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <seleção>`. Erros (`error`) interrompem a publicação; avisos (`warning`) não bloqueiam, mas entram na lista marcados e o usuário os vê antes do "sim". Falha ou resultado inconclusivo também interrompe. Registro com erro (segredo, credencial em URL, caminho absoluto, código acima de 20 linhas ou sem referência — em bloco com ``` ou ~~~, indentado, ou dentro de citação ou lista —, campo obrigatório do tipo faltando, data que não existe no calendário, modelo não preenchido no cabeçalho ou no texto) **não entra** na lista: aponte só caminho e regra, sem repetir conteúdo, e deixe a correção com o usuário ou com o `moiras-audit`. Avisos (`warning`) entram na lista, marcados. `chosen_by` e `approved_by` devem ser pseudônimos não identificáveis: recuse e-mail (também sinalizado pelo `check`), nome real aparente ou identificador de conta, mesmo que o script não detecte. Dúvida exige correção antes de publicar.

## O que o plano significa

| Ação | Quando | O que a skill faz |
|---|---|---|
| `add` | o registro não existe no destino | oferece para publicar |
| `update` | solução com a mesma `id` que só avançou em `result` ou na observação (a observação do destino é mantida e o resultado final do destino não é trocado); ou glossário com `indexed_at` mais novo e `sources_hash` diferente | oferece para publicar, mostrando o que mudou |
| `skip` | já é igual, ou o destino tem o glossário igual ou mais novo, ou o glossário tem o mesmo `sources_hash` e conteúdo e só difere em `indexed_at`, commit, data do commit ou `indexed_dirty` | não faz nada |
| `conflict` | a mesma `id` com conteúdo diferente em aprendizado (só acréscimo) ou critério (só muda por regeneração); ou solução cuja cópia local está velha (o destino já tem um resultado final diferente do local, ou a observação do destino não foi mantida); ou glossário reindexado no mesmo dia (`indexed_at` igual e conteúdo diferente) | **não publica**; explica ao usuário e sugere um critério novo com `replaces`, ou um `id` novo |
| `remove` | critério do destino que um critério novo do local substitui (`replaces`) | oferece a remoção **no mesmo PR**, junto com o critério novo |

`replaces` é uma lista (`replaces: [id]`); cada item é um ID simples ou `knowledge:<name>/<path>`. Um texto simples fora de lista não é lido. Resolva a referência no knowledge indicado; só ofereça remoção de critério do destino escolhido, nunca de outro knowledge.

A skill nunca reescreve um aprendizado do destino além de `result` e da observação, e nunca edita um critério do destino: o critério muda por regeneração. Trocar um resultado final já publicado, ou escolher entre dois glossários do mesmo dia, é decisão de quem revisa o repositório compartilhado, num PR feito à mão: a skill só aponta o conflito.

## Passos

1. **Mostrar.** Apresente a lista numerada com caminho, ação e motivo, e quantos avisos cada item tem. Não mostre o conteúdo; se o usuário pedir para ver um arquivo, mostre o diff dele.
2. **Decidir e validar.** O usuário escolhe quais itens entram; valide a seleção conforme "Antes de começar", passo 5. Um critério com `replaces` e as remoções que ele causa entram ou saem **juntos**.
3. **Confirmar.** Mostre o destino (`owner/name` e visibilidade privada confirmada) junto da lista exata (arquivos copiados e arquivos removidos) e peça o "sim". Item que surgir depois precisa de novo "sim".
4. **Preparar o branch.** Num `git worktree` temporário, para não mexer no clone que a triagem lê:

   ```bash
   git -C <dir> worktree add "$PWD/.moiras/tmp/publish-<publish_id>" -b <branch> origin/<padrão>
   ```

   `publish_id` = horário de início em ISO 8601 UTC, sem `:`. O branch **nunca** pode ser a branch padrão, `main` nem `master`. Use `<branch>` = `moiras/index-<YYYY-MM-DD>`; se já existir localmente ou no remoto, acrescente `-2`, `-3`… até obter um nome livre. Confira PRs abertos desses branches e avise para não duplicar a publicação. Mantenha `publish_id` na descrição do PR e no relatório.
5. **Copiar e remover.** Copie da seleção validada só os arquivos aprovados, mantendo o caminho relativo, e apague só os aprovados para remoção. Rode `check` no worktree (`"$PWD/.moiras/tmp/publish-<publish_id>"`) e pare se aparecer erro ou o resultado for inconclusivo (avisos já aprovados na lista não bloqueiam).
6. **Commitar.** `git add` com os caminhos exatos (nunca `-A` nem `.`) e um commit em inglês, no imperativo (ex.: `Add Moiras criteria and learnings from triage`). A autoria é a identidade git de quem está rodando.
7. **Enviar.** Imediatamente antes do push, repita, nesta ordem, a comparação de `origin` com `repository` e a consulta de visibilidade dos passos 2 e 3, agora no worktree temporário. Qualquer falha, diferença ou resultado inconclusivo interrompe o envio. Só então rode `git push -u origin <branch>`. Nunca use `--force`.
8. **Abrir o PR** na branch padrão, com o `gh pr create --base <padrão> --head <branch>` se o `gh` estiver instalado e autenticado. Se o `gh` ficar indisponível, pare e explique. Siga o modelo de PR do repositório, se houver. Título curto; descrição em português, curta:
   - o que muda, em bullets por pasta (`criteria/`, `learnings/`, `glossary/`) e por ação (novo, atualizado, removido), citando só os `id`;
   - como revisar (rodar `knowledge.ts check` no branch).

   A descrição **não leva** texto de issue, de conversa, nome de cliente nem o conteúdo dos registros.
9. **Limpar.** Remova o worktree temporário (`git -C <dir> worktree remove "$PWD/.moiras/tmp/publish-<publish_id>"`). O branch fica no clone e no remoto até o PR ser mergeado ou fechado.
10. **Registrar.** Salve o relatório em `<runs.dir>/publish-<publish_id>.md`: destino, itens publicados, pulados e em conflito, remoções, o endereço do PR e quem publicou. Sem conteúdo dos registros.

Depois do merge, o `moiras-sync` traz o resultado de volta e o `plan` passa a mostrar esses registros como `skip`.

## Limites

- Só lê o knowledge local e só escreve na seleção temporária, no worktree temporário, no remoto (branch novo) e no relatório. Não altera o `local`, o clone principal, o Jira, o Slack nem outros sistemas.
- Nunca faz push na branch padrão, `force push`, merge, aprovação de PR, nem fecha PR de outra pessoa.
- Nenhum registro vai sem passar no `check`: sem segredos, dados pessoais, caminhos pessoais, texto bruto de issue ou conversa, e sem código acima de 20 linhas ou sem referência (repositório, caminho, commit).
- `.moiras/memory` e `.moiras/runs` nunca são copiados para o destino.
- Rascunhos de repasse à agência nunca são publicados: não são gravados no knowledge.
- Se o `gh` não estiver disponível ou o `push` for recusado, pare e explique; não tente outro caminho (outro branch, outro remoto, outra credencial).
- Identificadores (campos, valores fixos, nomes de branch) em inglês; descrição do PR e relatório em português.
