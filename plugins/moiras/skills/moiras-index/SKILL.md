---
name: moiras-index
description: "Indexa os repositórios do projeto e gera ou atualiza o glossário do knowledge local (um arquivo por repositório, com localização, plataforma, apps, palavras-chave e componentes), derivado do código. Use quando o glossário estiver vazio ou velho, quando a triagem citar um repositório fora dele, ou quando o usuário pedir para indexar (ex.: \"indexa os repositórios\", \"atualiza o glossário do acme-shop-checkout\")."
argument-hint: "[repositório...] [--all]"
allowed-tools: Bash(node:*), Bash(gh repo list:*)
---

# Indexação dos repositórios

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Use esse caminho em toda leitura, escrita e comparação do knowledge local.

Esta skill é a única que escreve em `glossary/`. O glossário é derivado do código: pode ser regenerado a qualquer momento, e a Láquesis só o lê. Ela só roda no modo interativo, porque todo arquivo escrito depende do "sim" do usuário à lista exata.

## O que ela lê e o que ela escreve

- **Lê** os repositórios declarados em `index` no `.moiras/sources.json`, só para leitura: nunca escreve neles, nunca instala dependências nem roda scripts, builds ou testes deles. Com `index.github`, também **lista** (só leitura, `gh repo list`) os repositórios do GitHub que casam com o padrão.
- **Clona**, só se `index.github` pedir, só depois do "sim" à lista exata e só pelo `github.ts clone`: um repositório que ainda não existe em `clone_dir`, nunca por cima de uma pasta existente e nunca com `pull`, `fetch` ou `checkout` num clone que já está lá.
- **Escreve** só `glossary/<id>.md` no knowledge de escopo `local`, depois do "sim". Nenhum outro arquivo do knowledge, nenhum Jira, Slack ou repositório.
- Registros de glossário de repositórios que não aparecem mais na configuração **não são apagados**: a skill só os lista como `missing` no relatório.

## Configuração

```json
"index": {
  "roots": ["../acme"],
  "repositories": [
    { "name": "acme-shop-checkout", "path": "../acme-shop-checkout", "url": "https://github.com/<org>/acme-shop-checkout", "owner": "Squad Checkout", "agency": "Agência Aurora" }
  ],
  "github": [
    { "match": "acme/acme-shop-*", "clone_dir": "../acme" }
  ]
}
```

- `roots`: pastas cujas subpastas com `.git` são descobertas como repositórios. O nome do repositório é o nome da pasta.
- `repositories`: repositórios explícitos. `name` e `path` são obrigatórios; `url`, `owner`, `agency` e `platform` são opcionais e **valem mais que o detectado**, porque dono e agência não saem do código.
- `github`: padrões de repositórios do GitHub. `match` é `<dono>/<glob>`: o dono é fixo e o glob aceita `*` (qualquer trecho) e `?` (um caractere) sobre o nome do repositório, sem diferenciar maiúsculas (é glob, não regex). `clone_dir` é a pasta onde os clones ficam (e onde os que já existem são encontrados). `include_archived` (padrão `false`) traz também os arquivados. Cada repositório que casa é indexado como os de `roots`, pelo nome, e vale o que `repositories` disser sobre ele (por `name`): dono, agência e plataforma continuam vindo de lá.
- `agency`, quando existir, precisa ser um `name` de `agencies`. Se não for, avise e deixe o campo vazio.
- Caminhos relativos valem a partir da pasta onde está o `.moiras/`. Sem `index`, pergunte em qual pasta estão os repositórios e proponha a configuração, mas não grave o `sources.json`: indique `/moiras:moiras-init` (se o arquivo não existe) ou a edição à mão.

Os argumentos limitam a execução: um ou mais nomes de repositório, ou `--all` (o padrão quando não há nome).

### Repositórios do GitHub (`index.github`)

Para cada entrada de `github`, na ordem:

```bash
gh repo list <dono> --limit 4000 --json name,url,isArchived,description | node "${CLAUDE_PLUGIN_ROOT}/scripts/github.ts" match --pattern "<dono>/<glob>" [--include-archived]
```

