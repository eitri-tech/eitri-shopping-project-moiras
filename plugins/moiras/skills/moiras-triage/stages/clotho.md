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

   Se `jira.agency_field` estiver configurado, peça também esse campo (nome ou id; texto, opção ou etiqueta) na mesma busca. O valor vira `agency` da issue; campo vazio ou não configurado é `null`, sem aviso: a agência é opcional.
3. Para cada issue, calcule `buffer_days` = data fim do épico − `duedate` da issue.
   - `duedate` vazio: `buffer_days = null`, com o aviso `no-due-date`.
   - `duedate` depois da data fim do épico: aviso `exceeds-epic`.

A ordem final segue a do Jira (prioridade, depois data fim). Issues com `exceeds-epic` sobem dentro da mesma prioridade.

4. Na mesma rodada, busque **todas** as issues do épico, de qualquer status e responsável, só com chave, resumo, status, responsável e data de resolução: `parent = <EPIC> ORDER BY key`. Elas formam `jira.siblings`, usadas pela Láquesis na busca de duplicados. As issues a triar continuam sendo só as do passo 2.

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

Cada fonte tem um `status`: `ok`, `partial` ou `failed` (conector ausente, sem permissão, erro da API). Não invente dados da fonte que falhou.

- **Jira falhou, épico não encontrado ou nenhuma issue a triar:** encerre a triagem aqui e informe o motivo. Não há o que passar para a Láquesis.
- **Slack falhou em todos os canais:** siga só com o Jira, com `slack.messages: []`, e acrescente o aviso `slack-unavailable` em todas as issues.
- **Slack falhou em alguns canais:** `slack.status: partial`; siga com os canais que responderam e acrescente `slack-channel-unavailable:<canal>` em todas as issues, um por canal que falhou.

Uma fonte com `status: failed` e listas vazias é uma saída válida pelo contrato; não conta como campo faltando.

### Outras fontes

Hoje as fontes esperadas são o **Jira** (obrigatório: é dele que vêm as issues a triar) e o **Slack** (contexto). A Cloto pode monitorar outras fontes no futuro (ex.: PRs e issues do GitHub, alertas de observabilidade, wikis, e-mail), desde que cada nova fonte siga o mesmo padrão:

- um bloco próprio em `.moiras/sources.json`, com o que filtrar (pessoas, canais, repositórios, consultas);
- coleta disparada na mesma rodada paralela do Jira e do Slack;
- um bloco próprio na saída, com `status: ok | partial | failed` e listas vazias quando falhar;
- itens ligados às issues pelas chaves citadas (padrão `[A-Z][A-Z0-9]+-\d+`), entrando em `evidence` no formato de fonte;
- registro na memória com chave `<source>:<id>` e os mesmos `with_whom`/`content`.

Fonte não configurada é ignorada sem aviso. Enquanto uma nova fonte não estiver documentada nesta etapa, não a use.

## Interações (opcional)

Além de ler, a Cloto pode sinalizar nas próprias fontes que viu o item e ligar uma fonte à outra, com a menor ação possível. **Está desligada por padrão**: só vale com `interactions.enabled: true` em `.moiras/sources.json`.

Ações permitidas (e só estas):

| Fonte | Tipo | O que faz |
|---|---|---|
| Slack | `reaction` | reage com o emoji de `interactions.slack.reaction` (padrão `eyes`) nas mensagens coletadas que citam uma issue a triar: "vista pela triagem" |
| Jira | `comment` | comenta na issue, uma linha, que ela foi citada no Slack, com o link da mensagem |

Outras fontes que forem adicionadas ficam só de leitura: não há interação para elas.

Regras:

1. **Aprovação.** A Cloto nunca escreve sozinha: na saída ela só propõe, com `status: proposed`. A escrita acontece depois da Láquesis, quando a agência final de cada issue já é conhecida, e antes da Átropos. Nesse ponto, a skill mostra a lista de `interactions` (alvo, tipo, texto, link) ao usuário. O "sim" aplica exatamente aquela lista; o usuário pode tirar itens, e itens novos precisam de nova aprovação. Sem resposta ou com "não", nada é aplicado.
2. **Modo automático.** Sem perguntas, então só a reação, que é de baixo impacto, e só se `reaction` estiver em `interactions.auto_types` (padrão `["reaction"]`), é aplicada sem o "sim". O comentário no Jira nunca é aplicado no `--auto`, mesmo que apareça em `auto_types`: fica com `status: proposed` e aparece no relatório para o usuário aprovar depois. As regras 3 a 8 valem igual.
3. **Texto.** Uma linha em português, começando com `Moiras:`, por exemplo `Moiras: esta issue foi citada no Slack em 03/10 (<link>)`. Nada de texto bruto de issues ou conversas, segredos ou dados pessoais.
4. **Agência.** Issue com `agency` (do Jira ou do glossário, já resolvida pela Láquesis) nunca recebe comentário no Jira, porque ele pode ser visível a externos e o repasse à agência é um rascunho que o usuário envia. Para ela só vale a reação no Slack.
5. **Chaves liga/desliga.** `interactions.jira.comment: false` desliga a proposta de comentários no Jira; `interactions.slack.reaction` define o emoji, e, sem ele, o padrão é `eyes`.
6. **Sem repetir.** Antes de propor, consulte `query clotho --key interaction:<source>:<alvo>:<tipo>`; se já existe, pule. Depois de aplicar com sucesso, registre essa chave com `record clotho` (`content` = tipo, texto e link, que vira hash). Esses registros não contam para o `change` das issues.
7. **Falha.** Conector sem permissão de escrita ou erro da API: marque a interação como `failed`, acrescente o aviso `interaction-failed:<fonte>` e siga a triagem. Não tente de novo na mesma execução.
8. **Nunca**: editar ou apagar conteúdo, atribuir ou transicionar issue, criar issue, postar mensagem nova no Slack, nem qualquer ação fora da tabela acima.

