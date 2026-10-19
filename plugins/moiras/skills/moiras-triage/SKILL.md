---
name: moiras-triage
description: "Faz a triagem das issues sem responsável do escopo do Jira (um ou vários épicos e categorias). Coleta as issues (por prioridade e data fim) e as conversas das fontes configuradas (pessoas e canais definidos), classifica cada issue com o knowledge do time e sugere normalmente de 3 a 5 soluções com porcentagem de confiança, citando as fontes e registrando a solução escolhida. Use quando o usuário pedir para triar ou priorizar o backlog de um épico (ex.: \"faz a triagem do épico PROJ-100\"). Se nem o pedido nem .moiras/sources.json trouxerem épico ou categoria, pergunte (no modo --auto, encerre com erro)."
argument-hint: "[EPIC...] [--auto] [--full]"
allowed-tools: Bash(node:*)
---

# Triagem do escopo

Argumentos: `$ARGUMENTS`

## Modos de execução

| Modo | Como | Comportamento |
|---|---|---|
| Interativo (padrão) | o usuário chama a skill na conversa | pode perguntar o que faltar; no fim, pede a escolha das soluções e registra o aprendizado |
| Automático | `--auto` (ex.: cron com `claude -p`) | nunca pergunta; sem escopo (épico ou categoria), encerra com erro no relatório; processa issues novas, alteradas ou sem conclusão comprovada para a entrada e o knowledge atuais; não registra aprendizado; aplica só as interações de baixo impacto autorizadas na configuração (reações) e lista as demais; salva o relatório em arquivo |

`--full` reprocessa todas as issues, mesmo as que não mudaram.

Cada execução tem um `run_id` = horário de início em ISO 8601 (UTC), usado na memória e no nome do relatório.

Salve as saídas completas também no modo interativo quando houver veredito ou escolha pendente. No modo automático, salve o relatório da Átropos em `<runs.dir>/<run_id>.md` e as saídas completas em `<runs.dir>/<run_id>.json` (padrão `.moiras/runs/`; crie a pasta se não existir).

Execute as três etapas **em ordem**:

Antes da seleção de issues, calcule o fingerprint do knowledge descrito abaixo.

1. **Cloto** (coleta das fontes configuradas, em paralelo): siga `stages/clotho.md`.
2. **Láquesis** (classificação): antes de aplicar o filtro incremental do `--auto`, resolva os repositórios no glossário atual e recalcule `agency` e os avisos de agência para **todas** as issues coletadas, inclusive `unchanged` (seção 3 da etapa). Use esse resultado nas interações e no relatório mesmo quando a classificação completa for pulada. Depois, siga `stages/lachesis.md`. Depois dela, e antes da Átropos, aplique as interações aprovadas da Cloto, se houver (ver `stages/clotho.md`, "Interações").
3. **Átropos** (veredito e soluções): siga `stages/atropos.md`.

## Protocolo entre etapas

Cada etapa tem um contrato `{input, output}` descrito no seu arquivo. A saída de uma etapa alimenta a entrada da seguinte:

```
Cloto     : configuração + escopo    → issues + mensagens das fontes configuradas
Láquesis  : uma issue + evidências   → repositórios, categoria, confiança, duplicatas, fontes
Átropos   : issue + classificação    → justificativa, ação e normalmente de 3 a 5 soluções com % de confiança
            + precedentes             → (após a escolha do usuário) registro no aprendizado
                                      → (se houver agência e o usuário pedir) rascunho de repasse
```

- Esta skill guarda as saídas de todas as etapas e monta a entrada de cada uma exatamente como o contrato pede.
- Antes de passar adiante, confira se a saída tem todos os campos do contrato. Se faltar algum ou o tipo estiver errado, pare naquela issue e informe qual etapa falhou, em vez de deixar o erro contaminar a etapa seguinte.
- **Conclusão por issue:** `change` indica coleta, não sucesso da triagem. Só pule uma issue `unchanged` no `--auto` se um relatório JSON completo e legível comprovar saídas válidas das três etapas para o mesmo `ticket` atual da Cloto (excluindo apenas `change`), a mesma entrada completa da Láquesis e o mesmo fingerprint do knowledge. Grave essa evidência apenas depois de validar a Átropos e persistir as saídas completas em `<runs.dir>/<run_id>.json`, identificadas pela chave da issue. Falha, interrupção, relatório ausente/incompleto ou fingerprint diferente obrigam nova tentativa, mesmo com `change: unchanged`. Sem conclusão comprovada, o relatório deve indicar a falha; nunca trate o registro da Cloto ou da Láquesis como confirmação de processamento.
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
| `learnings/solutions/` | Soluções escolhidas e o resultado delas | Átropos (e `moiras-learn`, para as já resolvidas no histórico) |
| `learnings/patterns/` | Padrões de problema recorrentes | Láquesis / Átropos (e `moiras-learn`) |
| `learnings/decisions/` | Decisões que valem para casos futuros | as Moiras e `moiras-learn`, a partir de soluções que funcionaram |