A saída é `{ owner, repositories: [{ name, url, archived }], truncated }`. Com `truncated: true` (a lista bateu no limite de 4000), avise que podem faltar repositórios: o padrão mais estreito não ajuda, porque o corte vem antes do filtro; clone à mão o repositório que faltar em `clone_dir` (ele entra como `exists`) ou aumente o `--limit`. Sem `gh` instalado ou logado, ou se o comando falhar (rede, permissão), diga que o padrão ficou **não verificado**: liste os clones que já estão em `clone_dir` com `node "${CLAUDE_PLUGIN_ROOT}/scripts/github.ts" local --dir <clone_dir> --pattern "<dono>/<glob>"` (mesma saída do `plan-clone`, mais o `owner`, só com o que está em disco) e indexe só os `exists`; os `conflict` seguem a regra abaixo (avise e pule), mas nada é dado como ausente. Faça o mesmo quando a lista vier truncada.

Depois veja o que já existe em disco:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/github.ts" plan-clone --dir <clone_dir> < matches.json
```

Cada repositório volta como `exists` (já clonado, com o `origin` esperado: entra na indexação), `clone` (livre) ou `conflict` (avise e pule; o `reason` diz por quê: `symlink`, `not-a-checkout` para uma pasta que não é um clone, `origin-mismatch` quando o `origin` do clone (qualquer um dos URLs, sem seguir `include`) não é o repositório esperado, `origin-unknown` quando a entrada não traz uma URL do GitHub para comparar, `origin-unreadable` quando o `origin` não pôde ser lido (inclusive sem `origin` ou com o Git demorando mais de 5 s), como um clone de outro dono com o mesmo nome ou um fork: se for o que você quer, declare-o em `repositories` com o `path`). Se houver `clone`, **ofereça** clonar, mostrando a lista exata (nome, URL e pasta de destino) e perguntando se quer clone completo (padrão, deixa o histórico disponível para busca local) ou raso (`--depth 1`). Só com o "sim":

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/github.ts" clone --dir <clone_dir> --repo <nome> --url <url> [--depth 1]
```

Sem o "sim" ao clone, o repositório não clonado vira `missing` no relatório, e a indexação segue com o que existe. A URL não leva usuário, senha nem token; a autenticação é a do Git do próprio usuário. O clone roda sem hooks (nem os do modelo do Git do usuário); filtros que a configuração do próprio usuário define (como o Git LFS) continuam valendo.

## Passos

