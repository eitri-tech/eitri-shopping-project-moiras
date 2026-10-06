# Moiras

Plugin para Claude que faz triagem de issues do Jira usando uma base de conhecimento do projeto.

O nome vem das Moiras: *moira* significa "quinhão", a parte atribuída a cada um, e cada etapa da triagem leva o nome de uma delas:

- **Cloto** (fia): coleta, em paralelo, as issues sem responsável do épico no Jira e as conversas do Slack (hoje as fontes esperadas; outras podem ser adicionadas)
- **Láquesis** (mede): identifica repositório e componente pelo glossário, classifica e avalia duplicados
- **Átropos** (corta): justifica o problema, sugere até 3 soluções com % de confiança e anota a escolhida em `.moiras/solucoes.md`

## Estrutura

```
moiras/
├── .claude-plugin/plugin.json      # manifesto
├── scripts/memoria.mjs             # memória das etapas (hash + JSONL)
├── config/sources.example.json     # modelo de .moiras/sources.json (épico, pessoas, canais)
├── skills/
│   └── moiras-triage/
│       ├── SKILL.md                # orquestra as três etapas, em ordem
│       └── stages/
│           ├── clotho.md           # ingestão
│           ├── lachesis.md         # classificação
│           └── atropos.md          # veredito
└── knowledge/                      # base de conhecimento (com last_verified)
    ├── repositories.md             # glossário de repositórios
    ├── taxonomy.md
    ├── components.md
    └── decisions.md
```

## Configuração

Copie `config/sources.example.json` para `.moiras/sources.json` no projeto onde vai rodar a triagem e preencha o épico, as pessoas e os canais do Slack e o caminho do registro de soluções (com os IDs `U…` e `C…`). O Jira e o Slack precisam estar conectados ao Claude (conectores do claude.ai ou servidores MCP próprios); o plugin não traz servidor MCP.

## Execução por cron

No modo `--auto` a skill não faz perguntas, processa só o que mudou desde a última execução e salva o relatório em `.moiras/execucoes/`. Exemplo (dias úteis às 8h):

```
0 8 * * 1-5 cd /caminho/do/projeto && claude -p "/moiras:moiras-triage PROJ-100 --auto" --allowedTools "Read,Write,Bash(node:*),<ferramentas do Jira e do Slack>" >> .moiras/cron.log 2>&1
```

Liste em `--allowedTools` as ferramentas dos conectores de Jira e Slack que a coleta usa; sem isso a execução sem terminal fica bloqueada esperando permissão.

## Memória

Cada etapa grava uma memória só de acréscimo em `.moiras/memoria/<etapa>.jsonl`, pelo script `scripts/memoria.mjs` (Node LTS mais recente, sem dependências): quando, com quem e o hash SHA-256 do conteúdo, nunca o texto bruto. A Cloto usa isso para saber o que é novo ou mudou, a Láquesis para reaproveitar classificações e a Átropos para guardar vereditos e escolhas pendentes.

## Instalação

```
/plugin marketplace add acme/moiras
/plugin install moiras@moiras
```

Para testar localmente: `claude --plugin-dir plugins/moiras`.
