# AGENTS.md

Instruções para agentes de código (Claude Code, Codex, Copilot etc.) neste repositório.

## Sobre o projeto

**Moiras**: plugin para Claude que faz triagem de issues do Jira usando um knowledge do time.

A triagem segue três etapas, cada uma com entrada e saída verificáveis:

1. **Cloto**: coleta em paralelo. Do Jira, as issues sem responsável do épico, por prioridade e data fim, comparando com o fim do épico/projeto. Do Slack, as mensagens de pessoas e canais definidos. Hoje Jira e Slack são as fontes esperadas; outras podem ser adicionadas seguindo o padrão descrito em `stages/clotho.md`
2. **Láquesis**: identifica repositório e componente pelo glossário, classifica (categoria, origem, confiança) e avalia duplicados
3. **Átropos**: justifica o problema, decide a ação (`duplicate`, `blocked`, `ready-for-dev`, `needs-info`, `close`), sugere de 3 a 5 soluções com % de confiança e guarda a escolhida no aprendizado

O plugin fica em `plugins/moiras/` e é publicado pelo marketplace em `.claude-plugin/marketplace.json`. Jira e Slack vêm dos conectores do usuário; o plugin não traz servidor MCP.

Estrutura:

- `.claude-plugin/plugin.json`: manifesto
- `skills/moiras-triage/SKILL.md`: skill que orquestra as três etapas, em ordem, e define como ler e escrever o knowledge; cada etapa fica em `stages/`
- `config/sources.example.json`: modelo da configuração lida de `.moiras/sources.json`
- `scripts/memory.ts`: grava e consulta a memória de cada etapa (`.moiras/memory/<stage>.jsonl`) com hash SHA-256

## Repositório público

Este repositório é público. Nada de informação da empresa nem dados sensíveis:

- Sem nomes reais de clientes, repositórios, sites, projetos do Jira, canais ou pessoas, nem URLs internas.
- Exemplos usam um universo fictício: empresa Acme, repositório `acme-shop-checkout`, issues `PROJ-123`, pessoas Fulano, Beltrana e Sicrano, canal `#proj-squad`.
- O knowledge real fica fora daqui: local em `.moiras/` (no `.gitignore`) ou em repositórios privados criados a partir do template público de knowledge.

## Regras do domínio

- O plugin só lê e sugere no Jira e no Slack; nunca escreve sem aprovação humana. A única exceção são as interações opcionais da Cloto (reação no Slack, comentário curto no Jira): desligadas por padrão (`interactions.enabled`), só no modo interativo e aplicadas depois do "sim" do usuário à lista exata. No `--auto` nada é escrito.
- Cada etapa tem contrato `{input, output}`; saída fora do contrato interrompe a issue em vez de seguir adiante.
- Toda classificação sai em formato estruturado, com as fontes consultadas.
- O glossário é derivado do código (indexação). A Láquesis não o edita: só sugere.
- Agência é opcional (`jira.agency_field` ou `agency` no glossário). Para issue com agência, a Átropos só oferece um rascunho de repasse, que o usuário envia: nada vai à agência (Jira, Slack ou outro canal) pelo plugin, e o rascunho não leva conversas internas nem dados de outros clientes.
- Dois modos: interativo (padrão) e `--auto` (cron, sem perguntas, só o que mudou, relatório em `.moiras/runs/`).
- Memória das etapas só pelo script, só de acréscimo e sem conteúdo bruto (apenas hash). Ela é local e nunca vai para um knowledge.
- Fora a memória e os relatórios, o plugin só escreve no knowledge local (`learnings/` e `criteria/`), no modo interativo e depois da escolha ou do "sim" do usuário. Aprendizado não é apagado; só `result` e a observação mudam. Critérios conflitantes são unidos num critério regenerado (`replaces`).
- O knowledge nunca tem cópia de código: trechos de até 20 linhas, sempre com referência (repositório, caminho, commit). Sem segredos.
- Arquivos do knowledge levam frontmatter com `indexed_at` ou `created_at`; conteúdo antigo deve ser sinalizado na saída.
- O que conta como problema de plataforma de terceiros ou do app vem dos critérios do time, não do plugin.
- Nunca commite tokens nem URLs com segredo (no `.mcp.json` inclusive).

## Idioma

O que a máquina lê é em inglês: flags, pastas, nomes de arquivo, chaves de configuração e de frontmatter, campos dos contratos e valores fixos (ex.: `action: needs-info`, `change: unchanged`, `result: resolved`). O que pessoas leem é em português: documentação, justificativas, relatórios e descrições.

## Ambiente

- `nix develop` (ou `direnv allow`, que usa o `.envrc` com `use flake`) entra num shell com Node LTS, TypeScript (`tsc`), Python 3 e jq, fixados pelo `flake.lock`. O shell também expõe o `@types/node` em `.direnv/types` para o `tsc` e o editor.
- Sem Nix, use `nvm use` (`.nvmrc` = `lts/*`).
- Para atualizar as versões: `nix flake update` e commite o `flake.lock`.

## Convenções

- Documentação e textos voltados ao time em português; código, identificadores e mensagens de commit em inglês.
- Mantenha mudanças pequenas e focadas; não adicione dependências sem necessidade.
- Scripts em TypeScript executado direto pelo Node LTS mais recente (`.nvmrc` = `lts/*`; use `nvm use`), sem build: só sintaxe apagável (sem `enum`, `namespace` nem parameter properties) e imports locais com extensão `.ts`. ESM; Python 3 só quando Node não servir. Use a biblioteca padrão (`node:*` ou stdlib do Python); dependência externa só com justificativa no PR.
- Testes dos scripts com `node:test`, ao lado do script (`*.test.ts`). Antes de commitar, rode `node --test plugins/moiras/scripts/*.test.ts` e `tsc -p tsconfig.json`.
- O Node executa os `.ts`; o `tsc` (pacote TypeScript do shell Nix) serve só para checar tipos (`noEmit`). Não gere `.js`.
- Ao criar um plugin novo, siga a estrutura de `plugins/moiras/` e registre-o no `README.md`.

## Commits e PRs

- Commits em inglês, no imperativo (`Add ...`, `Fix ...`).
- PRs com título curto e descrição em português, curta: o que muda em poucos bullets e como testar.
