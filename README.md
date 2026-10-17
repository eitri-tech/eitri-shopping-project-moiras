# Moiras

Plugin para Claude que faz triagem de issues do Jira com Slack e um knowledge do time: analisar, conhecer e gerar soluções.

## Sumário

- [Plugin](#plugin)
- [Outros agentes (desenho)](#outros-agentes-desenho)
- [Como trabalhar neste projeto](#como-trabalhar-neste-projeto)
  - [1. Preparar o ambiente no Ubuntu](#1-preparar-o-ambiente-no-ubuntu)
  - [2. Alternativa com Nix e direnv](#2-alternativa-com-nix-e-direnv)
  - [3. Onde mexer](#3-onde-mexer)
  - [4. Fluxo de trabalho](#4-fluxo-de-trabalho)
- [Como testar](#como-testar)
  - [Checagens](#checagens)
  - [Rodar o script de memória na mão](#rodar-o-script-de-memória-na-mão)
  - [Testar o plugin no Claude Code](#testar-o-plugin-no-claude-code)
  - [Teste real das skills de knowledge](#teste-real-das-skills-de-knowledge)

## Plugin

- [`plugins/moiras`](plugins/moiras): triagem de issues do Jira com base de conhecimento do projeto (Cloto → Láquesis → Átropos), indexação dos repositórios (`moiras-index`), sincronização e publicação do knowledge (`moiras-sync`, `moiras-publish`) e auditoria (`moiras-audit`).

## Outros agentes (desenho)

Proposta para levar o Moiras a outros agentes; o suporte atual continua sendo o plugin do Claude Code.
Os contratos das três etapas e o knowledge em Markdown são candidatos ao reaproveitamento.
O núcleo Node (`plugins/moiras/scripts/memory.ts` e `knowledge.ts`) usa apenas a biblioteca padrão, sem dependências externas; depende de Node com execução direta de TypeScript.
O [AGENTS.md](AGENTS.md) já reúne as instruções do projeto; seu carregamento automático depende do agente.
Jira e Slack vêm dos conectores do usuário: o Moiras não inclui servidor MCP.

O empacotamento `.claude-plugin/` (manifesto e marketplace), as invocações `/moiras:...`, `$ARGUMENTS` e `${CLAUDE_PLUGIN_ROOT}` são acoplamentos atuais ao Claude.
A busca em `plugins/` encontrou **11 ocorrências** de `${CLAUDE_PLUGIN_ROOT}`, distribuídas assim (caminhos relativos a `plugins/moiras/`):

| Arquivo | Ocorrências |
|---|---:|
| `skills/moiras-audit/SKILL.md` | 1 |
| `skills/moiras-index/SKILL.md` | 2 |
| `skills/moiras-publish/SKILL.md` | 2 |
| `skills/moiras-sync/SKILL.md` | 2 |
| `skills/moiras-triage/SKILL.md` | 3 |
| `skills/moiras-triage/stages/clotho.md` | 1 |

**Compatibilidade documentada.** Os estados abaixo se referem aos fatos das fontes oficiais indicadas, não a testes do Moiras nesses agentes.

| Agente | Onde lê skills | Instruções do projeto | Invocação e estado |
|---|---|---|---|
| [Codex](https://learn.chatgpt.com/docs/build-skills) | `$CWD/.agents/skills` até `$REPO_ROOT/.agents/skills`; usuário: `$HOME/.agents/skills`; segue symlinks de pastas de skill | Leitura de `AGENTS.md`: **a confirmar** na fonte consultada | `/skills` ou `$`, ou implicitamente pela descrição: **confirmado**; `agents/openai.yaml` opcional |
| [Cursor / Cursor CLI](https://cursor.com/docs/skills) | Projeto: `.agents/skills/`, `.cursor/skills/`; usuário: `~/.agents/skills/`, `~/.cursor/skills/`; compatibilidade: `.claude/skills/`, `.codex/skills/` e equivalentes em `~` | As páginas de regras tratam `.cursor/rules` e `AGENTS.md`; leitura pela CLI: **a confirmar** | Agent Skills no Cursor: **confirmado**; carregamento e forma de invocação na CLI: **a confirmar** |
| GitHub Copilot ([documentação oficial](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills), “about agent skills”) | Projeto: `.github/skills`, `.claude/skills`, `.agents/skills`; pessoais: `~/.copilot/skills`, `~/.agents/skills` | `AGENTS.md` e `.github/copilot-instructions.md`: **a confirmar** nas páginas consultadas | Skills em nuvem, code review, CLI, app e modo agente no VS Code/JetBrains: **confirmado**; forma de invocação: **a confirmar** |
| [opencode](https://opencode.ai/docs/skills) | `.opencode/skills/<nome>/SKILL.md`, `.claude/skills/`, `.agents/skills/`, no projeto e global | [Regras](https://opencode.ai/docs/rules): `AGENTS.md` subindo do diretório atual; global `~/.config/opencode/AGENTS.md`; fallback `CLAUDE.md` se não houver `AGENTS.md` | Descoberta: **confirmado**; forma de invocação: **a confirmar** |
| [Antigravity (app/IDE) e agy (CLI)](https://antigravity.google/docs/skills) | Projeto, nas duas superfícies: `<raiz>/.agents/skills/`. Global no app/IDE: `~/.gemini/config/skills/` (legado: `~/.gemini/antigravity/skills/`). Global no agy: `~/.gemini/antigravity-cli/skills/`; plugins do agy: `~/.gemini/antigravity-cli/plugins/<nome>/skills/` | Regras sempre ativas e workflows acionados pelo usuário são conceitos distintos de skills; `AGENTS.md`: **a confirmar** | Descoberta de skills: **confirmado**; o caminho global muda por superfície, então a instalação global deve tratá-las separadamente; invocação explícita: **a confirmar** |

No opencode, `instructions` em `opencode.json` aceita arquivos, globs e URLs; `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` desliga `.claude/skills`.
O denominador comum confirmado para o projeto é `.agents/skills/`, lido por Codex, Cursor, Copilot, opencode e Antigravity (app/IDE e agy); Claude Code usa `.claude/skills/` e o plugin. Os diretórios globais diferem por agente.

**PRs futuros, em passos pequenos:**

1. Resolver recursos pela raiz da skill, com caminhos relativos, ou por uma única variável documentada que indique o diretório do Moiras; substituir as 11 referências atuais. Mover/agrupar `scripts/` e preservar acesso à configuração e às etapas, validando cópia e symlink antes de definir o arranjo.
2. Adequar os frontmatters à [especificação aberta Agent Skills](https://agentskills.io/specification): diretório com `SKILL.md`, `name` de 1–64 caracteres em minúsculas/números/hífens igual ao diretório e `description` de 1–1024. Opcionais: `license`, `compatibility`, `metadata`, `allowed-tools` (experimental); pastas opcionais `scripts/`, `references/`, `assets/`; referências relativas à raiz da skill; recomendado menos de 500 linhas.
3. Desenhar instalação por cópia/symlink de `plugins/moiras/skills/*` para `.agents/skills/` do projeto, comum aos cinco agentes acima; instalações globais exigem o diretório de cada agente (no Antigravity, app/IDE e agy têm caminhos diferentes). Um instalador Node seria opcional; suporte a symlinks fora do Codex e integridade dos recursos copiados ficam **a confirmar**.
4. Manter `AGENTS.md` como fonte única das instruções do projeto, com `CLAUDE.md` apenas apontando para ele; confirmar como cada agente carrega essa referência.
5. Documentar o contrato mínimo de conectores/MCP de Jira e Slack: consultas e campos exigidos pelos contratos das etapas, estados de falha e interações opcionais aprovadas. Mapear ferramentas equivalentes por agente, sem vincular o núcleo a um fornecedor.

Na inspeção das cinco skills, todos os `name` correspondem ao diretório e cumprem o limite/formato; as descrições têm 421 (`audit`), 412 (`index`), 409 (`publish`), 364 (`sync`) e 549 (`triage`) caracteres. Todas têm menos de 500 linhas (63–126).
O desvio comum é `argument-hint`, campo extra fora da especificação fornecida; migrar a orientação para o corpo ou metadados em PR futuro. Todas também usam `allowed-tools: Bash(node:*)`: o campo é experimental, e a interpretação desse valor fora do Claude fica **a confirmar**; opencode reconhece apenas `name`, `description`, `license`, `compatibility` e `metadata` entre os campos fornecidos.

**Riscos e confirmações antes de implementar:**

- Não há equivalente estabelecido de `/moiras:...` nos outros agentes: confirmar seleção, nomes sem namespace, colisões e passagem dos argumentos hoje expressos por `$ARGUMENTS`.
- Confirmar os pontos marcados na tabela: skills/regras na Cursor CLI, leitura de instruções no Codex/Copilot/Antigravity e invocações ainda não documentadas aqui.
- Permissões de escrita e execução variam por agente: **a confirmar** a aplicação dos limites atuais. Escritas de knowledge continuam exigindo a escolha ou o mesmo “sim” à lista exata; preservar também as exceções existentes para memória, relatórios e reações autorizadas no automático.
- Confirmar Node compatível, resolução de recursos após instalação, symlinks e disponibilidade/autenticação de Git e `gh`: `moiras-publish` depende de `gh` para verificar destino privado e abrir PR; manter validação, branch novo, aprovação humana e proibição de push na principal.
- Confirmar conectores equivalentes, campos e permissões de Jira/Slack por agente, incluindo falhas parciais, reação autorizada e comentário sempre aprovado; não assumir que instalar skills instala conectores.

## Como trabalhar neste projeto

### 1. Preparar o ambiente no Ubuntu

O caminho padrão não precisa de Nix nem de direnv: só Node LTS, git e jq. Nos exemplos, o terminal é o bash.

```bash
sudo apt update && sudo apt install -y git curl jq

git clone git@github.com:<owner>/<repo>.git
cd <repo>
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
| Orquestração, modos `--auto` e `--full`, leitura e escrita do knowledge | `plugins/moiras/skills/moiras-triage/SKILL.md` |
| Auditoria e ajustes do knowledge (revisão aprovada por quem audita) | `plugins/moiras/skills/moiras-audit/SKILL.md` |
| Indexação dos repositórios (gera o glossário a partir do código) | `plugins/moiras/skills/moiras-index/SKILL.md` |
| Sincronização e publicação do knowledge compartilhado | `plugins/moiras/skills/moiras-sync/SKILL.md`, `plugins/moiras/skills/moiras-publish/SKILL.md` |
| Memória das etapas (hash + JSONL) | `plugins/moiras/scripts/memory.ts` |
| Regras dos registros do knowledge (`hash`, `check`, `plan`) | `plugins/moiras/scripts/knowledge.ts` |
| Modelo de configuração (épico, Slack, agências, interações, auditores, knowledges, pastas) | `plugins/moiras/config/sources.example.json` |

O knowledge (glossário de repositórios, critérios e aprendizado) não fica neste repositório: ele é local (`.moiras/knowledge/`, fora do git) ou fica em repositórios privados criados a partir de um template público de knowledge. Regras do projeto, convenções e o domínio estão no [AGENTS.md](AGENTS.md). O Node roda os `.ts` direto (sem build): sintaxe apagável e imports locais com extensão `.ts`.

### 4. Fluxo de trabalho

1. Crie uma branch a partir da `main`.
2. Faça a mudança e rode as [checagens](#checagens).
3. Commits em inglês, no imperativo (`Add ...`, `Fix ...`).
4. PR com título curto e descrição curta em português: o que muda e como testar.

## Como testar

### Checagens

Na raiz do projeto, no Ubuntu sem Nix:

```bash
# testes automatizados dos scripts de memória e de knowledge (node:test)
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
S=/caminho/do/repo/plugins/moiras/scripts/memory.ts

echo '{"b":2,"a":1}' | node $S hash                                     # hash canônico (ordem das chaves não importa)
echo '{"key":"jira:PROJ-1","content":{"a":1}}' | node $S record clotho      # "new"
echo '{"key":"jira:PROJ-1","content":{"a":1}}' | node $S record clotho      # "unchanged"
echo '{"key":"jira:PROJ-1","content":{"a":2}}' | node $S record clotho      # "changed"
node $S query clotho                                                    # último registro de cada chave
cat .moiras/memory/clotho.jsonl                                         # hash e metadados da etapa, nunca o texto bruto
```

### Testar o plugin no Claude Code

```bash
claude --plugin-dir plugins/moiras
```

Dentro da sessão:

1. Copie `plugins/moiras/config/sources.example.json` para `.moiras/sources.json` no projeto onde vai rodar e preencha o épico, as pessoas e os canais do Slack (com os IDs `U…` e `C…`) e os knowledges (sem nenhum, vale só `.moiras/knowledge/`). Se parte das tasks é gerida por agência, preencha também `jira.agency_field` e `agencies`; é opcional.
2. Conecte o Jira e o Slack ao Claude (conectores do claude.ai ou servidores MCP). O plugin não traz servidor próprio.
3. Rode `/moiras:moiras-triage PROJ-100` (interativo) ou `/moiras:moiras-triage PROJ-100 --auto` (sem perguntas, só o que mudou; relatório em `.moiras/runs/`).
4. Para revisar o knowledge fora de uma triagem, rode `/moiras:moiras-audit` (ou `/moiras:moiras-audit criteria`). É só interativa: cada ajuste espera o seu "sim". `audit.auditors` em `.moiras/sources.json` é opcional e limita quem pode fazer ajustes.
5. Para criar o glossário a partir do código, rode `/moiras:moiras-index` (preencha `index` em `.moiras/sources.json`). Ela só lê os repositórios e grava `glossary/` no knowledge local depois do seu "sim".
6. Com knowledges compartilhados (`repository` na configuração), rode `/moiras:moiras-sync <nome>` para trazer o que foi mergeado e `/moiras:moiras-publish <nome>` para abrir um PR com o que é novo no seu knowledge local. O sync só atualiza o clone local com `merge --ff-only`; o publish envia um branch novo e abre PR, sem fazer merge do PR. Nenhuma das duas faz push na branch principal.
7. Depois de editar arquivos do plugin, rode `/reload-plugins` na sessão.

Para instalar a partir do repositório, como o time faria:

```
/plugin marketplace add <owner>/<repo>
/plugin install moiras@moiras
```

> Sem glossário nem critérios no knowledge, a Láquesis pode usar as categorias padrão quando houver evidência; sem evidência suficiente, usa `unknown`. Em ambos os casos, limita `confidence` a 0.3 e inclui `criteria-missing`; é o comportamento esperado, não um erro.

### Teste real das skills de knowledge

Roteiro para validar `moiras-index`, `moiras-audit`, `moiras-sync` e `moiras-publish` num projeto de verdade. Os passos 1 a 6 escrevem em `.moiras/` (fora do git) e só leem os seus repositórios, com uma exceção: o arquivo temporário do passo 5, que você apaga em seguida. O passo 7 acessa o remoto do knowledge privado (`git clone`/`git fetch`, que pedem rede e autenticação), mas só traz; só o passo 8 escreve no remoto, abrindo um PR.

1. **Clone o plugin** e confira o ambiente: `node --test plugins/moiras/scripts/*.test.ts` (Node LTS; `nvm use` ou `nix develop`).
2. **Crie uma pasta de teste fora do repositório** (ex.: `~/moiras-teste`) com um `.moiras/sources.json` mínimo. Os caminhos são relativos à pasta que contém `.moiras/`. Comece com um único repositório; `roots` descobre vários de uma vez.

   ```json
   {
     "knowledge": [{ "name": "local", "scope": "local", "dir": ".moiras/knowledge" }],
     "index": { "repositories": [{ "name": "acme-shop-checkout", "path": "../acme-shop-checkout" }] }
   }
   ```

3. **Abra o Claude nessa pasta** com o plugin: `claude --plugin-dir <clone>/plugins/moiras`. O `/help` lista as cinco skills.
4. **Indexe:** `/moiras:moiras-index`. Nada é gravado antes do seu "sim" à lista. Depois confira o `glossary/<repo>.md` e rode `node <clone>/plugins/moiras/scripts/knowledge.ts check .moiras/knowledge`: sem achados; `url` sem credencial, `local_path` relativo, `owner` vazio ou um time, e nenhum trecho de código.
5. **Reindexe:** sem mudanças, o repositório volta como `unchanged` e o arquivo não muda. Para ver o `changed`, crie um arquivo novo dentro de `src/` do repositório (por exemplo `src/teste/index.ts`; pasta vazia não conta para o hash) e rode de novo: ele volta como `changed`. **Responda "não" à gravação**, apague o arquivo criado e confira que o `git status` do repositório está limpo: assim o glossário continua o do passo 4 e o seu código não fica com resíduo do teste. Prefira um clone descartável se o repositório tiver alterações suas.
6. **Audite:** `/moiras:moiras-audit glossary`: sem achados graves no glossário recém-gerado. Para ver a skill apontar um glossário velho, copie o arquivo (`cp .moiras/knowledge/glossary/<repo>.md .moiras/glossary-<repo>.bak`), altere só o `indexed_at` do original para mais de 6 meses atrás e rode a auditoria: ela só sugere `moiras-index`. **Restaure o original (`mv .moiras/glossary-<repo>.bak .moiras/knowledge/glossary/<repo>.md`) antes do passo 8**; reindexar não serve, porque com o código igual o arquivo não é tocado. A edição é só deste teste, num arquivo descartável: fora dele, só o `moiras-index` escreve em `glossary/`.
7. **Sincronize:** acrescente em `knowledge` o item abaixo (o `name` é o que você passa às skills; `repository` e `dir` são os do knowledge privado) e rode `/moiras:moiras-sync team`. Ela pergunta antes de clonar; um clone sujo ou divergente a faz parar, sem mexer em nada.

   ```json
   { "name": "team", "scope": "project", "repository": "<url-do-knowledge-privado>", "dir": "../moiras-knowledge-team" }
   ```

8. **Publique:** `/moiras:moiras-publish team`. A skill confere que o destino é o `repository` configurado e é privado, mostra a lista exata, só copia depois do "sim", cria o branch `moiras/index-<AAAA-MM-DD>` e abre o PR com o `gh` (sem o `gh`, a skill para e explica). Nada na `main`, nenhum merge. Feche o PR e apague o branch se não quiser manter o glossário de teste.
9. **Triagem (opcional):** com Jira e Slack conectados, siga o passo 1 de "Testar o plugin no Claude Code" e confira se a Láquesis cita `knowledge:local/glossary/...`.

Ao testar, anote onde a skill perguntou o que a documentação não prevê (ou não perguntou onde devia), campos do glossário errados ou inventados e mensagens de erro, sem colar conteúdo de repositório ou de issue. Limpeza: apague a pasta de teste e o clone do knowledge.
