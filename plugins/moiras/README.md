# Moiras

Plugin para Claude que faz triagem de issues do Jira usando um knowledge do time.

O nome vem das Moiras: *moira* significa "quinhão", a parte atribuída a cada um, e cada etapa da triagem leva o nome de uma delas:

- **Cloto** (fia): coleta, em paralelo, as issues sem responsável do épico no Jira e as conversas do Slack (hoje as fontes esperadas; outras podem ser adicionadas)
- **Láquesis** (mede): identifica repositório e componente pelo glossário, classifica e avalia duplicados
- **Átropos** (corta): justifica o problema, sugere de 3 a 5 soluções com % de confiança e guarda a escolhida no aprendizado; se a task é gerida por uma agência, oferece um rascunho para repassar a solução a ela

## Estrutura

```
moiras/
├── .claude-plugin/plugin.json      # manifesto
├── scripts/memory.ts               # memória das etapas (hash + JSONL)
├── scripts/knowledge.ts            # hash das fontes, checagem e plano de publicação do knowledge
├── config/sources.example.json     # modelo de .moiras/sources.json
└── skills/
    ├── moiras-triage/
    │   ├── SKILL.md                # orquestra as três etapas e define o knowledge
    │   └── stages/
    │       ├── clotho.md           # coleta
    │       ├── lachesis.md         # classificação
    │       └── atropos.md          # veredito
    ├── moiras-index/
    │   └── SKILL.md                # glossário derivado do código
    ├── moiras-sync/
    │   └── SKILL.md                # traz o que foi mergeado nos knowledges compartilhados
    ├── moiras-publish/
    │   └── SKILL.md                # leva o knowledge local a um compartilhado, por PR
    └── moiras-audit/
        └── SKILL.md                # auditoria e ajustes do knowledge
```

## Knowledge

O knowledge não vem no plugin: é o que o time sabe e não está no código (glossário de repositórios, critérios e aprendizado). Ele nunca tem cópia de código.

- **Local** (padrão): `.moiras/knowledge/` no projeto, fora do git. É onde as Moiras escrevem.
- **Compartilhado**: repositórios privados criados a partir do template público de knowledge, com escopo `project`, `group` ou `global`. Na leitura, o mais específico vence (`local` > `project` > `group` > `global`).

Todos têm a mesma estrutura: `glossary/`, `criteria/` e `learnings/{solutions,patterns,decisions}/`, um arquivo Markdown por registro. Sem glossário nem critérios, a Láquesis pode usar categorias padrão quando houver evidência; usa `unknown` quando ela não basta. Em ambos os casos, `confidence` ≤ 0.3 e aviso `criteria-missing`. Detalhes em `skills/moiras-triage/SKILL.md`.

Como o knowledge circula:

1. `moiras-index` gera o glossário a partir do código e grava em `glossary/` do knowledge local, depois do seu "sim".
2. `moiras-sync` (opcional) avança os clones dos knowledges compartilhados, sem enviar nada.
3. A triagem e a auditoria escrevem no knowledge local.
4. `moiras-publish` abre um PR num knowledge compartilhado com o que é novo; quem revisa o repositório faz o merge. Antes, cada registro passa em `scripts/knowledge.ts check` (sem segredos, caminhos pessoais ou código acima de 20 linhas).

Para revisar o knowledge fora de uma triagem, use a skill `moiras-audit`: ela aponta registros velhos, pendentes, conflitantes ou fora das regras e aplica cada ajuste só depois do "sim" de quem audita, do mesmo jeito que o usuário avalia no fim da triagem.

## Configuração

Copie `config/sources.example.json` para `.moiras/sources.json` no projeto onde vai rodar a triagem e preencha:

- `jira`: site, épico e data fim do projeto; opcionalmente `agency_field`, o campo do Jira que diz qual agência cuida da task; sem valor nele, usa-se `agency` do glossário, recalculado inclusive para issues `unchanged`;
- `agencies` (opcional): as agências, com o `name` igual ao valor do campo e, se quiser, um `channel` sugerido para o repasse que só o usuário envia; o plugin apenas prepara o rascunho;
- `slack`: pessoas e canais (quantos precisar; cada canal pode ter pessoas próprias), com os IDs `U…` e `C…`;
- `interactions` (opcional, desligado por padrão): deixa a Cloto reagir no Slack (emoji `slack.reaction`) e comentar no Jira que a issue foi citada, sempre depois do seu "sim" à lista; no `--auto` só as reações (`auto_types`) são aplicadas sem perguntar, e o comentário fica no relatório; comentários nunca vão para issues com agência ou agência ambígua;
- `index` (opcional): onde estão os repositórios para o `moiras-index`: `roots` (pastas com repositórios dentro) e `repositories` (`name`, `path` e, se quiser, `url`, `owner`, `agency`, `platform`, que valem mais que o detectado);
- `audit` (opcional): `auditors`, a lista de pseudônimos não identificáveis escolhidos pelas pessoas que podem fazer ajustes no knowledge pela skill `moiras-audit`; sem a chave, qualquer pessoa pode auditar;
- `knowledge`: os knowledges (`name`, `scope`, `dir` e, se compartilhado, `repository`); sem nenhum, vale só `.moiras/knowledge/`;
- `memory.dir` e `runs.dir`: onde ficam a memória e os relatórios (padrão `.moiras/memory/` e `.moiras/runs/`).

O Jira e o Slack precisam estar conectados ao Claude (conectores do claude.ai ou servidores MCP próprios); o plugin não traz servidor MCP.

## Execução por cron

No modo `--auto` a skill não faz perguntas, processa o que mudou (incluindo o knowledge), repete issues sem conclusão comprovada e salva o relatório em `.moiras/runs/`. Exemplo (dias úteis às 8h):

```
0 8 * * 1-5 cd /caminho/do/projeto && claude -p "/moiras:moiras-triage PROJ-100 --auto" --allowedTools "Read,Write,Bash(node:*),<ferramentas do Jira e do Slack>" >> .moiras/cron.log 2>&1
```

Liste em `--allowedTools` as ferramentas dos conectores de Jira e Slack que a coleta usa; sem isso a execução sem terminal fica bloqueada esperando permissão.

Para sincronizar o knowledge antes da triagem, rode `/moiras:moiras-sync --auto` antes (ela só avança clones que já existem) e libere em `--allowedTools` os comandos `git status`, `git fetch`, `git merge --ff-only` e os de leitura que ela usa. `moiras-index`, `moiras-publish` e `moiras-audit` não rodam em `--auto`.

## Memória

Cada etapa grava uma memória só de acréscimo em `.moiras/memory/<stage>.jsonl`, pelo script `scripts/memory.ts` (Node LTS mais recente, sem dependências): quando, com quem e o hash SHA-256 do conteúdo, nunca o texto bruto. A Cloto usa isso para saber o que é novo ou mudou, a Láquesis para reaproveitar classificações e a Átropos para guardar vereditos e escolhas pendentes. A memória é local e nunca vai para um knowledge.

## Instalação

```
/plugin marketplace add <owner>/<repo>
/plugin install moiras@moiras
```

Para testar localmente: `claude --plugin-dir plugins/moiras`.