1. **Descobrir.** Junte `roots`, `repositories` e os repositórios de `github` (depois do passo de clonagem acima), sem duplicar por caminho. O nome vira o arquivo `glossary/<id>.md`: se dois repositórios (descobertos ou da lista) ficarem com o mesmo nome, ignorando maiúsculas, pare e peça para renomear um deles na configuração, para um não sobrescrever o outro. Repositório da lista que não existe em disco vira `missing` no relatório.
2. **Ler as evidências**, repositório por repositório e sob demanda (README, manifestos como `package.json`, configuração do app, `CODEOWNERS`, lista de pastas de código). Não leia `.env*`, chaves, certificados nem `node_modules`/`dist`.
3. **Montar o registro** com o modelo `_templates/glossary.md` do knowledge ou, sem ele (como num knowledge recém-criado), com o "Modelo de reserva" abaixo (ver "O que vai em cada campo").
4. **Registrar até onde o repositório foi lido (proveniência).** Rode, para cada repositório (só comandos de leitura do Git, por dentro do script), **antes** de ler as evidências do passo 2 e **de novo depois** de calcular o `sources_hash` (passo 5):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" provenance <repositório>
   ```

   Se as duas saídas forem diferentes (alguém fez commit, trocou de branch ou mexeu na árvore no meio da indexação), o registro misturaria árvores: refaça a leitura desse repositório desde o passo 2; se continuar mudando, **omita** os três campos e avise `provenance-unstable` no relatório. Só grave a proveniência quando as duas leituras forem iguais. Com `indexed_dirty: true` nas duas, a comparação não vê uma edição a mais numa árvore que já estava suja; isso não invalida o registro, porque `true` já diz que o commit não descreve o que foi lido.

   A saída traz `indexed_commit` (o `HEAD` completo), `indexed_commit_date` (data desse commit, em UTC) e `indexed_dirty` (`true` com alteração não commitada). Copie os campos que vierem para o frontmatter. `{ "git": false }` (sem repositório Git ou sem commit): **omita** os três campos e avise `no-git` no relatório; com `"reason"` (`status-unreadable`: o Git não conseguiu ler o estado da árvore, por exemplo um índice corrompido; `commit-date-unreadable`: sem a data do commit; `index-unreadable`: o Git não leu as marcas do índice; `filters-unreadable`: a lista de filtros configurados não coube na leitura), omita igual e relate esse motivo. Com `indexed_commit`, o `check` exige também `indexed_commit_date` e `indexed_dirty`. O script não executa filtros nem hooks configurados no repositório (`fsmonitor`, `clean` e `process` do `.gitattributes`): por isso `indexed_dirty` pode vir `true` a mais para um arquivo que um filtro reescreve, nunca `false` a menos. O script também desliga `core.checkStat`, `core.trustctime`, `core.ignoreStat` e `core.ignoreCase` do repositório, que fazem o Git confiar só em tamanho e data (ou tratar `foo` e `Foo` como o mesmo arquivo): sem isso, uma edição que mantém os dois, ou um arquivo novo que só difere na caixa, passaria por limpo. Arquivos marcados no índice com `assume-unchanged`, ou com `skip-worktree` e ainda presentes no disco, escondem edições do Git: contam como sujo. Uma atualização de submódulo já adicionada ao índice (`git add libs/sub`) conta como sujo. Os submódulos não são abertos (a configuração deles também rodaria): o estado deles não entra em `indexed_dirty`, já que a indexação lê o repositório principal e não o conteúdo dos submódulos. Branch e tag nunca são gravadas: o commit já diz onde a leitura estava, e o nome de uma branch ou tag pode ser interno ou apontar para uma linha que não é a principal. Nunca use `--meta` nem inclua esses campos no hash: a proveniência diz *onde* a leitura foi feita, o `sources_hash` diz *o que* mudou.
5. **Calcular `sources_hash`** com o script, passando o que foi lido (arquivos entram pelo conteúdo, pastas só pelos nomes; um arquivo que o script não consegue ler — binário ou acima de 1 MB — entra só pelo nome, e um caminho passado explicitamente que não dá para ler faz o hash falhar em vez de se ausentar do fingerprint) e os overrides efetivos desse repositório (`owner`, `agency`, `platform`, `url`) em `--meta`, como um objeto JSON. Inclua só overrides aplicáveis, com `agency` validada; sem overrides, omita `--meta`. O JSON é canonizado e incorporado ao hash, então mudar ou remover um override também provoca atualização. A base é resolvida uma vez (caminho real): um atalho para a mesma árvore tem o mesmo hash da pasta, e base inexistente ou que não seja pasta faz o hash falhar. Ao percorrer uma pasta, o script também deixa de fora o que o `.gitignore` da base e o de cada subpasta exclui, como num `.gitignore` normal (da base para baixo, nunca acima dela; pasta ignorada nem é aberta); um arquivo informado direto é sempre lido, e uma pasta informada direto só é pulada se um `.gitignore` acima dela a excluir. Só soma exclusões às pastas que já eram puladas (`node_modules`, `dist`...); a primeira indexação depois dessa mudança pode marcar `changed` num repositório com arquivos ignorados em pastas lidas:


   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" hash --base <repositório> --meta '{"owner":"Squad Checkout"}' README.md package.json src/views
   ```

