# Cloto — coleta

Fia a matéria-prima da triagem: busca, **em paralelo**, as issues pendentes do escopo no Jira (um ou vários épicos e categorias, ou uma consulta própria) e as conversas relevantes no Slack.

**Entrada:** configuração em `.moiras/sources.json` no diretório do projeto (modelo em `${CLAUDE_PLUGIN_ROOT}/config/sources.example.json`). Se o usuário informar na conversa um ou mais épicos, eles substituem os épicos da configuração (`jira.epic` e `jira.epics`); as categorias da configuração continuam valendo. Com `jira.jql` configurada, os épicos informados mudam a execução para o modo épicos (a `jira.jql` é ignorada nela) e a skill avisa isso ao usuário. Sem `.moiras/sources.json`: no modo interativo, ofereça a skill `moiras-init` (ela cria o arquivo); no `--auto`, encerre com erro no relatório.

## Execução

Dispare as duas buscas **na mesma rodada de chamadas de ferramenta**, sem esperar uma terminar para começar a outra.

### A. Jira

0. Monte o **escopo**. Há dois modos, que **não se misturam**: ou a configuração traz épicos e/ou categorias, ou traz só uma consulta própria (`jira.jql`). Os dois juntos são recusados pelo `config.ts` (`scope-conflict`); se aparecerem mesmo assim, não escolha por conta própria: encerre pedindo ao usuário que deixe um dos modos.

   **Modo épicos e categorias** (`jira.epics`, `jira.epic`, `jira.categories`): as partes presentes valem juntas (AND), então a categoria estreita os épicos.

   | Parte | Configuração | Vira |
   |---|---|---|
   | Épicos | `jira.epics` (lista) e `jira.epic` (um só), unidos sem repetir | `parent in (<EPIC1>, <EPIC2>)` |
   | Categorias | `jira.categories`, cada item com `field` e `values` | uma cláusula por item: `"<field>" in ("<v1>", "<v2>")`; os valores de um item são alternativas (OR) e os itens entre si são AND |

   O nome do campo vai sempre entre aspas (`"Story Points"`, `"labels"`). Id de campo no formato REST (`customfield_10020`) vira `cf[10020]`, que é a forma de JQL e **não leva aspas**; `cf[10020]` informado assim vale como está. Em projetos que ainda usam o campo antigo de épico, troque `parent in (...)` por `"Epic Link" in (...)`. Sem épicos, a busca vale para o site todo: inclua `project` em uma categoria (`{ "field": "project", "values": ["PROJ"] }`).

   **Modo consulta própria** (`jira.jql`): o escopo é exatamente `(<jql>)`, entre parênteses, sem épicos nem categorias. Por isso o `config.ts check` recusa (`jql-unbalanced`) consulta com parêntese ou aspas sem fechar: ela sairia do embrulho, e os filtros da Cloto valeriam só para uma parte dela. A consulta é só leitura (uma busca) e a Cloto é a dona do `ORDER BY`; use-a como veio, sem reescrever. A Cloto já acrescenta `assignee IS EMPTY AND statusCategory != Done` (passo 2): a consulta não precisa repetir esses filtros e não deve contradizê-los: um filtro de responsável (`assignee = X`, `assignee != X`, `assignee IN (...)`) ou de categoria de estado concluída (`statusCategory = Done`) deixa a busca vazia (o nome de um status, como `status = Done`, não prova a categoria dele e não entra no aviso). Antes de buscar, rode `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.ts" check <base>/.moiras/sources.json` (só leitura) e guarde os avisos `jql-assignee-contradicts` e `jql-state-contradicts`, se houver; os outros achados do `check` não mudam a coleta. O `check` avisa dos casos que reconhece, mas só lê uma sequência simples de `AND`: consulta com `OR`, `NOT` ou parênteses de agrupamento fica sem aviso. É só um aviso e não impede a coleta. Se o Jira recusar a consulta, é falha da fonte (`status: failed`, erro `jql-invalid`): informe o motivo e encerre, sem tentar uma variação. Inclua `project` na consulta; sem ele a busca vale para o site todo.

