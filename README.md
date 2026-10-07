# moiras
Analisar, conhecer e gerar soluções com base de conhecimento.

## Plugin

- [`plugins/moiras`](plugins/moiras): triagem de issues do Jira com base de conhecimento do projeto (Cloto → Láquesis → Átropos).

## Como trabalhar neste projeto

### 1. Preparar o ambiente

```bash
git clone git@github.com:acme/moiras.git
cd moiras
```

Com Nix e direnv (recomendado), uma vez:

```bash
direnv allow        # ou: nix develop
```

O shell traz Node LTS, TypeScript (só para checar tipos), Python 3 e jq, fixados pelo `flake.lock`. Sem Nix, use `nvm use` (Node LTS, via `.nvmrc`); nesse caso você roda os testes, mas não o `tsc`.

### 2. Onde mexer

| O que | Onde |
|---|---|
| Comportamento de cada etapa (contratos, regras) | `plugins/moiras/skills/moiras-triage/stages/*.md` |
| Orquestração, modos `--auto` e `--completo` | `plugins/moiras/skills/moiras-triage/SKILL.md` |
| Base de conhecimento (repositórios, taxonomia, componentes, decisões) | `plugins/moiras/knowledge/` |
| Memória das etapas (hash + JSONL) | `plugins/moiras/scripts/memoria.ts` |
| Modelo de configuração (épico, Slack) | `plugins/moiras/config/sources.example.json` |

Regras do projeto, convenções e o domínio estão no [AGENTS.md](AGENTS.md). O Node roda os `.ts` direto (sem build): sintaxe apagável e imports locais com extensão `.ts`.

### 3. Fluxo de trabalho

1. Crie uma branch a partir da `main`.
2. Faça a mudança e rode a checagem abaixo.
3. Commits em inglês, no imperativo (`Add ...`, `Fix ...`).
4. PR com título `[PROJ-NNNN] <resumo curto>` e descrição curta em português.

## Como testar

Dentro do shell do projeto, na raiz:

```bash
# testes automatizados do script de memória (node:test)
node --test plugins/moiras/scripts/*.test.ts

# erros de tipo (TypeScript só checa, o Node é quem executa)
tsc -p tsconfig.json

# manifestos do plugin e do marketplace
claude plugin validate plugins/moiras
claude plugin validate .

# flake e shell
nix flake check
```

Rode o script na mão para ver o que ele faz (use uma pasta temporária para não sujar o repositório):

```bash
cd "$(mktemp -d)"
S=/caminho/do/repo/plugins/moiras/scripts/memoria.ts

echo '{"b":2,"a":1}' | node $S hash                                     # hash canônico (ordem das chaves não importa)
echo '{"chave":"jira:PROJ-1","conteudo":{"a":1}}' | node $S registrar cloto   # "novo"
echo '{"chave":"jira:PROJ-1","conteudo":{"a":1}}' | node $S registrar cloto   # "inalterado"
echo '{"chave":"jira:PROJ-1","conteudo":{"a":2}}' | node $S registrar cloto   # "alterado"
node $S consultar cloto                                                 # último registro de cada chave
cat .moiras/memoria/cloto.jsonl                                         # só hash, nunca o texto bruto
```

### Testar o plugin no Claude Code

```bash
claude --plugin-dir plugins/moiras
```

Dentro da sessão:

1. Copie `plugins/moiras/config/sources.example.json` para `.moiras/sources.json` no projeto onde vai rodar e preencha o épico, as pessoas e os canais do Slack (com os IDs `U…` e `C…`).
2. Conecte o Jira e o Slack ao Claude (conectores do claude.ai ou servidores MCP). O plugin não traz servidor próprio.
3. Rode `/moiras:moiras-triage PROJ-100` (interativo) ou `/moiras:moiras-triage PROJ-100 --auto` (sem perguntas, só o que mudou; relatório em `.moiras/execucoes/`).
4. Depois de editar arquivos do plugin, rode `/reload-plugins` na sessão.

Para instalar a partir do repositório, como o time faria:

```
/plugin marketplace add acme/moiras
/plugin install moiras@moiras
```

> A base de conhecimento ainda está com `TODO`. Enquanto isso, a Láquesis devolve categoria `desconhecida` com confiança baixa; é o comportamento esperado, não um erro.
