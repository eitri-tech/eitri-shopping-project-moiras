---
name: moiras-triage
description: Faz a triagem das issues sem responsável de um épico do Jira. Coleta as issues (por prioridade e data fim) e as conversas do Slack de pessoas e canais definidos, classifica cada issue com o knowledge do time e sugere pelo menos 3 soluções com porcentagem de confiança, citando as fontes e registrando a solução escolhida. Use quando o usuário pedir para triar ou priorizar o backlog de um épico (ex.: "faz a triagem do épico PROJ-100"). Se a chave do épico não vier no pedido nem em .moiras/sources.json, pergunte (no modo --auto, encerre com erro).
argument-hint: "[EPIC] [--auto] [--full]"
allowed-tools: Bash(node:*)
---

# Triagem do épico

Argumentos: `$ARGUMENTS`

## Modos de execução

| Modo | Como | Comportamento |
|---|---|---|
| Interativo (padrão) | o usuário chama a skill na conversa | pode perguntar o que faltar; no fim, pede a escolha das soluções e registra o aprendizado |
| Automático | `--auto` (ex.: cron com `claude -p`) | nunca pergunta; sem épico, encerra com erro no relatório; processa só issues novas ou alteradas desde a última execução; não registra aprendizado; aplica só as interações de baixo impacto autorizadas na configuração (reações) e lista as demais; salva o relatório em arquivo |

`--full` reprocessa todas as issues, mesmo as que não mudaram.

Cada execução tem um `run_id` = horário de início em ISO 8601 (UTC), usado na memória e no nome do relatório.

No modo automático, salve o relatório da Átropos em `<runs.dir>/<run_id>.md` e as saídas completas em `<runs.dir>/<run_id>.json` (padrão `.moiras/runs/`; crie a pasta se não existir).

Execute as três etapas **em ordem**:

1. **Cloto** (coleta Jira + Slack, em paralelo): siga `stages/clotho.md`.
2. **Láquesis** (classificação): antes de aplicar o filtro incremental do `--auto`, resolva os repositórios no glossário atual e recalcule `agency` e os avisos de agência para **todas** as issues coletadas, inclusive `unchanged` (seção 3 da etapa). Use esse resultado nas interações e no relatório mesmo quando a classificação completa for pulada. Depois, siga `stages/lachesis.md`. Depois dela, e antes da Átropos, aplique as interações aprovadas da Cloto, se houver (ver `stages/clotho.md`, "Interações").
3. **Átropos** (veredito e soluções): siga `stages/atropos.md`.

## Protocolo entre etapas

Cada etapa tem um contrato `{input, output}` descrito no seu arquivo. A saída de uma etapa alimenta a entrada da seguinte:

```
Cloto     : configuração + épico     → issues do Jira + mensagens do Slack
Láquesis  : uma issue + evidências   → repositórios, categoria, confiança, duplicatas, fontes
Átropos   : issue + classificação    → justificativa, ação e de 3 a 5 soluções com % de confiança
            + precedentes             → (após a escolha do usuário) registro no aprendizado
                                      → (se houver agência e o usuário pedir) rascunho de repasse
```

- Esta skill guarda as saídas de todas as etapas e monta a entrada de cada uma exatamente como o contrato pede.
- Antes de passar adiante, confira se a saída tem todos os campos do contrato. Se faltar algum ou o tipo estiver errado, pare naquela issue e informe qual etapa falhou, em vez de deixar o erro contaminar a etapa seguinte.
- `warnings` se acumulam: cada etapa recebe os avisos na entrada, repassa todos na saída e acrescenta os seus.
- Uma fonte com `status: failed` e listas vazias é saída válida (ver Cloto). Se a Cloto encerrar a triagem, não chame as outras etapas.

Identificadores (campos, valores fixos, flags, pastas) são em inglês. Textos para pessoas (justificativas, relatórios, descrições) são em português.

## Knowledge

O knowledge é o que não está escrito no código, ou que seria caro redescobrir a cada issue. Ele nunca tem cópia de código: as Moiras sempre olham o código real.

Ele é declarado em `knowledge` no `.moiras/sources.json`: uma lista de knowledges, cada um com `name`, `scope` (`local | project | group | global`), `dir` e, opcionalmente, `repository` (um repositório git privado, criado a partir do template público de knowledge). Sem nenhum item, vale só `.moiras/knowledge/` com escopo `local`.

Todo knowledge tem a mesma estrutura:

