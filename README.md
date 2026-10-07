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

#### Não tem Nix nem direnv? (Linux, ex.: Ubuntu)

Instale por fora. Escolha **um** dos dois caminhos.

**A) Instalar Nix e direnv (mesmo ambiente do time):**

```bash
sudo apt update && sudo apt install -y git curl direnv

# Nix (instalador oficial, modo multiusuário) — abra um terminal novo depois
sh <(curl -L https://nixos.org/nix/install) --daemon

# habilita flakes
mkdir -p ~/.config/nix
echo 'experimental-features = nix-command flakes' >> ~/.config/nix/nix.conf

# ativa o direnv no shell (bash; no zsh use "direnv hook zsh" e ~/.zshrc)
echo 'eval "$(direnv hook bash)"' >> ~/.bashrc
```

Depois, na raiz do projeto: `direnv allow` (ou `nix develop`). O `nix-direnv` é opcional: acelera o carregamento, mas o `use flake` do `.envrc` já funciona sem ele.

**B) Sem Nix, instalando as ferramentas à mão:**

```bash
sudo apt update && sudo apt install -y git curl jq

# Node LTS: instale o nvm (instruções em https://github.com/nvm-sh/nvm), abra um terminal novo e:
nvm install   # lê o .nvmrc (lts/*)
nvm use
node --version  # deve ser a LTS mais recente

# testes (só precisam do Node)
node --test plugins/moiras/scripts/*.test.ts

# checagem de tipos (opcional): TypeScript + tipos do Node, fora do repositório
mkdir -p .direnv/types/node
tmp=$(mktemp -d) && npm pack @types/node@24 --pack-destination "$tmp" --silent
tar -xzf "$tmp"/types-node-*.tgz -C .direnv/types/node --strip-components=1
npx -y -p typescript tsc -p tsconfig.json
```

O `.direnv/` já está no `.gitignore`. Python 3 só é necessário se você for escrever scripts em Python (o Ubuntu já traz o `python3`). O `claude plugin validate` e o `nix flake check` da seção de testes dependem do Claude Code e do Nix, respectivamente.

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
