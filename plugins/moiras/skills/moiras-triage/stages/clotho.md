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

Monitore **todos** os canais de `slack.channels` (um ou mais), olhando os últimos `slack.lookback_days` dias e **apenas** as mensagens das pessoas configuradas:

- Por padrão, cada canal usa as pessoas de `slack.people`. Um canal com `people` próprio usa a lista dele **somada** à global.
- Faça uma leitura por canal, **todas em paralelo** e na mesma rodada do Jira: leia o histórico do canal no período e filtre os autores localmente. Se o conector só oferecer busca, use uma consulta por canal com as pessoas dele:

  ```
  in:<#CHANNEL_ID> from:<@USER_ID_1> after:<YYYY-MM-DD>
  ```

  (repita por pessoa quando a busca não aceitar vários `from:` na mesma consulta).
- Uma mensagem citada em mais de um canal (ex.: compartilhada) entra uma vez só; guarde todos os canais em que apareceu.

Abra a thread das mensagens que tiverem respostas e guarde cada resposta (autor, data, texto, permalink). Extraia as chaves de issue citadas (padrão `[A-Z][A-Z0-9]+-\d+`) da mensagem e das respostas; a mensagem passa a citar a união das duas.

### Falhas

Cada fonte tem um `status`: `ok` ou `falhou` (conector ausente, sem permissão, erro da API). Não invente dados da fonte que falhou.

- **Jira falhou, épico não encontrado ou nenhuma issue a triar:** encerre a triagem aqui e informe o motivo. Não há o que passar para a Láquesis.
- **Slack falhou em todos os canais:** siga só com o Jira, com `slack.mensagens: []`, e acrescente o aviso `slack-indisponivel` em todas as issues.
- **Slack falhou em alguns canais:** `slack.status: parcial`; siga com os canais que responderam e acrescente `slack-canal-indisponivel:<canal>` em todas as issues, um por canal que falhou.

Uma fonte com `status: falhou` e listas vazias é uma saída válida pelo contrato; não conta como campo faltando.

### Outras fontes

Hoje as fontes esperadas são o **Jira** (obrigatório: é dele que vêm as issues a triar) e o **Slack** (contexto). A Cloto pode monitorar outras fontes no futuro (ex.: PRs e issues do GitHub, alertas de observabilidade, Confluence, e-mail), desde que cada nova fonte siga o mesmo padrão:

- um bloco próprio em `.moiras/sources.json`, com o que filtrar (pessoas, canais, repositórios, consultas);
- coleta disparada na mesma rodada paralela do Jira e do Slack;
- um bloco próprio na saída, com `status: ok | falhou` e listas vazias quando falhar;
- itens ligados às issues pelas chaves citadas (padrão `[A-Z][A-Z0-9]+-\d+`), entrando em `evidencias` no formato de fonte;
- registro na memória com chave `<fonte>:<id>` e o mesmo `com_quem`/`conteudo`.

Fonte não configurada é ignorada sem aviso. Enquanto uma nova fonte não estiver documentada nesta etapa, não a use.

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
        "mudanca": "novo | alterado | inalterado",
        "avisos": []
      }
    ],
    "irmas": [
      { "key": "PROJ-1187", "resumo": "", "status": "Done", "responsavel": "Fulano", "resolvida_em": "2026-08-20" }
    ]
  },
  "slack": {
    "status": "ok | parcial | falhou",
    "canais": [
      { "id": "C0123456789", "name": "#proj-squad", "status": "ok", "mensagens": 12 },
      { "id": "C0987654321", "name": "#proj-suporte", "status": "falhou", "mensagens": 0 }
    ],
    "periodo": { "de": "2026-09-29", "ate": "2026-10-06" },
    "mensagens": [
      {
        "canal": "#proj-squad",
        "tambem_em": [],
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

## Memória

Depois da coleta, registre **cada interação** em uma única chamada `registrar cloto`, um objeto por item:

```json
[
  {
    "chave": "jira:PROJ-1423",
    "run_id": "2026-10-06T11:00:00Z",
    "fonte": "jira",
    "com_quem": { "relator": "Fulano", "atualizado_por": "Beltrana" },
    "atualizado_em": "2026-10-05T17:40:00-03:00",
    "conteudo": { "resumo": "", "descricao": "", "prioridade": "", "status": "", "duedate": "" }
  },
  {
    "chave": "slack:C0123456789:1696341120.000100",
    "run_id": "2026-10-06T11:00:00Z",
    "fonte": "slack",
    "com_quem": { "autor": "Fulano", "canal": "#proj-squad" },
    "atualizado_em": "2026-10-03T14:12:00-03:00",
    "conteudo": { "texto": "", "respostas": ["<texto de cada resposta>"] }
  }
]
```

- `ts` (quando a Cloto viu o item) é preenchido pelo script; `conteudo` vira `hash` e não é guardado.
- O retorno diz se cada item é `novo`, `alterado` ou `inalterado` desde a última execução. Copie isso para o campo `mudanca` de cada issue em `jira.issues`. Uma issue também conta como `alterado` se alguma mensagem do Slack que a cita for `novo` ou `alterado`.
- No modo automático (sem `--completo`), só issues `novo` ou `alterado` seguem para a Láquesis. As demais aparecem no relatório como "sem mudança".

## Entrada da Láquesis

Com as duas coletas prontas, monte uma entrada da Láquesis por issue, na ordem do Jira:

- `key`, `resumo`, `descricao`, `prioridade`: do item de `jira.issues`.
- `evidencias`: as mensagens do Slack cuja `issues_citadas` contém a chave, **e cada resposta da thread** como fonte separada (`ref` = permalink, `trecho` = texto, `last_verified` = data).
- `irmas`: `jira.irmas` sem a própria issue.
- `avisos`: os da issue (`sem-data`, `estoura-epico`) mais os da coleta (`slack-indisponivel`).

Mensagens que não citam nenhuma issue ficam em `slack.sem_issue`, como contexto geral.

O item completo de `jira.issues` (com `descricao`, `duedate` e `folga_dias`) fica guardado: ele é o `ticket` da entrada da Átropos.

Somente leitura: esta etapa nunca cria, comenta ou atribui issues, nem posta no Slack.
