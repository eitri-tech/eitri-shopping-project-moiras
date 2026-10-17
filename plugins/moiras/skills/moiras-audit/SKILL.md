---
name: moiras-audit
description: Permite que uma pessoa auditora revise o knowledge do time (glossário, critérios e aprendizado) e faça ajustes com aprovação, como a avaliação que o usuário faz no fim da triagem. Aponta registros velhos, pendentes, conflitantes ou fora das regras do knowledge e propõe cada ajuste. Use quando o usuário pedir para auditar, revisar ou corrigir o knowledge (ex.: "audita os critérios", "revisa os aprendizados pendentes").
argument-hint: "[glossary|criteria|learnings|all] [--since AAAA-MM-DD]"
allowed-tools: Bash(node:*)
---

# Auditoria do knowledge

Argumentos: `$ARGUMENTS`

A triagem já deixa o usuário corrigir a Átropos no fim do pipeline: escolher a solução, contar o desfecho (`result`) e transformar uma discordância em critério. Esta skill dá o mesmo poder a quem revisa o knowledge depois, fora de uma triagem. Ela só roda no modo interativo: não existe `--auto`, porque todo ajuste depende do "sim" de uma pessoa.

## Quem audita

- Auditor é quem está conversando com a skill. A skill pede um pseudônimo não identificável escolhido pela pessoa (nunca nome real, e-mail ou identificador de conta) e o usa em `approved_by` dos critérios que gerar e na observação dos aprendizados que ajustar.
- Se `audit.auditors` existir em `.moiras/sources.json`, o pseudônimo precisa estar na lista (que deve conter apenas esses pseudônimos); se não estiver, a skill avisa e só permite a leitura (sem ajustes). Sem a chave, qualquer pessoa pode auditar. É uma identificação, não uma autenticação: o plugin roda na máquina de quem o usa.
- A skill só altera o knowledge de escopo `local`. Um registro de knowledge compartilhado (`project`, `group`, `global`) nunca é alterado por aqui, e o que fazer com ele depende do tipo: critério é substituído por um critério local com `replaces`; aprendizado e glossário só são reportados (o aprendizado é ajustado por quem tem o registro no knowledge local ou no repositório compartilhado, e o glossário se resolve com `moiras-index`). Levar um ajuste local ao compartilhado é com o `moiras-publish`, que abre PR e nunca faz merge sozinho.

## Escopo

O primeiro argumento limita a pasta (`glossary`, `criteria`, `learnings` ou `all`, o padrão); `--since` olha só registros criados ou indexados desde a data. Na dúvida sobre o escopo, pergunte, mas leia sob demanda: nada de carregar o knowledge inteiro de uma vez (ver `moiras-triage/SKILL.md`, "Knowledge").

## Passos

1. **Ler.** Junte os knowledges declarados em `knowledge` (mesmas regras de leitura e de precedência da triagem) e, dentro do escopo, procure os achados abaixo. O que é mecânico (campos obrigatórios faltando, modelo não preenchido, segredo, credencial em URL, caminho absoluto, código acima de 20 linhas ou sem referência) sai do script, que só devolve caminho e regra, sem repetir o conteúdo: `node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <dir do knowledge> [--only glossary|criteria|learnings]`.
2. **Mostrar.** Apresente os achados numerados, do mais grave ao menos grave, cada um com a fonte (`ref` = `knowledge:<name>/<caminho>`), o motivo e o ajuste proposto.
3. **Decidir.** Para cada achado, o auditor escolhe: aplicar, editar o ajuste, pular ou discordar (ver "Discordância").
4. **Aplicar.** Só os registros dentro da pasta e do período selecionados; se um ajuste exigir outro escopo, apresente a ampliação e espere novo "sim" antes de agir. Só o que o auditor aprovou, e só depois do "sim" à lista exata. Item novo precisa de nova aprovação.
5. **Registrar.** Salve o relatório da auditoria em `<runs.dir>/audit-<audit_id>.md` (`audit_id` = horário de início em ISO 8601 UTC; padrão `.moiras/runs/`): achados, o que foi aplicado, pulado e adiado, e quem auditou. Sem texto bruto de issues ou conversas.

## O que procurar