Regras de leitura:

- Leia sob demanda; não carregue tudo de uma vez.
- Junte todos os knowledges declarados. Em conflito, o mais específico vence: `local` > `project` > `group` > `global`. A ordem vem do `scope`, não da ordem na lista.
- Cite sempre de qual knowledge veio a informação: `ref` = `knowledge:<name>/<caminho>` (ex.: `knowledge:acme/glossary/acme-shop-checkout.md`).
- Arquivo vazio, com `TODO` ou sem `indexed_at`/`created_at` **não é evidência**: não o cite como fonte.
- Todo arquivo consultado em `glossary/`, `criteria/` e `learnings/` com data de mais de 6 meses gera `knowledge-stale:<ref>` nos avisos e no relatório, usando a referência completa do knowledge. Use `indexed_at` no glossário e `created_at` nos critérios e aprendizados; não atualize a data para esconder a idade. Reavalie a idade a cada execução, inclusive ao reutilizar classificação ou pular uma issue já concluída, e cite a data da evidência antiga.
- Glossário vazio ou issue que cita um repositório fora do glossário: no modo interativo, pergunte se pode rodar `moiras-index` agora; no modo automático, siga sem e avise no relatório. Nunca reindexe sozinha no meio da triagem.
- Se algum knowledge declarado tem `repository`, sugira rodar `moiras-sync` antes, no início do relatório. O sync é opcional.

Regras de escrita (só no modo interativo e só no knowledge de escopo `local`):

- Aprendizado (`learnings/`): um arquivo por registro, nomeado pelo `id`, sem apagar nem reescrever. Só `result` e a `Observação` podem mudar, pelo `id`, quando o usuário informar o desfecho. Para soluções, a mesma escolha da mesma issue com `result: pending` apenas confirma o registro existente; outra solução ou nova tentativa depois de resultado conhecido cria `<KEY>-<n+1>` (ver Átropos). Para padrões e decisões, procure registros equivalentes antes de criar e reutilize a referência existente, sem reescrevê-los.
- Critérios (`criteria/`): só com o "sim" de quem está triando (ver Átropos). Se um critério novo conflitar com outro, una os dois num critério regenerado, com `replaces` contendo IDs simples ou referências `knowledge:<name>/<path>`, e apague apenas os antigos do mesmo knowledge local e dentro do escopo aprovado. Registros compartilhados ficam intocados; referencie-os em `replaces` com a fonte `knowledge:<name>/<caminho>`.
- `chosen_by` e `approved_by` usam um pseudônimo não identificável escolhido pela pessoa, nunca nome real, e-mail ou identificador de conta. Use o formato `<prefixo>-<id>` (por exemplo `reviewer-01`, `user-7`), com o prefixo `person`, `user`, `reviewer`, `pseudonym`, `pessoa`, `usuario` ou `revisor` (ou os nomes fictícios Fulano, Beltrana e Sicrano): é o que o `scripts/knowledge.ts check` aceita antes de uma publicação; outro prefixo (como `auditor-01`) é recusado. Na auditoria, `audit.auditors` usa esses mesmos pseudônimos; a identificação é declarada, não autenticação. Preserve o pseudônimo nos registros e na observação para rastrear escolhas e aprovações sem dados pessoais.
- Nunca grave mais de um trecho por registro, nem trecho maior que 20 linhas, código sem referência (repositório, caminho, commit), segredos, dados pessoais ou texto bruto de issue e de conversa.
- Levar o aprendizado local para um knowledge compartilhado é com o `moiras-publish`, que abre PR e nunca faz merge sozinho.

### Fingerprint do knowledge

