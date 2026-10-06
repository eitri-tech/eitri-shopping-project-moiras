# AGENTS.md

Instruções para agentes de código (Claude Code, Codex, Copilot etc.) neste repositório.

## Sobre o projeto

**Moiras**: plugin para Claude que faz triagem de issues do Jira da Acme usando uma base de conhecimento do projeto.

A triagem segue três etapas, cada uma com entrada e saída verificáveis:

1. **Cloto** — coleta em paralelo: issues sem responsável do épico no Jira (por prioridade e data fim, comparando com o fim do épico/projeto) e mensagens do Slack de pessoas e canais definidos. Hoje Jira e Slack são as fontes esperadas; outras podem ser adicionadas seguindo o padrão descrito em `stages/clotho.md`
2. **Láquesis** — identifica repositório e componente pelo glossário de repositórios, classifica (categoria, origem, confiança) e avalia duplicados
3. **Átropos** — justifica o problema, decide a ação (duplicado, bloqueado, pronto para dev, precisa de info, fechar), sugere até 3 soluções com % de confiança e anota a solução escolhida no registro de soluções

O plugin fica em `plugins/moiras/` e é publicado pelo marketplace em `.claude-plugin/marketplace.json`. Jira e Slack vêm dos conectores do usuário; o plugin não traz servidor MCP.

Estrutura:

- `.claude-plugin/plugin.json` — manifesto
- `skills/moiras-triage/SKILL.md` — skill que orquestra as três etapas, em ordem; cada etapa fica em `stages/`
- `config/sources.example.json` — modelo da configuração lida de `.moiras/sources.json`
- `scripts/memoria.mjs` — grava e consulta a memória de cada etapa (`.moiras/memoria/<etapa>.jsonl`) com hash SHA-256
- `knowledge/` — base de conhecimento (glossário de repositórios, taxonomia, componentes, decisões)

## Regras do domínio

- O plugin só lê e sugere no Jira; nunca escreve em ticket sem aprovação humana.
- Cada etapa tem contrato `{entrada, saida}`; saída fora do contrato interrompe a issue em vez de seguir adiante.
- Toda classificação sai em formato estruturado, com as fontes consultadas.
- A Láquesis não edita o glossário: só sugere; o usuário aprova.
- Dois modos: interativo (padrão) e `--auto` (cron, sem perguntas, só o que mudou, relatório em `.moiras/execucoes/`).
- Memória das etapas só pelo script, só de acréscimo e sem conteúdo bruto (apenas hash).
- Fora a memória e os relatórios, a única escrita do plugin é o registro de soluções (`memoria.solucoes`, padrão `.moiras/solucoes.md`), só depois da escolha do usuário. Entradas não são apagadas; só `resultado` e `observacao` mudam.
- Arquivos da base de conhecimento levam frontmatter com `last_verified`; conteúdo antigo deve ser sinalizado na saída.
- A taxonomia separa problema de plataforma (VTEX, Wake, Shopify) de problema do app.
- Nunca commite tokens nem URLs com segredo (no `.mcp.json` inclusive).

## Convenções

- Documentação e textos voltados ao time em português; código, identificadores e mensagens de commit em inglês.
- Mantenha mudanças pequenas e focadas; não adicione dependências sem necessidade.
- Scripts em Node.js de preferência, na versão LTS mais recente (`.nvmrc` = `lts/*`; use `nvm use`), em ESM; Python 3 só quando Node não servir. Use a biblioteca padrão (`node:*` ou stdlib do Python); dependência externa só com justificativa no PR.
- Testes dos scripts com `node:test`, ao lado do script (`*.test.mjs`). Rode `node --test plugins/moiras/scripts/*.test.mjs` antes de commitar.
- Ao criar um plugin novo, siga a estrutura de `plugins/moiras/` e registre-o no `README.md`.

## Commits e PRs

- Commits em inglês, no imperativo (`Add ...`, `Fix ...`).
- PRs com título `[PROJ-NNNN] <resumo curto>` e descrição em português, curta: link do Jira, o que muda em poucos bullets e como testar.
