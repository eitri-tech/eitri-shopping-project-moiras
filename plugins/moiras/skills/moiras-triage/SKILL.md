---
name: moiras-triage
description: Faz a triagem das issues sem responsável de um épico do Jira da Acme. Coleta as issues (por prioridade e data fim) e as conversas do Slack de pessoas e canais definidos, classifica cada issue com a base de conhecimento do projeto e sugere até 3 soluções com porcentagem de confiança, citando as fontes e anotando a solução escolhida. Use quando o usuário pedir para triar ou priorizar o backlog de um épico da Acme (ex.: "faz a triagem do épico PROJ-100"). Se a chave do épico não vier no pedido nem em .moiras/sources.json, pergunte (no modo --auto, encerre com erro).
argument-hint: "[EPICO] [--auto] [--completo]"
allowed-tools: Bash(node:*)
---

# Triagem do épico

Argumentos: `$ARGUMENTS`

## Modos de execução

| Modo | Como | Comportamento |
|---|---|---|
| Interativo (padrão) | o usuário chama a skill na conversa | pode perguntar o que faltar; no fim, pede a escolha das soluções e grava o registro de soluções |
| Automático | argumento `--auto` (ex.: cron com `claude -p`) | nunca pergunta; sem épico, encerra com erro no relatório; processa só issues novas ou alteradas desde a última execução; não grava o registro de soluções; salva o relatório em arquivo |

`--completo` reprocessa todas as issues, mesmo as que não mudaram.

Cada execução tem um `run_id` = horário de início em ISO 8601 (UTC), usado na memória e no nome do relatório.

No modo automático, salve o relatório da Átropos em `<memoria.execucoes>/<run_id>.md` e as saídas completas em `<memoria.execucoes>/<run_id>.json` (crie a pasta se não existir).

Execute as três etapas **em ordem**:

1. **Cloto** (coleta Jira + Slack, em paralelo): siga `stages/clotho.md`.
2. **Láquesis** (classificação): siga `stages/lachesis.md`.
3. **Átropos** (veredito): siga `stages/atropos.md`.

## Protocolo entre etapas

Cada etapa tem um contrato `{entrada, saida}` descrito no seu arquivo. A saída de uma etapa alimenta a entrada da seguinte:

```
Cloto     : configuração + épico     → issues do Jira + mensagens do Slack
Láquesis  : uma issue + evidências   → repositórios, categoria, confiança, duplicatas, fontes
Átropos   : issue + classificação    → justificativa, ação e até 3 soluções com % de confiança
            + precedentes             → (após escolha do usuário) entrada no registro de soluções
```

- Esta skill guarda as saídas de todas as etapas e monta a entrada de cada uma exatamente como o contrato pede.
- Antes de passar adiante, confira se a saída tem todos os campos do contrato. Se faltar algum ou o tipo estiver errado, pare naquela issue e informe qual etapa falhou, em vez de deixar o erro contaminar a etapa seguinte.
- `avisos` se acumulam: cada etapa recebe os avisos na entrada, repassa todos na saída e acrescenta os seus.
- Uma fonte com `status: falhou` e listas vazias é saída válida (ver Cloto). Se a Cloto encerrar a triagem, não chame as outras etapas.

## Memória das etapas

Cada etapa tem uma memória própria, só de acréscimo, em `<memoria.diretorio>/<etapa>.jsonl` (padrão `.moiras/memoria/`). Ela é gravada **somente** pelo script do plugin, que calcula o hash SHA-256 do conteúdo e descarta o conteúdo bruto:

```bash
# grava (stdin: objeto ou lista com "chave" e "conteudo" ou "hash"); devolve novo | alterado | inalterado
node "${CLAUDE_PLUGIN_ROOT}/scripts/memoria.ts" registrar cloto --dir .moiras/memoria < registros.json
# hash de um conteúdo, sem gravar
node "${CLAUDE_PLUGIN_ROOT}/scripts/memoria.ts" hash < conteudo.json
# último registro de cada chave (filtros opcionais)
node "${CLAUDE_PLUGIN_ROOT}/scripts/memoria.ts" consultar laquesis --chave PROJ-1423 --desde 2026-10-01T00:00:00Z
```

Nunca escreva nesses arquivos à mão nem grave texto bruto de issue ou mensagem neles. O que cada etapa registra está no arquivo da etapa, na seção "Memória".


Toda fonte segue este formato:

```json
{ "ref": "${CLAUDE_PLUGIN_ROOT}/knowledge/components.md#checkout | PROJ-1187 | <permalink do Slack>", "trecho": "", "last_verified": "2026-09-15 | null" }
```

## Base de conhecimento

- Fica em `${CLAUDE_PLUGIN_ROOT}/knowledge/`: glossário de repositórios, taxonomia, componentes e decisões. Leia sob demanda; não carregue tudo de uma vez.
- Arquivo com conteúdo `TODO` ou `last_verified` vazio **não é evidência**: não o cite como fonte.
- `last_verified` com mais de 6 meses ou data inválida gera o aviso `base-desatualizada:<arquivo>`.

## Limites

A skill termina na recomendação. Ela não altera, comenta, atribui nem transiciona issues no Jira e não posta no Slack. Qualquer escrita nesses sistemas é uma ação separada, que exige aprovação explícita do usuário para aquela operação específica.

A única escrita da skill é o registro de soluções, feita pela Átropos depois que o usuário escolhe a solução. O caminho é `memoria.solucoes` de `.moiras/sources.json` (padrão `.moiras/solucoes.md`), relativo à raiz do projeto, e vale para leitura, escrita e referências.
