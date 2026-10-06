---
name: moiras-triage
description: Faz a triagem das issues sem responsável de um épico do Jira da Acme. Coleta as issues (por prioridade e data fim) e as conversas do Slack de pessoas e canais definidos, classifica cada issue com a base de conhecimento do projeto e sugere até 3 soluções com porcentagem de confiança, citando as fontes e anotando a solução escolhida. Use quando o usuário pedir para triar ou priorizar o backlog de um épico da Acme (ex.: "faz a triagem do épico PROJ-100"). Se a chave do épico não vier no pedido nem em .moiras/sources.json, pergunte.
---

# Triagem do épico

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

## Fontes

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
