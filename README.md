# moiras
Analisar, conhecer e gerar soluções com base de conhecimento.

## Sumário

- [Plugin](#plugin)
- [Como trabalhar neste projeto](#como-trabalhar-neste-projeto)
  - [1. Preparar o ambiente no Ubuntu](#1-preparar-o-ambiente-no-ubuntu)
  - [2. Alternativa com Nix e direnv](#2-alternativa-com-nix-e-direnv)
  - [3. Onde mexer](#3-onde-mexer)
  - [4. Fluxo de trabalho](#4-fluxo-de-trabalho)
- [Como testar](#como-testar)
  - [Checagens](#checagens)
  - [Rodar o script de memória na mão](#rodar-o-script-de-memória-na-mão)
  - [Testar o plugin no Claude Code](#testar-o-plugin-no-claude-code)

## Plugin

- [`plugins/moiras`](plugins/moiras): triagem de issues do Jira com base de conhecimento do projeto (Cloto → Láquesis → Átropos).

## Como trabalhar neste projeto

### 1. Preparar o ambiente no Ubuntu

O caminho padrão não precisa de Nix nem de direnv: só Node LTS, git e jq. Nos exemplos, o terminal é o bash.

```bash
sudo apt update && sudo apt install -y git curl jq

git clone git@github.com:acme/moiras.git
cd moiras
```

**Node LTS.** Instale o nvm (instruções em https://github.com/nvm-sh/nvm), abra um terminal novo e, na raiz do projeto:

```bash
nvm install    # lê o .nvmrc (lts/*)
nvm use
node --version # deve ser a LTS mais recente
```

O Node executa os arquivos `.ts` direto, sem build. Isso já basta para rodar os testes.

**Checagem de tipos (opcional).** O TypeScript só aponta erros de tipo; quem executa é o Node. Ele precisa dos tipos do Node, que ficam fora do repositório (`.direnv/` já está no `.gitignore`):

```bash
mkdir -p .direnv/types/node
tmp=$(mktemp -d) && npm pack @types/node@24 --pack-destination "$tmp" --silent
tar -xzf "$tmp"/types-node-*.tgz -C .direnv/types/node --strip-components=1
```

Depois disso, `npx -y -p typescript tsc -p tsconfig.json` checa os tipos (ver [Checagens](#checagens)). Python 3 só é necessário se você for escrever scripts em Python; o Ubuntu já traz o `python3`.

### 2. Alternativa com Nix e direnv

Para ter exatamente o mesmo ambiente do time (Node LTS, TypeScript, Python 3 e jq fixados pelo `flake.lock`, e os tipos do Node já ligados), instale o Nix e o direnv:

```bash
sudo apt update && sudo apt install -y git curl direnv

# Nix (instalador oficial, modo multiusuário): abra um terminal novo depois
sh <(curl -L https://nixos.org/nix/install) --daemon

# habilita flakes
mkdir -p ~/.config/nix
echo 'experimental-features = nix-command flakes' >> ~/.config/nix/nix.conf

# ativa o direnv no shell (no zsh, use "direnv hook zsh" e ~/.zshrc)
echo 'eval "$(direnv hook bash)"' >> ~/.bashrc
```

Depois, na raiz do projeto, rode `direnv allow` (ou `nix develop`). O `nix-direnv` é opcional: acelera o carregamento, mas o `use flake` do `.envrc` já funciona sem ele. Com o shell do Nix você não precisa do nvm nem do passo dos tipos.

### 3. Onde mexer

| O que | Onde |
|---|---|
| Comportamento de cada etapa (contratos, regras) | `plugins/moiras/skills/moiras-triage/stages/*.md` |
| Orquestração, modos `--auto` e `--completo` | `plugins/moiras/skills/moiras-triage/SKILL.md` |
| Base de conhecimento (repositórios, taxonomia, componentes, decisões) | `plugins/moiras/knowledge/` |
| Memória das etapas (hash + JSONL) | `plugins/moiras/scripts/memoria.ts` |
| Modelo de configuração (épico, Slack) | `plugins/moiras/config/sources.example.json` |

Regras do projeto, convenções e o domínio estão no [AGENTS.md](AGENTS.md). O Node roda os `.ts` direto (sem build): sintaxe apagável e imports locais com extensão `.ts`.

### 4. Fluxo de trabalho

1. Crie uma branch a partir da `main`.
2. Faça a mudança e rode as [checagens](#checagens).
3. Commits em inglês, no imperativo (`Add ...`, `Fix ...`).
4. PR com título `[PROJ-NNNN] <resumo curto>` e descrição curta em português.

## Como testar

### Checagens

Na raiz do projeto, no Ubuntu sem Nix:

```bash
# testes automatizados do script de memória (node:test)
node --test plugins/moiras/scripts/*.test.ts

# erros de tipo (precisa do passo opcional de tipos da seção 1)
npx -y -p typescript tsc -p tsconfig.json

# manifestos do plugin e do marketplace (precisa do Claude Code)
claude plugin validate plugins/moiras
claude plugin validate .
```

No shell do Nix, o `tsc` já vem instalado, então basta `tsc -p tsconfig.json`. Só nesse caminho há também `nix flake check`, que valida o flake.

### Rodar o script de memória na mão

Use uma pasta temporária para não sujar o repositório:

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