| Achado | Onde | Ajuste possível |
|---|---|---|
| Glossário com `indexed_at` de mais de 6 meses, vazio ou com `TODO` | `glossary/` | só sugerir rodar `moiras-index`; a skill não edita o glossário |
| Solução com `result: pending` há muito tempo | `learnings/solutions/` | perguntar o desfecho e atualizar `result` e a observação |
| Solução com `result: not-resolved` e sem observação do que mudou | `learnings/solutions/` | pedir a observação |
| Soluções resolvidas que se repetem | `learnings/solutions/` | só sugerir no relatório; criar padrão ou decisão é com a Átropos, numa triagem |
| Critérios que se contradizem ou se sobrepõem | `criteria/` | unir num critério regenerado (`replaces`) |
| Critério sem `approved_by` ou sem `created_at` | `criteria/` | regenerar o critério com `replaces`, completando os campos com o auditor |
| Aprendizado sem `created_at` | `learnings/` | só sinalizar no relatório: o registro não é editado e segue sem valer como fonte |
| Glossário sem `indexed_at` | `glossary/` | só sugerir `moiras-index`; sem a data ele não é evidência |
| Código com mais de 20 linhas, sem referência (repositório, caminho, commit), segredo, dado pessoal ou texto bruto de issue ou conversa | qualquer pasta | critério: regenerar sem o trecho (`replaces`); glossário e aprendizado: só reportar; ver "Dados sensíveis" |
| Registro duplicado | `learnings/` | indicar o registro a manter; não apague (ver "Limites") |

A skill também compara cada critério com os aprendizados recentes: se uma solução resolvida contraria o critério, é um achado.

## Discordância

É o mesmo caminho do fim da triagem (`moiras-triage`, Átropos, seção "Critérios"): quando o auditor discordar de uma ação, categoria, origem ou da ordem das soluções de um registro, pergunte se a regra deve valer para os próximos casos. Com o "sim", grave um critério em `criteria/<id>.md` no knowledge local:

```markdown
---
id: <slug-curto>
type: criterion
created_at: 2026-10-06
approved_by: <pseudônimo não identificável do auditor>
applies_to: category | origin | action | solutions
replaces: []
---

# <Título da regra>

<A regra, em uma ou duas frases.>

**Por quê:** <o caso que motivou, sem texto bruto da issue>
```

Se o critério novo conflitar com um existente, una os dois num critério regenerado, liste os antigos em `replaces` e apague só os antigos que estão no mesmo knowledge local e no escopo aprovado. Os de um knowledge compartilhado (`project`, `group`, `global`) ficam intocados: o critério local os substitui pelo `replaces` com a fonte `knowledge:<name>/<caminho>`, e a remoção deles no repositório compartilhado é com o `moiras-publish`, num PR. Mudar um critério existente é gerar um novo com `replaces` do antigo, nunca reescrever o arquivo.

## Dados sensíveis

Ao achar segredo, token, dado pessoal ou texto bruto num registro, o relatório da auditoria diz o caminho e o tipo do achado, **sem repetir o conteúdo**. O que a skill pode fazer depende do tipo do registro:

- **Critério:** regenerar o critério sem o trecho, com `replaces` do antigo e o "sim" do auditor.
- **Glossário:** só reportar e sugerir a reindexação com `moiras-index`; a skill não o edita.
- **Aprendizado:** só reportar. A skill não reescreve o registro (só `result` e a observação mudam), então a limpeza é feita pelo auditor fora do plugin; a observação do registro pode receber a linha de auditoria, sem repetir o conteúdo. Se o registro já foi publicado num knowledge compartilhado, avise o auditor que o histórico do repositório continua com o conteúdo e que isso precisa ser tratado fora do plugin.

## Limites

- Só o knowledge local e o relatório da auditoria são escritos. Nada de Jira, Slack, agências ou outros sistemas, e nenhuma interação da Cloto.
- Aprendizado não é apagado nem reescrito: só `result` e a observação mudam. A observação ganha uma linha no formato `Auditoria AAAA-MM-DD, <auditor>: <o que mudou>`.
- Critérios só mudam por regeneração (`replaces`), com o "sim" do auditor.
- O glossário vem do código: a skill nunca o edita, só sugere a reindexação.
- O knowledge nunca recebe cópia de código: no máximo um trecho por registro, de até 20 linhas, sempre com referência (repositório, caminho, commit). Sem segredos.
- A auditoria não cria aprendizado (`solutions/`, `patterns/` ou `decisions/`); o critério regenerado leva `created_at` em formato de data; o glossário leva `indexed_at`, mas só a indexação o grava.
- Identificadores (campos, valores fixos, pastas) em inglês; justificativas e relatórios em português.
