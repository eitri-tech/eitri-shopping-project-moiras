---
name: moiras-export
description: "Exporta o aprendizado do knowledge local (soluções resolvidas, padrões e decisões) como skills, uma por aprendizado, em skills/<id>/SKILL.md, para qualquer harness que lê skills usar sem o Moiras. Mostra a lista exata do que será criado, atualizado e deixado de fora, e só grava com o \"sim\". Use quando o usuário pedir para gerar, exportar ou atualizar as skills do knowledge (ex.: \"gera as skills do time\")."
allowed-tools: Bash(node:*)
---

# Exportação do aprendizado como skills

Esta skill só roda no modo interativo. Não existe `--auto`: gerar skill depende do "sim" à lista exata, e nem o cron da triagem gera.

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Os demais knowledges declarados entram como `--shared`, na ordem do escopo (o mais específico primeiro, como na triagem).

## O que sai

- **Uma skill por aprendizado**, em `<local-dir>/skills/<id>/SKILL.md`, ao lado de `learnings/`. Entram soluções com `result: resolved`, padrões e decisões. Não entram soluções `pending`, `not-resolved` (que aparecem em "O que não resolveu" da skill do mesmo problema) nem decisões `outcome: rejected` (idem). Uma decisão rejeitada entra em "O que não resolveu" dos aprendizados da mesma `issue` (chave do Jira ou `dono/repo#n`) e, sem issue em comum, dos que citam a PR dela (`reference_url`, ou a URL no texto). Ela não precisa de `source`.
- **`name`** = `<repositório>-<componente>-<id>` em minúsculas, a partir do próprio aprendizado. Não muda entre gerações: gerar de novo substitui a mesma pasta, não duplica.
- **`description`** cita o sintoma concreto e o componente, com "Use quando aparecer esse sintoma". Aprendizado sem sintoma concreto, sem componente ou sem repositório **fica de fora** e aparece no relatório com o motivo.
- **`metadata`** traz `source_hash` (o fingerprint do knowledge usado) e `indexed_at` (a data da geração). O harness pode ignorá-lo.
- **Seções**: Sintoma, Causa, Como confirmar, Correção que resolveu (com a referência, normalmente o PR), O que não resolveu, Regras e termos usados (critérios e glossário do repositório, embutidos) e Origem (os ids, os critérios, os repositórios e as referências `dono/repo#n` ou chave da issue).
- Nada de texto bruto de issue, PR ou conversa: só a síntese que já está no aprendizado. Nada de caminho `.moiras/`, de comando do Moiras nem de `knowledge.ts`: a skill se basta.

## Passos

1. **Fingerprint.** Calcule o `knowledge_fingerprint` como em `skills/moiras-triage/SKILL.md`, seção "Fingerprint do knowledge", sobre todos os knowledges declarados. Ele **não** inclui `skills/`: as skills derivam de `glossary/`, `criteria/` e `learnings/`, e incluí-las faria toda skill parecer desatualizada logo depois de gerada.

2. **Planeje** (não grava nada):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/skills.ts" plan --local <local-dir> [--shared <dir>]... --fingerprint <sha256:...>
   ```

   A saída é JSON: `items` (com `add`, `update`, `unchanged` e `blocked`), `excluded` (id e motivo), `orphans` e `digest`.

3. **Mostre a lista exata**, numerada:
   - `add`: caminho e nome da skill nova;
   - `update`: caminho, o motivo (`source-changed`: o aprendizado ou os critérios mudaram; `divergent`: o arquivo foi editado à mão ou veio de outra versão do gerador) e o `diff` (linhas `-` e `+`);
   - `blocked`: só o caminho, a regra e a linha. Nunca o conteúdo;
   - `excluded`: id e motivo (`no-symptom`, `component-missing`, `pending`, `not-resolved`, `source-invalid` e os demais). Um item bloqueado pelo detector de segredos aparece só pela referência;
   - `orphans`: skills cujo aprendizado não existe mais. Elas **não** são apagadas: ficam listadas para decisão de quem mantém o knowledge.

4. **Peça o "sim"** à lista exata. Sem "sim", pare: nada é gravado. Se algo mudar depois, faça um novo plano e peça um novo "sim".

5. **Grave** só o aprovado, com o digest da lista aprovada:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/skills.ts" write --local <local-dir> [--shared <dir>]... --fingerprint <sha256:...> --expect <digest>
   ```

   Se o knowledge mudou desde o plano, o script recusa (o digest não bate) e não grava nada: refaça o plano. Ele nunca grava `blocked` e nunca apaga arquivo. A saída traz `written` e `check` (achados do `knowledge.ts check` nas skills; deve vir vazio).

6. **Relate**: quantas skills foram criadas e atualizadas; o que ficou de fora, por motivo e id; os órfãos. Sugira o `moiras-publish`: as skills seguem no mesmo PR que os aprendizados que citam.

## Como um harness externo usa as skills

- Cada `skills/<id>/` é autossuficiente. Para usar num harness que lê `SKILL.md` (Claude Code, Codex, Cursor e outros), copie a pasta para a pasta de skills dele (por exemplo `.claude/skills/` do projeto ou `~/.claude/skills/`), ou aponte o harness para a pasta `skills/` do knowledge. Não precisa do Moiras, de scripts nem de caminhos do plugin.
- O harness decide quando carregar pelo `name` e pelo `description` (sintoma e componente).
- Para atualizar, copie a pasta de novo: como o `name` é o mesmo, a skill antiga é substituída, não duplicada.

## Atualização

- A mesma pasta e o mesmo `name` em toda geração. `indexed_at` só muda quando o fingerprint muda.
- Quando o `moiras-sync` traz mudança, ele informa as skills desatualizadas e oferece regenerar, com os conflitos destacados (ver `skills/moiras-sync/SKILL.md`). A regeneração volta aqui, com o "sim".

## Limites

- Só lê os knowledges declarados e só escreve em `<local-dir>/skills/<id>/SKILL.md`, depois do "sim". Não altera `learnings/`, `criteria/`, `glossary/`, nem o Jira, o Slack ou os repositórios.
- Não apaga skill, não reescreve aprendizado e não grava item `blocked`.
- Identificadores (campos, nomes de arquivo, valores fixos) em inglês; texto para pessoas em português.