Antes de filtrar issues ou reutilizar classificações, forme um manifesto de todos os knowledges configurados: `name`, `scope`, `dir` e a lista ordenada por caminho dos arquivos em `glossary/`, `criteria/` e `learnings/`, cada um com SHA-256 dos bytes atuais. Inclua pastas vazias e ausentes de forma distinta. Ordene os knowledges por `scope`, `name` e `dir` e calcule o SHA-256 do manifesto com `memory.ts hash`: esse é `knowledge_fingerprint`. Não basta o commit Git: alterações locais, inclusões e exclusões também contam. Se algum arquivo não puder ser lido, avise e desative a reutilização e o descarte de issues nesta execução.

O hash de reutilização é o SHA-256 de `{ "input": <entrada completa da Láquesis>, "knowledge_fingerprint": "<fingerprint>" }`, usando `memory.ts hash`. Guarde esse par nas saídas completas do relatório, junto do `ticket`, da classificação e do veredito por chave. Use o snapshot anterior à classificação; se o knowledge mudar durante a execução, a próxima deve reprocessar as issues afetadas (conservadoramente, todas). Registros antigos sem essa evidência não autorizam reutilização nem descarte.

## Memória das etapas

Nos exemplos, defina a variável de shell `memory_dir` com o valor de `memory.dir` lido da configuração; se ausente, use `.moiras/memory`. Passe esse mesmo diretório a toda chamada de `record` e `query`, inclusive nas etapas.

Cada etapa tem uma memória própria, só de acréscimo, em `<memory.dir>/<stage>.jsonl` (padrão `.moiras/memory/`). Ela é local, por máquina, e nunca vai para um knowledge. É gravada **somente** pelo script do plugin, que calcula o hash SHA-256 do conteúdo e descarta o conteúdo bruto:

```bash
# grava (stdin: objeto ou lista com "key" e "content" ou "hash"); devolve uma lista JSON de {key, hash, change}, com change = new | changed | unchanged
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.ts" record clotho --dir "${memory_dir}" < records.json
# hash de um conteúdo, sem gravar
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.ts" hash < content.json
# último registro de cada chave (filtros opcionais)
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory.ts" query lachesis --dir "${memory_dir}" --key PROJ-123 --since 2026-10-01T00:00:00Z
```

O script rejeita campos fora da lista da etapa e hashes fora de `sha256:<64 hex>`. Metadados são resumos derivados; texto bruto só entra em `content`, que é descartado após o hash.

Registros legados com chaves em português (`chave`, `com_quem` etc.) não são migrados: ao encontrar `chave`, o script avisa com arquivo e linha e ignora o registro, inclusive se também houver `key`. Nunca reescreve nem apaga linhas antigas. Recolete e reclassifique para acrescentar registros novos com chaves em inglês; eles iniciam uma nova comparação (`new` se não houver registro válido anterior). O diretório antigo `.moiras/memoria` não é descoberto automaticamente: a configuração define o diretório lido. Não renomeie campos manualmente nem trate classificações legadas como saída válida.

Nunca escreva nesses arquivos à mão nem grave texto bruto de issue ou mensagem neles. O que cada etapa registra está no arquivo da etapa, na seção "Memória".

## Fontes

Toda fonte segue este formato:

```json
{ "ref": "knowledge:acme/glossary/acme-shop-checkout.md | PROJ-187 | <permalink do Slack>", "excerpt": "", "verified_at": "2026-09-15 | null" }
```

## Limites

A skill termina na recomendação. As únicas escritas no Jira e no Slack são as interações opcionais da Cloto (reação no Slack e comentário curto no Jira, ver `stages/clotho.md`): desligadas por padrão (`interactions.enabled`) e aplicadas apenas depois do "sim" do usuário à lista exata. No modo automático, somente `reaction`, se autorizada em `interactions.auto_types` (padrão `["reaction"]`), dispensa o "sim"; comentários nunca são aplicados, mesmo se incluídos nessa configuração. Comentários também nunca vão para issues com agência ou com agência ambígua. O repasse à agência (ver `stages/atropos.md`, seção 9) é sempre só um rascunho: quem envia é o usuário; o plugin nunca o envia, nem com aprovação.

Fora a memória, os relatórios das execuções e o knowledge local (aprendizado e critérios, como descrito acima), a skill não escreve nada.