6. **Comparar** com o arquivo existente: mesmo `sources_hash` é `unchanged` e o arquivo não é tocado (nem o `indexed_at` nem a proveniência); hash diferente é `changed`; sem arquivo é `new`. A proveniência não decide nada: só a leitura gravada leva os campos. Num `unchanged`, se o commit do passo 4 for outro que o registrado, diga no relatório (commit registrado e atual, com as datas) sem gravar.
7. **Mostrar** a lista numerada (`new`, `changed`, `unchanged`, `missing`), com o caminho de cada `glossary/<id>.md`.
8. **Gravar** só o que o usuário aprovou, depois do "sim" à lista exata. Item que surgir depois precisa de novo "sim".
9. **Conferir** o que foi gravado e corrigir o que falhar:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <local-dir> --only glossary
   ```

10. **Relatar**, sem trechos de código: quantos arquivos novos, atualizados e inalterados (nos inalterados, o commit atual quando for outro que o registrado), o que ficou `missing` e os avisos. Se o knowledge tem `repository`, sugira o `moiras-publish`.

## Modelo de reserva

Use o `_templates/glossary.md` do knowledge quando existir; senão, este modelo, com os mesmos campos e corpo. Os valores são fictícios: troque todos pelos dados reais, os campos de proveniência pelos do passo 4 e o `sources_hash` pelo hash do passo 5 (o `check` recusa outro formato). `platform` é um só valor entre `vtex`, `wake`, `shopify` e `other`, ou fica vazio quando não dá para confirmar (nunca invente `other`); `agency` fica vazio sem agência.

```markdown
---
id: acme-shop-checkout
type: repository
url: https://github.com/acme/acme-shop-checkout
local_path: ../acme-shop-checkout
platform: other
apps: [home, pdp, cart, checkout, account]
keywords: [carrinho, checkout, frete]
owner: "@acme/squad-checkout"
agency:
indexed_at: 2026-01-15
indexed_commit: 0000000000000000000000000000000000000000
indexed_commit_date: 2026-01-14
indexed_dirty: false
sources_hash: sha256:1111111111111111111111111111111111111111111111111111111111111111
---

# acme-shop-checkout

Loja virtual da Acme: vitrine, carrinho e checkout.

## Componentes

- `checkout`: `src/views/checkout/`
- `cart`: `src/views/cart/`
```

## O que vai em cada campo

| Campo | De onde vem |
|---|---|
| `id` | nome do repositório, igual ao nome do arquivo |
| `type` | sempre `repository` |
| `url` | `index.repositories[].url` ou o `origin` do git, sempre sem usuário, senha ou token na URL; `git@host:org/repo.git` vira `https://host/org/repo` |
| `local_path` | caminho relativo (ex.: `../acme-shop-checkout`); nunca absoluto nem com a pasta pessoal |
| `platform` | `vtex`, `wake`, `shopify` ou `other`, pelas dependências e pela configuração; se não der para confirmar, deixe vazio |
| `apps` | pastas de aplicativo ou de views encontradas |
| `keywords` | termos do README, do nome e dos componentes, no máximo 10; **nunca de issues ou conversas** |
| `owner` | `index.repositories[].owner`, ou o time (`@org/time`) do `CODEOWNERS`; nunca uma pessoa |
| `agency` | só `index.repositories[].agency`; vazio se não houver |
| `indexed_at` | data da indexação (AAAA-MM-DD) |
| `indexed_commit` | SHA completo do `HEAD` lido (passo 4); o `check` recusa outro formato |
| `indexed_commit_date` | data (AAAA-MM-DD, UTC) desse commit: até onde o repositório tinha sido alterado quando foi lido |
| `indexed_dirty` | `true` se havia alteração não commitada (o commit então não descreve tudo o que foi lido), senão `false` |
| `sources_hash` | o hash do passo 5 |

O corpo tem uma ou duas frases sobre o que o repositório faz e a lista de componentes (`nome`: pasta). O que não puder ser confirmado fica vazio ou como `?`: não invente.

## Limites

- Nada de cópia de código: o glossário diz **onde** está o código (pasta, arquivo), nunca o código. Se um trecho ajudar mesmo, no máximo um trecho de 20 linhas, com referência (repositório, caminho, commit).
- Sem segredos, tokens, conteúdo de `.env`, dados pessoais ou texto bruto de issue e de conversa.
- Não edita o glossário à mão, não apaga registros e não sobrescreve arquivo de outro escritor.
- Conteúdo antigo é sinalizado: glossário com `indexed_at` de mais de 6 meses é velho para a triagem.
- Identificadores (campos, valores fixos, pastas) em inglês; descrições e relatórios em português.
