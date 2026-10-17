---
name: moiras-index
description: "Indexa os repositórios do projeto e gera ou atualiza o glossário do knowledge local (um arquivo por repositório, com localização, plataforma, apps, palavras-chave e componentes), derivado do código. Use quando o glossário estiver vazio ou velho, quando a triagem citar um repositório fora dele, ou quando o usuário pedir para indexar (ex.: \"indexa os repositórios\", \"atualiza o glossário do acme-shop-checkout\")."
argument-hint: "[repositório...] [--all]"
allowed-tools: Bash(node:*)
---

# Indexação dos repositórios

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Use esse caminho em toda leitura, escrita e comparação do knowledge local.

Esta skill é a única que escreve em `glossary/`. O glossário é derivado do código: pode ser regenerado a qualquer momento, e a Láquesis só o lê. Ela só roda no modo interativo, porque todo arquivo escrito depende do "sim" do usuário à lista exata.

## O que ela lê e o que ela escreve

- **Lê** os repositórios declarados em `index` no `.moiras/sources.json`, só para leitura: nunca escreve neles, nunca instala dependências nem roda scripts, builds ou testes deles.
- **Escreve** só `glossary/<id>.md` no knowledge de escopo `local`, depois do "sim". Nenhum outro arquivo do knowledge, nenhum Jira, Slack ou repositório.
- Registros de glossário de repositórios que não aparecem mais na configuração **não são apagados**: a skill só os lista como `missing` no relatório.

## Configuração

```json
"index": {
  "roots": ["../acme"],
  "repositories": [
    { "name": "acme-shop-checkout", "path": "../acme-shop-checkout", "url": "https://github.com/<org>/acme-shop-checkout", "owner": "Squad Checkout", "agency": "Agência Aurora" }
  ]
}
```

- `roots`: pastas cujas subpastas com `.git` são descobertas como repositórios. O nome do repositório é o nome da pasta.
- `repositories`: repositórios explícitos. `name` e `path` são obrigatórios; `url`, `owner`, `agency` e `platform` são opcionais e **valem mais que o detectado**, porque dono e agência não saem do código.
- `agency`, quando existir, precisa ser um `name` de `agencies`. Se não for, avise e deixe o campo vazio.
- Caminhos relativos valem a partir da pasta onde está o `.moiras/`. Sem `index`, pergunte em qual pasta estão os repositórios e proponha a configuração, mas não grave o `sources.json`: indique `/moiras:moiras-init` (se o arquivo não existe) ou a edição à mão.

Os argumentos limitam a execução: um ou mais nomes de repositório, ou `--all` (o padrão quando não há nome).

## Passos

1. **Descobrir.** Junte `roots` e `repositories`, sem duplicar por caminho. O nome vira o arquivo `glossary/<id>.md`: se dois repositórios (descobertos ou da lista) ficarem com o mesmo nome, ignorando maiúsculas, pare e peça para renomear um deles na configuração, para um não sobrescrever o outro. Repositório da lista que não existe em disco vira `missing` no relatório.
2. **Ler as evidências**, repositório por repositório e sob demanda (README, manifestos como `package.json`, configuração do app, `CODEOWNERS`, lista de pastas de código). Não leia `.env*`, chaves, certificados nem `node_modules`/`dist`.
3. **Montar o registro** com o modelo `_templates/glossary.md` do knowledge ou, sem ele (como num knowledge recém-criado), com o "Modelo de reserva" abaixo (ver "O que vai em cada campo").
4. **Registrar até onde o repositório foi lido (proveniência).** Rode, para cada repositório (só comandos de leitura do Git, por dentro do script):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" provenance <repositório>
   ```

   A saída traz `indexed_commit` (o `HEAD` completo), `indexed_commit_date` (data desse commit, em UTC), `indexed_branch` (some em HEAD solto), `indexed_tag` (só se o `HEAD` estiver exatamente numa tag) e `indexed_dirty` (`true` com alteração não commitada). Copie os campos que vierem para o frontmatter. `{ "git": false }` (sem repositório Git ou sem commit): **omita** os cinco campos e avise `no-git` no relatório; com `"reason": "status-unreadable"` (o Git não conseguiu ler o estado da árvore, por exemplo um índice corrompido), omita igual e relate esse motivo. Branch ou tag que o script devolve em `omitted` (nome fora do formato seguro ou parecido com segredo ou e-mail) fica de fora, com o aviso `ref-omitted`. Nunca use `--meta` nem inclua esses campos no hash: a proveniência diz *onde* a leitura foi feita, o `sources_hash` diz *o que* mudou.
5. **Calcular `sources_hash`** com o script, passando o que foi lido (arquivos entram pelo conteúdo, pastas só pelos nomes) e os overrides efetivos desse repositório (`owner`, `agency`, `platform`, `url`) em `--meta`, como um objeto JSON. Inclua só overrides aplicáveis, com `agency` validada; sem overrides, omita `--meta`. O JSON é canonizado e incorporado ao hash, então mudar ou remover um override também provoca atualização:

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
indexed_branch: main
indexed_tag:
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
| `indexed_branch` | branch atual; vazio em HEAD solto |
| `indexed_tag` | tag exata do `HEAD`; vazio se não houver |
| `indexed_dirty` | `true` se havia alteração não commitada (o commit então não descreve tudo o que foi lido), senão `false` |
| `sources_hash` | o hash do passo 5 |

O corpo tem uma ou duas frases sobre o que o repositório faz e a lista de componentes (`nome`: pasta). O que não puder ser confirmado fica vazio ou como `?`: não invente.

## Limites

- Nada de cópia de código: o glossário diz **onde** está o código (pasta, arquivo), nunca o código. Se um trecho ajudar mesmo, no máximo um trecho de 20 linhas, com referência (repositório, caminho, commit).
- Sem segredos, tokens, conteúdo de `.env`, dados pessoais ou texto bruto de issue e de conversa.
- Não edita o glossário à mão, não apaga registros e não sobrescreve arquivo de outro escritor.
- Conteúdo antigo é sinalizado: glossário com `indexed_at` de mais de 6 meses é velho para a triagem.
- Identificadores (campos, valores fixos, pastas) em inglês; descrições e relatórios em português.