1. Leia as datas fim dos épicos, numa só chamada (`key in (...)`) quando o conector permitir: `duedate` ou, se vazio, o campo de data alvo do épico. No modo épicos, são os épicos configurados; no modo consulta própria, ou para um épico que uma categoria trouxe sem estar configurado, depende das issues, então leia depois do passo 2, com os épicos distintos que elas citam (já resolvidos como acima) e ainda não foram lidos. Sem data no épico, vale `jira.project_end`. Épico configurado que o Jira não devolve: aviso `epic-not-found:<KEY>` em todas as issues e a coleta segue com os outros; no modo épicos, sem nenhum épico encontrado e sem categorias, é o caso de "épico não encontrado" em **Falhas**. No modo consulta própria, issue sem épico é normal: segue com `epic: null` e `project_end`.
2. Busque as issues do escopo sem responsável e não concluídas:

   ```
   <ESCOPO> AND assignee IS EMPTY AND statusCategory != Done
   ORDER BY priority DESC, duedate ASC
   ```

   Peça também o pai de cada issue (`parent` ou, nos projetos antigos, `"Epic Link"`) com o tipo dele. O `epic` da issue é o pai **só quando o tipo do pai é Epic**; numa subtarefa o pai é a tarefa ou história, então use o pai dela, também só se o tipo for Epic, ou, se o conector não o der ou o tipo for outro, `null`. Issue sem épico tem `epic: null`.

   Se `jira.agency_field` estiver configurado, peça também esse campo (nome ou id; texto, opção ou etiqueta) na mesma busca. O valor vira `agency` da issue; campo vazio ou não configurado é `null`, sem aviso: a agência é opcional.
   Peça também `created` de cada issue e exponha como `created_at` (timestamp ISO 8601 com fuso, sem truncar para dia). Se indisponível, use `null` e o aviso `creation-date-unavailable`.
3. Para cada issue, calcule `buffer_days` = data fim − `duedate` da issue. A data fim é a do **épico da própria issue** (`epic`), lida no passo 1; issue sem épico, ou cujo épico não pôde ser lido, usa `jira.project_end`. Sem nenhuma das duas, `buffer_days = null` e o aviso `no-end-date`.
   - `duedate` vazio: `buffer_days = null`, com o aviso `no-due-date`.
   - `duedate` depois da data fim: aviso `exceeds-epic` (o nome fica, mesmo quando a data fim é a do projeto).

A ordem final segue a do Jira (prioridade, depois data fim). Issues com `exceeds-epic` sobem dentro da mesma prioridade.

4. Na mesma rodada, busque **todas** as issues do escopo, de qualquer status e responsável, só com chave, resumo, status, responsável e data de resolução: `<ESCOPO> ORDER BY key`. Exponha a resolução como `resolved_at` (timestamp ISO 8601 com fuso; `null` se não resolvida ou indisponível). Elas formam `jira.siblings`, usadas pela Láquesis na busca de duplicados. As issues a triar continuam sendo só as do passo 2. Com vários épicos, `siblings` reúne os de todos eles, então a Láquesis também acha duplicado entre épicos.

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

- **Jira falhou, modo épicos sem nenhum épico encontrado (e sem categorias), consulta própria recusada ou nenhuma issue a triar:** encerre a triagem aqui e informe o motivo. Não há o que passar para a Láquesis. Na consulta própria sem issue a triar, se o `config.ts check` avisou `jql-assignee-contradicts` ou `jql-state-contradicts`, cite o aviso no motivo (no `--auto`, no relatório): a consulta pode ser a causa, e quem a escreveu deve revisá-la.
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
4. **Agência.** Issue com `agency` (do Jira ou do glossário, já resolvida pela Láquesis) ou com o aviso `agency-ambiguous` (a agência não pôde ser definida, então a issue é tratada como se tivesse agência) nunca recebe comentário no Jira, porque ele pode ser visível a externos e o repasse à agência é um rascunho que o usuário envia. Para ela só vale a reação no Slack.
5. **Chaves liga/desliga.** `interactions.jira.comment: false` desliga a proposta de comentários no Jira; `interactions.slack.reaction` define o emoji, e, sem ele, o padrão é `eyes`.
6. **Sem repetir.** Antes de propor, consulte `query clotho --key interaction:<id>`, com o `id` da interação na saída e o prefixo `interaction:` (ex.: `interaction:slack:C0123456789:1696341120.000100:reaction`); se já existe, pule. Depois de aplicar com sucesso, registre essa chave com `record clotho` (`content` = tipo, texto e link, que vira hash). Esses registros não contam para o `change` das issues.
7. **Falha.** Conector sem permissão de escrita ou erro da API: marque a interação como `failed`, acrescente o aviso `interaction-failed:<fonte>` e siga a triagem. Não tente de novo na mesma execução.
8. **Nunca**: editar ou apagar conteúdo, atribuir ou transicionar issue, criar issue, postar mensagem nova no Slack, nem qualquer ação fora da tabela acima.

