<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-wordmark-dark.svg">
    <img src="assets/logo-wordmark.svg" alt="Moiras: Cloto fia, Láquesis mede e Átropos corta" width="480">
  </picture>
</p>

# Moiras

Plugin para Claude que faz triagem de issues do Jira com Slack e um knowledge do time: coleta o que foi pedido, classifica cada issue e propõe soluções, com a decisão sempre nas mãos de quem trabalha no projeto.

```
Cloto (coleta Jira e Slack) → Láquesis (classifica, acha duplicados) → Átropos (veredito e de 3 a 5 soluções com % de confiança)
```

## Sumário

- [Instalação](#instalação)
- [Uso](#uso)
- [Segurança](#segurança)
- [Documentação](#documentação)
- [Desenvolvimento](#desenvolvimento)
- [Teste real das skills de knowledge](#teste-real-das-skills-de-knowledge)

## Instalação

```
/plugin marketplace add eitri-tech/eitri-shopping-project-moiras
/plugin install moiras@moiras
```

**Outros agentes** (Codex, Cursor, Copilot, opencode, Antigravity etc.): use o [`npx skills`](https://github.com/vercel-labs/skills), que copia ou liga as skills na pasta de cada agente.

```bash
npx skills add eitri-tech/eitri-shopping-project-moiras --list                      # lista as sete skills
npx skills add eitri-tech/eitri-shopping-project-moiras -a codex -s moiras-triage   # instala uma skill num agente
```

O `npx skills` copia só a pasta de cada skill: `scripts/memory.ts`, `scripts/knowledge.ts` e `scripts/config.ts` ficam em `plugins/moiras/scripts` e não vão junto. As skills chamam esses scripts por `${CLAUDE_PLUGIN_ROOT}`, variável que só o Claude Code define. Por isso, mantenha um clone do repositório e diga ao agente que `${CLAUDE_PLUGIN_ROOT}` é `<clone>/plugins/moiras`. Jira e Slack precisam de conectores no agente escolhido.

Precisa do Jira e do Slack conectados ao Claude (conectores do claude.ai ou servidores MCP próprios): o plugin não traz servidor MCP. Os scripts rodam em Node LTS, sem dependências.

## Uso

Rode `/moiras:moiras-init` no projeto onde vai rodar: ela pergunta o que falta (usa os conectores só para ler e propor, como os IDs do Slack), mostra o arquivo inteiro e cria o `.moiras/sources.json` depois do seu "sim". Nunca sobrescreve um existente, e você pode editar o arquivo à vontade; `/moiras:moiras-init --check` valida. Hoje Jira e Slack são o foco, mas o arquivo aceita blocos de outras fontes. Um exemplo enxuto, com os endereços (caminhos relativos à pasta que contém `.moiras/`; o modelo completo está em `plugins/moiras/config/sources.example.json`):

```json
{
  "jira": { "site": "example.atlassian.net", "epic": "PROJ-100", "project_end": "2026-12-15" },
  "slack": {
    "people": [{ "name": "Fulano", "id": "U0123456789" }],
    "channels": [{ "name": "#proj-squad", "id": "C0123456789" }]
  },
  "knowledge": [
    { "name": "local", "scope": "local", "dir": ".moiras/knowledge" },
    { "name": "team", "scope": "group", "repository": "git@github.com:<org>/team-knowledge.git", "dir": "../team-knowledge" }
  ],
  "index": {
    "repositories": [
      { "name": "acme-shop-checkout", "path": "../acme-shop-checkout", "url": "https://github.com/<org>/acme-shop-checkout", "owner": "Squad Checkout" }
    ]
  }
}
```

O escopo do Jira não precisa ser um épico só: `epics` aceita vários e `categories` filtra por campo, como `{ "field": "labels", "values": ["checkout"] }`; as duas valem juntas, em AND. `repository` é o remoto git do knowledge compartilhado (privado, criado do template) e `url` é o endereço do repositório de código; nenhum dos dois leva credencial. Agências, interações, auditores, memória e relatórios são opcionais; o exemplo completo está no arquivo. Depois:

| Comando | O que faz |
|---|---|
| `/moiras:moiras-init` | Cria o `.moiras/sources.json` conversando; nunca sobrescreve |
| `/moiras:moiras-triage PROJ-100 [PROJ-101]` | Tria as issues sem responsável dos épicos (ou do escopo da configuração: categorias). `--auto` roda sem perguntas (cron); `--full` reprocessa tudo |
| `/moiras:moiras-learn [PROJ-100] [--since AAAA-MM-DD]` | Aprende com as issues já concluídas do escopo: propõe soluções, padrões e decisões e grava no knowledge local só o que você aprovar |
| `/moiras:moiras-index` | Gera o glossário a partir do código. Só lê os repositórios; grava no knowledge local depois do seu "sim" |
| `/moiras:moiras-audit [glossary\|criteria\|learnings]` | Revisa o knowledge e aplica só os ajustes aprovados |
| `/moiras:moiras-sync <nome>` | Traz o que foi mergeado nos knowledges compartilhados |
| `/moiras:moiras-publish <nome>` | Abre um PR com o que é novo no knowledge local |

**Primeira vez**, nesta ordem:

1. `/moiras:moiras-init` (uma vez).
2. `/moiras:moiras-sync <nome>`, só se houver knowledge compartilhado (`repository` em `knowledge`). Rode antes do `moiras-learn`: ele só vê os knowledges que já estão no disco ao pular issues conhecidas e reservar ids.
3. `/moiras:moiras-index`.
4. `/moiras:moiras-learn`, opcional: só compensa se houver issues concluídas no histórico do escopo.
5. `/moiras:moiras-triage`.

O desfecho de uma solução escolhida também passa pela triagem: quando você informa o `result` na análise seguinte, só ele e a observação do registro mudam — a solução nunca é apagada nem reescrita.

Sem glossário nem critérios, a Láquesis usa categorias padrão (ou `unknown`), limita `confidence` a 0.3 e avisa `criteria-missing`: é esperado, não é erro.

Para o cron sem perguntas, o exemplo da linha com `--auto` (e as ferramentas a liberar em `--allowedTools`) está em [Execução por cron](plugins/moiras/README.md#execução-por-cron).

### Fluxo das skills

As setas indicam leitura ou escrita aprovada, não uma execução automática das sete skills.

Versão em diagrama:

```mermaid
classDiagram
  class Init["moiras-init"]
  class Index["moiras-index"]
  class Learn["moiras-learn"]
  class Triage["moiras-triage"]
  class Audit["moiras-audit"]
  class Publish["moiras-publish"]
  class Sync["moiras-sync"]
  class Config[".moiras/sources.json"]
  class Glossary["glossary/"]
  class Learnings["learnings/"]
  class Criteria["criteria/"]
  class Local["Knowledge local"]
  <<skill>> Init
  <<skill>> Index
  <<skill>> Learn
  <<skill>> Triage
  <<skill>> Audit
  <<skill>> Publish
  <<skill>> Sync
  <<knowledge>> Local
  <<knowledge>> Glossary
  <<knowledge>> Learnings
  <<knowledge>> Criteria
  Init ..> Config : cria após aprovação integral
  Index ..> Glossary : escreve após aprovação da lista exata
  Learn ..> Learnings : importa histórico após aprovação da lista exata
  Triage ..> Learnings : grava após escolha ou aprovação
  Triage ..> Criteria : regenera após aprovação
  Audit ..> Learnings : ajusta result e observação após aprovação
  Audit ..> Criteria : regenera com replaces após aprovação
  Local *-- Glossary : contém
  Local *-- Learnings : contém
  Local *-- Criteria : contém
  Triage ..> Local : lê
  Publish ..> Local : lê seleção aprovada
  note for Init "Cria também .moiras/.gitignore sem sobrescrever"
  note for Index "Só lê código; única autora de glossary/"
  note for Local "Precedência em conflitos: local > project > group > global<br/>Escrita local só no interativo e com aprovação"
  note for Sync "Avança clones compartilhados para leitura; não altera o knowledge local"
```

```mermaid
sequenceDiagram
  participant U as Usuário
  participant P as moiras-publish
  participant K as Knowledge local
  participant R as Compartilhado privado
  participant H as Revisores humanos
  participant S as moiras-sync
  U->>P: Solicitar publicação interativa
  Note over P,R: Destino privado — clone limpo e sincronizado — plan e check
  P->>K: Ler seleção de registros locais
  P-->>U: Apresentar lista exata
  U->>P: Aprovar lista exata
  Note over P: Worktree temporário — branch novo — check antes do envio
  P->>R: Enviar branch novo e abrir PR
  H->>R: Revisar e fazer merge
  U->>S: Solicitar sincronização
  Note over R,S: Clone limpo na branch padrão, sem commits locais ou divergência
  S->>R: git fetch
  S->>S: git merge --ff-only no clone
  Note over K,S: Clones para leitura junto com o local — local permanece intacto
```

```text
[moiras-init] -- "sim" ao arquivo inteiro --> [.moiras/sources.json]
                                             | configuração das outras skills
[Código: só leitura] --> [moiras-index] -- "sim" --> [local: glossary/]
[Jira: concluídas] ----> [moiras-learn] -- "sim" --> [local: learnings/]
[moiras-triage] -- escolha / "sim" ---------------> [local: learnings/, criteria/]
[moiras-audit] -- "sim" --> [local: ajustes em learnings/; regeneração em criteria/]

Leitura do knowledge: local > project > group > global (mais específico vence)
                     glossary/ só é gerado por moiras-index

[Knowledge local] --> [moiras-publish] -- check + "sim" --> [Branch novo + PR]
[Compartilhado privado, após merge humano] --> [moiras-sync] --> [Clones para leitura]
```

### Pipeline da triagem

Resumo dos contratos; os campos completos e as condições estão nos
[stages](plugins/moiras/skills/moiras-triage/stages/).

Versão em diagrama:

```mermaid
sequenceDiagram
  participant T as moiras-triage
  participant C as Cloto
  participant F as Fontes configuradas
  participant L as Láquesis
  participant A as Átropos
  participant K as Knowledge local
  T->>C: Configuração e escopo
  Note over T,C: input: configuração e escopo — output: coleta, interactions, collected_at, errors
  par Fonte de issues obrigatória
    C->>F: Ler issues pendentes sem responsável e siblings na fonte de issues
  and Demais fontes configuradas
    C->>F: Ler contexto conforme configuração e contrato da fonte
  end
  F-->>C: Issues, evidências e avisos
  Note over C,F: Fonte de issues falhou ou nenhuma issue: encerra — demais fontes indisponíveis: segue com aviso
  C-->>T: Coleta para montar entradas por issue
  T->>L: Resolver agency de todas as issues antes do filtro incremental
  T->>L: Classificar cada issue selecionada na ordem da Cloto
  L->>K: Ler glossário, critérios e aprendizados
  Note over T,L: input: issue, evidence, siblings, warnings — output: classificação, duplicates, agency, sources, warnings
  L-->>T: Classificação validada
  opt interactions.enabled: true — desligado por padrão
    alt Interativo com sim à lista exata
      T->>F: Aplicar interações aprovadas da Cloto
    else --auto com reaction em interactions.auto_types
      T->>F: Aplicar só reaction autorizada
    end
    Note over T,F: comment nunca no --auto, nem com agency ou agency-ambiguous — fontes sem interação prevista só leitura
  end
  T->>A: ticket completo, classification e precedents
  Note over T,A: input: ticket, classification, precedents — output: key, action, duplicate_of, agency, justification, solutions, criteria_suggestions, warnings
  A-->>T: Veredito e soluções com fontes
  Note over T,A: Validar cada output antes de avançar — contrato inválido interrompe a issue — warnings se acumulam
```

```mermaid
sequenceDiagram
  participant U as Usuário
  participant T as moiras-triage
  participant A as Átropos
  participant K as Knowledge local
  Note over T,A: Critérios do time podem refinar as ações — sem critério aplicável: criteria-missing
  alt similarity >= 0.8 e relation: same-incident
    A-->>T: duplicate com duplicate_of obrigatório
  else Dependência externa com evidência
    A-->>T: blocked
  else Descrição e critérios claros, confidence >= 0.8, sem bloqueio
    A-->>T: ready-for-dev
  else Baixa confiança, origin: unknown, falta reprodução ou dúvida
    A-->>T: needs-info
  else Evidência explícita de que não se aplica mais
    A-->>T: close
  end
  Note over A: Normalmente 3 a 5 soluções com confiança — duplicate e close podem não ter soluções
  alt Interativo
    T-->>U: Apresentar justificativa, fontes e soluções
    opt Escolha de solução
      U->>T: Escolher solução
      T->>K: Gravar em learnings/solutions/ — none não grava
    end
    opt Sim a padrões, decisões ou critérios
      U->>T: Aprovar registros
      T->>K: Gravar em learnings/ ou regenerar criteria/ com replaces
    end
    opt Agência e pedido de repasse
      T-->>U: Entregar rascunho para o usuário enviar
    end
  else --auto
    T->>T: Salvar relatório e pendências em runs.dir — sem escrita no knowledge
  end
  Note over T,U: Saídas completas também são salvas no interativo quando há veredito ou escolha pendente
```

```text
[moiras-triage: configuração + escopo]
  |
  v
[Cloto / clotho]
  +--> [Jira: pendentes sem responsável + siblings] --+
  +--> [demais fontes configuradas: mensagens + respostas das threads] ----+ em paralelo
  output: jira, slack, interactions, collected_at, errors
  v
[Láquesis / lachesis]
  input: issue + evidence + siblings + warnings (inclui agency)
  output: repositories, component, category, origin, confidence,
          duplicates, agency, sources, warnings, glossary_suggestions, key, complex
  |
  v
[Interações opcionais da Cloto, desligadas por padrão]
  interativo: "sim" à lista exata; --auto: só reaction autorizada
  comment: nunca no --auto, nem com agência ou agência ambígua
  |
  v
[Átropos / atropos]
  input: ticket completo da Cloto + classification + precedents
  output: key, action, duplicate_of, agency, justification, solutions,
          criteria_suggestions, warnings
  action: duplicate | blocked | ready-for-dev | needs-info | close
  |
  +--> [Interativo: escolha de solução] --> [local: learnings/solutions/]
  |    ["sim" a padrões/decisões ou critérios] --> [local: learnings/ ou criteria/]
  +--> [--auto: relatório + escolhas pendentes; sem escrita no knowledge]
```

Valide cada saída antes de avançar: contrato inválido interrompe aquela issue.
Jira falhou ou não há issues a triar: encerra; Slack indisponível: segue com aviso.
No `--auto`, só pule `unchanged` com conclusão válida comprovada para a entrada e o
knowledge atuais; `--full` reprocessa tudo. `none` não gera aprendizado.

## Segurança

- Só lê e sugere no Jira e no Slack; nada é escrito sem o "sim" à lista exata. A exceção são as interações opcionais da Cloto (reação no Slack, comentário curto no Jira), desligadas por padrão (`interactions.enabled`). Com elas ligadas, só a reação autorizada em `interactions.auto_types` roda no `--auto` sem o "sim"; comentário sempre pede aprovação.
- O knowledge fica fora deste repositório: local (`.moiras/knowledge/`, fora do git) ou em repositórios privados criados a partir de um template público. Nunca guarda cópia de código nem segredos.
- A memória das etapas é local, só de acréscimo, e guarda hash e metadados, nunca o texto bruto.
- `moiras-publish` sempre abre PR num branch novo: nunca faz push na principal, `force push` nem merge.

## Documentação

- [`plugins/moiras`](plugins/moiras): fluxo, knowledge, configuração, execução por cron e memória.

## Desenvolvimento

Ambiente: `nix develop` (ou `direnv allow`) entra num shell com Node, TypeScript, Python 3 e jq fixados pelo `flake.lock`. Sem Nix, instale `git`, `curl` e `jq` (`sudo apt install -y git curl jq`), o [nvm](https://github.com/nvm-sh/nvm) e rode `nvm install && nvm use` (lê o `.nvmrc`). O Node executa os `.ts` direto, sem build.

Checagens:

```bash
node --test plugins/moiras/scripts/*.test.ts   # testes de memória e de knowledge (node:test)
tsc -p tsconfig.json                           # tipos; no Nix já vem pronto
claude plugin validate plugins/moiras && claude plugin validate .
```

Sem Nix, o `tsc` precisa dos tipos do Node (`.direnv/` está no `.gitignore`):

```bash
mkdir -p .direnv/types/node
tmp=$(mktemp -d) && npm pack @types/node@24 --pack-destination "$tmp" --silent
tar -xzf "$tmp"/types-node-*.tgz -C .direnv/types/node --strip-components=1
npx -y -p typescript tsc -p tsconfig.json
```

Testar o plugin: `claude --plugin-dir plugins/moiras`; depois de editar arquivos, `/reload-plugins`. O script de memória também roda na mão; use uma pasta temporária para não gravar no projeto:

```bash
S=$PWD/plugins/moiras/scripts/memory.ts; cd "$(mktemp -d)"
echo '{"key":"jira:PROJ-1","content":{"a":1}}' | node $S record clotho   # change: new
node $S query clotho                                                  # último registro de cada chave
```

Onde mexer:

| O que | Onde |
|---|---|
| Contratos e regras de cada etapa | `plugins/moiras/skills/moiras-triage/stages/*.md` |
| Orquestração, modos e leitura e escrita do knowledge | `plugins/moiras/skills/moiras-triage/SKILL.md` |
| Configuração, aprendizado do histórico, auditoria, indexação, sincronização e publicação | `plugins/moiras/skills/moiras-{init,learn,audit,index,sync,publish}/SKILL.md` |
| Memória das etapas | `plugins/moiras/scripts/memory.ts` |
| Regras dos registros do knowledge (`hash`, `check`, `issues`, `plan`) | `plugins/moiras/scripts/knowledge.ts` |
| Criação e validação da configuração | `plugins/moiras/scripts/config.ts` |
| Modelo de configuração | `plugins/moiras/config/sources.example.json` |

Fluxo: branch a partir da `main`, checagens, commits em inglês no imperativo (`Add ...`, `Fix ...`) e PR com título curto e descrição curta em português (o que muda e como testar). Não use dados reais da empresa em nenhum arquivo: os exemplos são fictícios (empresa Acme, `acme-shop-checkout`, `PROJ-123`).

## Teste real das skills de knowledge

Roteiro para validar `moiras-index`, `moiras-audit`, `moiras-sync` e `moiras-publish` num projeto de verdade. Quase tudo escreve só em `.moiras/` (fora do git). As exceções são o arquivo temporário do passo 4 e o clone do knowledge do passo 6; só o passo 7 escreve no remoto, abrindo um PR.

1. Crie uma pasta de teste fora do repositório (ex.: `~/moiras-teste`) e rode `/moiras:moiras-init` (ou crie à mão um `.moiras/sources.json` mínimo; os caminhos são relativos à pasta que contém `.moiras/`). Comece com um repositório:

   ```json
   {
     "knowledge": [{ "name": "local", "scope": "local", "dir": ".moiras/knowledge" }],
     "index": { "repositories": [{ "name": "acme-shop-checkout", "path": "../acme-shop-checkout" }] }
   }
   ```

2. Abra o Claude nela com `claude --plugin-dir <clone>/plugins/moiras`; o `/help` lista as sete skills.
3. **Indexe** com `/moiras:moiras-index` (nada é gravado antes do "sim"). Confira com `node <clone>/plugins/moiras/scripts/knowledge.ts check .moiras/knowledge`: sem achados, `url` sem credencial, `local_path` relativo, nenhum trecho de código e `indexed_commit` e `indexed_commit_date` (em UTC) conferindo com `git -C <repositório> log -1`, e `indexed_dirty` com `git -C <repositório> status --porcelain`.
4. **Reindexe**: sem mudanças, volta `unchanged`; com um commit novo que não mexe nas evidências, continua `unchanged` e o relatório só informa o commit atual. Para ver `changed`, crie um arquivo em `src/` do repositório, rode de novo, **responda "não" à gravação** e apague o arquivo. Prefira um clone descartável se o repositório tiver alterações suas.
5. **Audite** com `/moiras:moiras-audit glossary`: sem achados graves. Para ver o aviso de glossário velho, copie o arquivo, ponha um `indexed_at` de mais de 6 meses e rode de novo (ela só sugere `moiras-index`); **restaure a cópia antes do passo 7**.
6. **Sincronize**: acrescente em `knowledge` um item `{ "name": "team", "scope": "project", "repository": "<url-do-knowledge-privado>", "dir": "../moiras-knowledge-team" }` e rode `/moiras:moiras-sync team`. Ela pergunta antes de clonar; clone sujo ou divergente a faz parar.
7. **Publique** com `/moiras:moiras-publish team`: ela confere que o destino é o `repository` configurado e é privado, mostra a lista exata, copia só depois do "sim" e abre o PR do branch `moiras/index-<AAAA-MM-DD>` com o `gh` (sem ele, para e explica). Feche o PR e apague o branch se não quiser manter o glossário de teste.
8. **Triagem** (opcional): com Jira e Slack conectados, rode `/moiras:moiras-triage` e confira se a Láquesis cita `knowledge:local/glossary/...`.

Anote onde a skill perguntou o que a documentação não prevê, campos do glossário errados ou inventados e mensagens de erro, sem colar conteúdo de repositório ou de issue. Limpeza: apague a pasta de teste e o clone do knowledge.
