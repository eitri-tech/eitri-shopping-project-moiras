# Moiras

Plugin para Claude que faz triagem de issues do Jira usando uma base de conhecimento do projeto.

O nome vem das Moiras: *moira* significa "quinhão", a parte atribuída a cada um, e cada etapa da triagem leva o nome de uma delas:

- **Cloto** (fia): coleta, em paralelo, as issues sem responsável do épico no Jira e as conversas do Slack
- **Láquesis** (mede): identifica repositório e componente pelo glossário, classifica e avalia duplicados
- **Átropos** (corta): justifica o problema, sugere até 3 soluções com % de confiança e anota a escolhida em `.moiras/solucoes.md`

## Estrutura

```
moiras/
├── .claude-plugin/plugin.json      # manifesto
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

## Instalação

```
/plugin marketplace add acme/moiras
/plugin install moiras@moiras
```

Para testar localmente: `claude --plugin-dir plugins/moiras`.