| Pasta | Conteúdo | Quem escreve |
|---|---|---|
| `glossary/` | Glossário de repositórios: um arquivo por repositório, com localização e metadados (e, opcionalmente, `agency`, a agência que cuida dele) | `moiras-index` (derivado do código, pode ser regenerado) |
| `criteria/` | Regras de classificação e de decisão do time | as Moiras, com o "sim" de quem está triando ou audita (`moiras-audit`) |
| `learnings/solutions/` | Soluções escolhidas e o resultado delas | Átropos |
| `learnings/patterns/` | Padrões de problema recorrentes | Láquesis / Átropos |
| `learnings/decisions/` | Decisões que valem para casos futuros | as Moiras, a partir de soluções que funcionaram |

Regras de leitura:

- Leia sob demanda; não carregue tudo de uma vez.
- Junte todos os knowledges declarados. Em conflito, o mais específico vence: `local` > `project` > `group` > `global`. A ordem vem do `scope`, não da ordem na lista.
- Cite sempre de qual knowledge veio a informação: `ref` = `knowledge:<name>/<caminho>` (ex.: `knowledge:acme/glossary/acme-shop-checkout.md`).
- Arquivo vazio, com `TODO` ou sem `indexed_at`/`created_at` **não é evidência**: não o cite como fonte.
- Glossário com `indexed_at` de mais de 6 meses gera o aviso `knowledge-stale:<arquivo>`.
- Glossário vazio ou issue que cita um repositório fora do glossário: no modo interativo, pergunte se pode rodar `moiras-index` agora; no modo automático, siga sem e avise no relatório. Nunca reindexe sozinha no meio da triagem.
- Se algum knowledge declarado tem `repository`, sugira rodar `moiras-sync` antes, no início do relatório. O sync é opcional.

Regras de escrita (só no modo interativo e só no knowledge de escopo `local`):

- Aprendizado (`learnings/`): só acréscimo, um arquivo por registro, nomeado pelo `id`. Antes de criar, procure registros parecidos; se já existir, atualize em vez de duplicar.
- Critérios (`criteria/`): só com o "sim" de quem está triando (ver Átropos). Se um critério novo conflitar com outro, una os dois num critério regenerado, com `replaces: [<ids>]`, e apague apenas os antigos do mesmo knowledge local e dentro do escopo aprovado. Registros compartilhados ficam intocados; referencie-os em `replaces` com a fonte `knowledge:<name>/<caminho>`.
- `chosen_by` e `approved_by` usam um pseudônimo não identificável escolhido pela pessoa, nunca nome real, e-mail ou identificador de conta. Na auditoria, `audit.auditors` usa esses mesmos pseudônimos; a identificação é declarada, não autenticação. Preserve o pseudônimo nos registros e na observação para rastrear escolhas e aprovações sem dados pessoais.
- Nunca grave código maior que 20 linhas, código sem referência (repositório, caminho, commit), segredos, dados pessoais ou texto bruto de issue e de conversa.
- Levar o aprendizado local para um knowledge compartilhado é com o `moiras-publish`, que abre PR e nunca faz merge sozinho.

## Memória das etapas

Cada etapa tem uma memória própria, só de acréscimo, em `<memory.dir>/<stage>.jsonl` (padrão `.moiras/memory/`). Ela é local, por máquina, e nunca vai para um knowledge. É gravada **somente** pelo script do plugin, que calcula o hash SHA-256 do conteúdo e descarta o conteúdo bruto:

```bash
# grava (stdin: objeto ou lista com "key" e "content" ou "hash"); devolve new | changed | unchanged
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.ts" record clotho --dir .moiras/memory < records.json
# hash de um conteúdo, sem gravar
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.ts" hash < content.json
# último registro de cada chave (filtros opcionais)
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.ts" query lachesis --key PROJ-123 --since 2026-10-01T00:00:00Z
```

Nunca escreva nesses arquivos à mão nem grave texto bruto de issue ou mensagem neles. O que cada etapa registra está no arquivo da etapa, na seção "Memória".

## Fontes

Toda fonte segue este formato:

```json
{ "ref": "knowledge:acme/glossary/acme-shop-checkout.md | PROJ-187 | <permalink do Slack>", "excerpt": "", "verified_at": "2026-09-15 | null" }
```

## Limites

A skill termina na recomendação. As únicas escritas no Jira e no Slack são as interações opcionais da Cloto (reação no Slack e comentário curto no Jira, ver `stages/clotho.md`): desligadas por padrão (`interactions.enabled`) e aplicadas apenas depois do "sim" do usuário à lista exata. No modo automático, somente `reaction`, se autorizada em `interactions.auto_types` (padrão `["reaction"]`), dispensa o "sim"; comentários nunca são aplicados, mesmo se incluídos nessa configuração. Comentários também nunca vão para issues com agência ou com agência ambígua. O repasse à agência (ver `stages/atropos.md`, seção 9) é sempre só um rascunho: quem envia é o usuário; o plugin nunca o envia, nem com aprovação.

Fora a memória, os relatórios do modo automático e o knowledge local (aprendizado e critérios, como descrito acima), a skill não escreve nada.