## Saída

```json
{
  "collected_at": "2026-10-06T18:00:00-03:00",
  "jira": {
    "status": "ok | failed",
    "scope": ["epics", "categories"],
    "epics": [
      { "key": "PROJ-100", "summary": "", "end_date": "2026-12-15", "end_date_source": "duedate | target | project_end" }
    ],
    "issues": [
      {
        "key": "PROJ-123",
        "summary": "",
        "description": "",
        "created_at": "2026-10-01T10:00:00Z",
        "epic": "PROJ-100 | null",
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
      { "key": "PROJ-187", "summary": "", "status": "Done", "assignee": "Fulano", "resolved_at": "2026-08-20T15:00:00Z" }
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

Depois da coleta, registre **cada item coletado** numa única chamada `record clotho`, um objeto por item (cada issue e cada mensagem):

```json
[
  {
    "key": "jira:PROJ-123",
    "run_id": "2026-10-06T11:00:00Z",
    "source": "jira",
    "with_whom": { "reporter": "Fulano", "updated_by": "Beltrana" },
    "updated_at": "2026-10-05T17:40:00-03:00",
    "content": { "summary": "", "description": "", "created_at": "2026-10-01T10:00:00Z", "priority": "", "status": "", "duedate": "" }
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
- Inclua `agency` em `content` das issues só quando houver valor: trocar a agência conta como `changed`. A inclusão de `created_at` provoca uma única mudança de hash nos registros antigos, mesmo sem agência.
- O retorno diz se cada item é `new`, `changed` ou `unchanged` desde a última execução. Copie isso para o campo `change` de cada issue em `jira.issues`. Uma issue também conta como `changed` se alguma mensagem do Slack que a cita for `new` ou `changed`.
- No modo automático (sem `--full`), issues `new` ou `changed` seguem para a Láquesis. Uma `unchanged` só pode ser pulada com conclusão comprovada em relatório completo para o mesmo `ticket` (sem `change`), a mesma entrada da Láquesis e o mesmo `knowledge_fingerprint` (ver `SKILL.md`). Sem essa prova, inclusive após falha de contrato ou mudança no knowledge ou em `siblings`, tente novamente e mantenha `change: unchanged`: coleta e conclusão são coisas distintas.
- Cada interação aplicada tem registro próprio, consultável pela regra 6: a chave é `interaction:` + o `id` da interação na saída (ex.: `interaction:slack:C0123456789:1696341120.000100:reaction`), com `content` = tipo, texto e link. Os registros desta seção são dos itens coletados, não das interações.

## Entrada da Láquesis

Antes do filtro incremental descrito acima, a skill resolve os repositórios no glossário atual e recalcula a agência de todas as issues coletadas pela seção 3 da Láquesis, inclusive `unchanged`. Esse passo obrigatório não depende do hash de Jira/Slack nem do cache da classificação. O filtro limita apenas a classificação completa e o veredito; as interações e o relatório sempre usam a agência e os avisos atuais.

Com as duas coletas prontas, monte uma entrada da Láquesis por issue, na ordem do Jira:

- `key`, `summary`, `description`, `created_at`, `epic`, `priority`, `agency`: do item de `jira.issues`.
- `evidence`: as mensagens do Slack cuja `cited_issues` contém a chave, **e cada resposta da thread** como fonte separada (`ref` = permalink, `excerpt` = texto, `verified_at` = data).
- `siblings`: `jira.siblings` sem a própria issue.
- `warnings`: os da issue (`no-due-date`, `no-end-date`, `exceeds-epic`, `creation-date-unavailable`) mais os da coleta (`slack-unavailable`, `epic-not-found:<KEY>`).

Mensagens que não citam nenhuma issue ficam em `slack.without_issue`, como contexto geral.

O item completo de `jira.issues` (com `description`, `duedate` e `buffer_days`) fica guardado: ele é o `ticket` da entrada da Átropos.

A coleta é somente leitura. As únicas escritas possíveis são as interações opcionais acima (reação e comentário curto), aprovadas pelo usuário. Esta etapa nunca cria ou atribui issues, nem posta mensagens novas no Slack. Com `interactions` desligado, `interactions` na saída é `[]`.
