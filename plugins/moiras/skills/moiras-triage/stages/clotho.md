# Cloto — coleta

Fia a matéria-prima da triagem: busca, **em paralelo**, as issues pendentes do épico no Jira e as conversas relevantes no Slack.

**Entrada:** configuração em `.moiras/sources.json` no diretório do projeto (modelo em `${CLAUDE_PLUGIN_ROOT}/config/sources.example.json`). Se o usuário informar outro épico na conversa, ele tem precedência sobre o da configuração.

## Execução

Dispare as duas buscas **na mesma rodada de chamadas de ferramenta**, sem esperar uma terminar para começar a outra.

### A. Jira

1. Leia o épico (`jira.epic`) e guarde a data fim dele: `duedate` ou, se vazio, o campo de data alvo do épico. Se o épico não tiver data, use `jira.project_end` da configuração.
2. Busque as issues do épico sem responsável e não concluídas:

   ```
   parent = <EPIC> AND assignee IS EMPTY AND statusCategory != Done
   ORDER BY priority DESC, duedate ASC
   ```

   Em projetos que ainda usam o campo antigo de épico, troque `parent = <EPIC>` por `"Epic Link" = <EPIC>`.
3. Para cada issue, calcule `folga_dias` = data fim do épico − `duedate` da issue.
   - `duedate` vazio: `folga_dias = null`, com o aviso `sem-data`.
   - `duedate` depois da data fim do épico: aviso `estoura-epico`.

A ordem final segue a do Jira (prioridade, depois data fim). Issues com `estoura-epico` sobem dentro da mesma prioridade.

4. Na mesma rodada, busque **todas** as issues do épico, de qualquer status e responsável, só com chave, resumo, status, responsável e data de resolução: `parent = <EPIC> ORDER BY key`. Elas formam `jira.irmas`, usadas pela Láquesis na busca de duplicados. As issues a triar continuam sendo só as do passo 2.

### B. Slack

Busque mensagens dos últimos `slack.lookback_days` dias **apenas** das pessoas em `slack.people` e **apenas** nos canais em `slack.channels`:

```
from:<@USER_ID> in:<#CHANNEL_ID> after:<YYYY-MM-DD>
```

Abra a thread das mensagens que tiverem respostas e guarde cada resposta (autor, data, texto, permalink). Extraia as chaves de issue citadas (padrão `[A-Z][A-Z0-9]+-\d+`) da mensagem e das respostas; a mensagem passa a citar a união das duas.

### Falhas

Cada fonte tem um `status`: `ok` ou `falhou` (conector ausente, sem permissão, erro da API). Não invente dados da fonte que falhou.

- **Jira falhou, épico não encontrado ou nenhuma issue a triar:** encerre a triagem aqui e informe o motivo. Não há o que passar para a Láquesis.
- **Slack falhou:** siga só com o Jira, com `slack.mensagens: []`, e acrescente o aviso `slack-indisponivel` em todas as issues.

Uma fonte com `status: falhou` e listas vazias é uma saída válida pelo contrato; não conta como campo faltando.

## Saída

```json
{
  "coletado_em": "2026-10-06T18:00:00-03:00",
  "jira": {
    "status": "ok | falhou",
    "epico": { "key": "PROJ-100", "resumo": "", "data_fim": "2026-12-15", "origem_data_fim": "duedate | target | project_end" },
    "issues": [
      {
        "key": "PROJ-1423",
        "resumo": "",
        "descricao": "",
        "prioridade": "High",
        "status": "To Do",
        "duedate": "2026-11-30",
        "folga_dias": 15,
        "avisos": []
      }
    ],
    "irmas": [
      { "key": "PROJ-1187", "resumo": "", "status": "Done", "responsavel": "Fulano", "resolvida_em": "2026-08-20" }
    ]
  },
  "slack": {
    "status": "ok | falhou",
    "periodo": { "de": "2026-09-29", "ate": "2026-10-06" },
    "mensagens": [
      {
        "canal": "#proj-squad",
        "autor": "Fulano",
        "data": "2026-10-03T14:12:00-03:00",
        "texto": "",
        "permalink": "",
        "issues_citadas": ["PROJ-1423"],
        "respostas": [
          { "autor": "Beltrana", "data": "2026-10-03T15:01:00-03:00", "texto": "", "permalink": "" }
        ]
      }
    ],
    "sem_issue": []
  },
  "erros": []
}
```

## Entrada da Láquesis

Com as duas coletas prontas, monte uma entrada da Láquesis por issue, na ordem do Jira:

- `key`, `resumo`, `descricao`, `prioridade`: do item de `jira.issues`.
- `evidencias`: as mensagens do Slack cuja `issues_citadas` contém a chave, **e cada resposta da thread** como fonte separada (`ref` = permalink, `trecho` = texto, `last_verified` = data).
- `irmas`: `jira.irmas` sem a própria issue.
- `avisos`: os da issue (`sem-data`, `estoura-epico`) mais os da coleta (`slack-indisponivel`).

Mensagens que não citam nenhuma issue ficam em `slack.sem_issue`, como contexto geral.

O item completo de `jira.issues` (com `descricao`, `duedate` e `folga_dias`) fica guardado: ele é o `ticket` da entrada da Átropos.

Somente leitura: esta etapa nunca cria, comenta ou atribui issues, nem posta no Slack.