## Saída

```json
{
  "collected_at": "2026-10-06T18:00:00-03:00",
  "jira": {
    "status": "ok | failed",
    "epic": { "key": "PROJ-100", "summary": "", "end_date": "2026-12-15", "end_date_source": "duedate | target | project_end" },
    "issues": [
      {
        "key": "PROJ-123",
        "summary": "",
        "description": "",
        "priority": "High",
        "status": "To Do",
        "duedate": "2026-11-30",
        "buffer_days": 15,
        "agency": "Agência Aurora | null",
        "change": "new | changed | unchanged",
        "warnings": []
      }
    ],
    "siblings": [
      { "key": "PROJ-187", "summary": "", "status": "Done", "assignee": "Fulano", "resolved_at": "2026-08-20" }
    ]
  },
  "slack": {
    "status": "ok | partial | failed",
    "channels": [
      { "id": "C0123456789", "name": "#proj-squad", "status": "ok", "messages": 12 },
      { "id": "C0987654321", "name": "#proj-support", "status": "failed", "messages": 0 }
    ],
    "period": { "from": "2026-09-29", "to": "2026-10-06" },
    "messages": [
      {
        "channel": "#proj-squad",
        "also_in": [],
        "author": "Fulano",
        "date": "2026-10-03T14:12:00-03:00",
        "text": "",
        "permalink": "",
        "cited_issues": ["PROJ-123"],
        "replies": [
          { "author": "Beltrana", "date": "2026-10-03T15:01:00-03:00", "text": "", "permalink": "" }
        ]
      }
    ],
    "without_issue": []
  },
  "interactions": [
    {
      "id": "slack:C0123456789:1696341120.000100:reaction",
      "source": "slack",
      "type": "reaction | comment",
      "target": "<permalink ou chave>",
      "content": "eyes | Moiras: ...",
      "status": "proposed | applied | skipped | failed"
    }
  ],
  "errors": []
}
```

## Memória

Depois da coleta, registre **cada interação** numa única chamada `record clotho`, um objeto por item:

```json
[
  {
    "key": "jira:PROJ-123",
    "run_id": "2026-10-06T11:00:00Z",
    "source": "jira",
    "with_whom": { "reporter": "Fulano", "updated_by": "Beltrana" },
    "updated_at": "2026-10-05T17:40:00-03:00",
    "content": { "summary": "", "description": "", "priority": "", "status": "", "duedate": "" }
  },
  {
    "key": "slack:C0123456789:1696341120.000100",
    "run_id": "2026-10-06T11:00:00Z",
    "source": "slack",
    "with_whom": { "author": "Fulano", "channel": "#proj-squad" },
    "updated_at": "2026-10-03T14:12:00-03:00",
    "content": { "text": "", "replies": ["<texto de cada resposta>"] }
  }
]
```

- `ts` (quando a Cloto viu o item) é preenchido pelo script; `content` vira `hash` e não é guardado.
- Inclua `agency` em `content` das issues só quando houver valor: assim as issues sem agência mantêm o hash de antes, e trocar a agência conta como `changed`.
- O retorno diz se cada item é `new`, `changed` ou `unchanged` desde a última execução. Copie isso para o campo `change` de cada issue em `jira.issues`. Uma issue também conta como `changed` se alguma mensagem do Slack que a cita for `new` ou `changed`.
- No modo automático (sem `--full`), só issues `new` ou `changed` seguem para a Láquesis. As demais aparecem no relatório como "sem mudança".

## Entrada da Láquesis

Com as duas coletas prontas, monte uma entrada da Láquesis por issue, na ordem do Jira:

- `key`, `summary`, `description`, `priority`, `agency`: do item de `jira.issues`.
- `evidence`: as mensagens do Slack cuja `cited_issues` contém a chave, **e cada resposta da thread** como fonte separada (`ref` = permalink, `excerpt` = texto, `verified_at` = data).
- `siblings`: `jira.siblings` sem a própria issue.
- `warnings`: os da issue (`no-due-date`, `exceeds-epic`) mais os da coleta (`slack-unavailable`).

Mensagens que não citam nenhuma issue ficam em `slack.without_issue`, como contexto geral.

O item completo de `jira.issues` (com `description`, `duedate` e `buffer_days`) fica guardado: ele é o `ticket` da entrada da Átropos.

A coleta é somente leitura. As únicas escritas possíveis são as interações opcionais acima (reação e comentário curto), aprovadas pelo usuário. Esta etapa nunca cria ou atribui issues, nem posta mensagens novas no Slack. Com `interactions` desligado, `interactions` na saída é `[]`.
