---
name: moiras-init
description: "Cria o .moiras/sources.json do projeto conversando com o usuário, sem que ele precise copiar o modelo nem montar o arquivo à mão: pergunta o que falta (Jira, Slack, knowledge, repositórios), usa os conectores só para ler e propor valores (site, IDs de canais e pessoas), mostra o arquivo inteiro e só grava com o \"sim\". Nunca sobrescreve uma configuração existente. Use quando o usuário pedir para configurar ou iniciar o Moiras, ou quando outra skill avisar que falta a configuração (ex.: \"configura o moiras\", \"cria o sources.json\")."
argument-hint: "[--check]"
allowed-tools: Bash(node:*)
---

# Configuração inicial

Argumentos: `$ARGUMENTS`

Cria o `.moiras/sources.json` que as outras skills leem. O usuário pode (e deve poder) editar o arquivo depois à mão; a skill só poupa o trabalho de montá-lo. Só roda no modo interativo: não existe `--auto`, porque toda gravação depende do "sim" do usuário.

`<base>` é a pasta do projeto onde a triagem vai rodar (a pasta atual, salvo se o usuário disser outra). Os caminhos do arquivo são relativos à pasta que contém o `.moiras/`.

## Passos

1. **Ver se já existe.** Se `<base>/.moiras/sources.json` existe, **não escreva nada**: rode `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.ts" check <base>/.moiras/sources.json` e relate só caminho e regra de cada achado; depois diga que a edição é à mão (ou que ele remova o arquivo para criar outro) e encerre. Com `--check`, a skill **só verifica**, exista o arquivo ou não: sem arquivo, diga que ainda não há configuração, sugira rodar a skill sem `--check` e encerre.
2. **Descobrir e propor.** Pergunte em blocos curtos, só o que falta, e nunca invente um valor. Os conectores servem para **ler** e propor; confirme cada valor com o usuário:
   - **Jira** (obrigatório): `site` (só o host, ex.: `example.atlassian.net`), o épico (`epic`, ex.: `PROJ-100`) e a data fim (`project_end`, `AAAA-MM-DD`). Com o conector do Jira, confirme que o épico existe e leia a data fim dele. `agency_field` só se parte das tasks é gerida por agência.
   - **Slack** (contexto, opcional): canais e pessoas a monitorar, com os IDs (`C…` e `U…`). Com o conector do Slack, procure cada nome e proponha o ID; sem ele, explique onde achá-lo (perfil da pessoa, detalhes do canal). `lookback_days` só se quiser mudar o padrão.
   - **Knowledge**: sempre o `local` (`.moiras/knowledge`). Pergunte se há knowledge compartilhado (repositório git privado criado do template): `name`, `scope` (`project | group | global`), `repository` e `dir` do clone (sugira `../<nome>`).
   - **Repositórios** (para o `moiras-index`): procure, só lendo, repositórios git na pasta do projeto e nas vizinhas (`.git` presente) e proponha `index.roots` ou `index.repositories` com caminhos relativos. Para `url`, use `git -C <dir> remote get-url origin` e deixe o endereço sem credencial: em `https://usuário:token@host/org/repo`, tire usuário, senha e token; em SSH (`git@host:org/repo.git` ou `ssh://git@host/org/repo.git`), converta para `https://host/org/repo`, porque o `url` é o endereço de consulta do repositório, não o de clone. Na dúvida, deixe sem `url`.
   - **Opcionais, só se o usuário quiser:** `agencies`, `interactions` (desligadas por padrão; `auto_types` só aceita `reaction`), `audit.auditors` (pseudônimos não identificáveis) e `memory.dir` e `runs.dir`.
   - **Outras fontes:** hoje Jira e Slack são o foco, mas o arquivo aceita blocos de outras fontes (padrão em `moiras-triage/stages/clotho.md`, "Outras fontes"). Se o usuário quiser um, grave o bloco como ele descrever e avise que a Cloto só o usa depois que a fonte estiver documentada nessa etapa.
3. **Validar antes de mostrar.** Monte o JSON e rode `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.ts" init --dir <base>/.moiras --dry-run` com o JSON na entrada padrão. Corrija os `error` com o usuário; os `warning` entram na lista, marcados.
4. **Mostrar e pedir o "sim".** Apresente o arquivo **inteiro** e os caminhos exatos que serão criados: `<base>/.moiras/sources.json` e `<base>/.moiras/.gitignore` (com `*`, para a pasta nunca ser commitada). Nada é gravado antes do "sim".
5. **Gravar.** Rode o mesmo comando sem `--dry-run`. O script valida de novo, cria só esses dois arquivos e **nunca sobrescreve**: se o arquivo apareceu no meio do caminho, ele para e a skill avisa.
6. **Fechar.** Diga o que foi criado, que o usuário pode editar o `sources.json` quando quiser, e sugira o próximo passo: `/moiras:moiras-index` para gerar o glossário e `/moiras:moiras-triage <épico>` para triar.

## Limites

- Só cria `<base>/.moiras/sources.json` e `<base>/.moiras/.gitignore`, e só pelo `scripts/config.ts`. Não toca no Jira, no Slack, nos repositórios nem no `.gitignore` do projeto.
- Nada de segredo: sem tokens, senhas nem usuário em URL. O script recusa o que parece segredo ou credencial e a skill não repete o valor ao relatar.
- Os IDs e nomes ficam só em `.moiras/`, fora do git. A skill nunca os copia para outro lugar.
- Os conectores são usados só para leitura.
