---
name: moiras-teach
description: "Ensina o knowledge das Moiras: transforma uma regra que o usuário dita (\"sempre que mexer com X, precisa de Y\") em critério em criteria/, com gatilho, o que conferir e como conferir, sempre com o \"sim\" à lista exata. Use para incrementar o knowledge, por exemplo: \"sempre que a issue mexer com o checkout, confira a flag de homologação antes de propor a solução\"."
argument-hint: "[tema ou regra em uma frase]"
allowed-tools: Bash(node:*), WebFetch
---

# Ensinar uma regra ao knowledge

Argumentos: `$ARGUMENTS`

Resolva `<local-dir>` pelo `dir` da entrada com `scope: local` em `knowledge` no `.moiras/sources.json`; o padrão é `.moiras/knowledge`. Sem `.moiras/sources.json`, ofereça `/moiras:moiras-init` e encerre.

A Átropos só aprende critério quando o usuário discorda de um veredito. Esta skill é o caminho direto: o usuário diz a regra antes de ela errar. Só roda no modo interativo e só escreve em `criteria/` do knowledge local, com o "sim" à lista exata. Não toca em `glossary/` (só o `moiras-index`), `learnings/`, Jira, Slack nem repositórios, e não escreve na memória das etapas.

## Passos

1. **Entender a regra.** Reduza o pedido a quatro respostas e pergunte só o que faltar:
   - **Gatilho:** quando a regra vale (palavras na issue, componente, repositório, tipo de problema).
   - **Exigência:** o que precisa existir ou ser conferido (artefato, configuração, aprovação).
   - **Como conferir:** passos verificáveis, de preferência com uma fonte que se abre (arquivo no código, URL pública, painel).
   - **Efeito na triagem:** vira item obrigatório nas soluções (`applies_to: solutions`), muda a ação (`action`), a categoria (`category`) ou a origem (`origin`).
2. **Procurar o que já existe.** Leia `criteria/` de todos os knowledges configurados; para cada candidato com o mesmo gatilho ou `applies_to`, leia o **arquivo inteiro** (regra, lista **Conferir** e **Por quê**), nunca só título, escopo e gatilho. Só é equivalente a regra que pede as mesmas conferências: nesse caso, não crie outra e mostre a existente. Mesmo gatilho com exigência diferente conflita: proponha um critério regenerado com `replaces` que **preserve todas as exigências e conferências** dos antigos e acrescente a nova (apague só os antigos do knowledge local; os compartilhados ficam intocados e são citados como `knowledge:<name>/criteria/<arquivo>.md`). Critério consultado com `created_at` de mais de 6 meses gera `knowledge-stale:<ref>` (referência completa, com a data), e o aviso vai para a proposta do passo 4 e para o relatório final; não atualize a data para esconder a idade. Na lista do passo 4, mostre o que cada critério antigo exigia e onde isso ficou no novo, para o usuário conferir que nada se perdeu.
3. **Rascunhar** o critério no modelo de `_templates/` do knowledge (sem ele, o modelo de `moiras-triage/stages/atropos.md`, seção 8), com `id` curto em inglês, `created_at` de hoje, `applies_to` e `replaces`. O corpo diz a regra em uma ou duas frases, o **Gatilho**, a lista **Conferir** e o **Por quê**. Sem segredo, dado pessoal, texto bruto de issue ou código com mais de 20 linhas (sempre com referência).
4. **Mostrar a lista exata** (arquivos a criar e a apagar) e pedir o "sim", mais um pseudônimo para `approved_by` (`reviewer-01`, `user-7`; ver "Regras de escrita" em `moiras-triage/SKILL.md`). Ajuste pedido volta para um novo "sim".
5. **Gravar** só o aprovado, um arquivo por critério, sem sobrescrever.
6. **Conferir** e corrigir o que falhar (correção que mude o conteúdo volta ao usuário):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <local-dir> --only criteria
   ```

7. **Relatar** o que foi gravado, os avisos `knowledge-stale` e sugerir `moiras-publish` se o time deve compartilhar a regra.

## Exemplo: checkout exige conferir a flag de homologação

Critério `checkout-check-staging-flag`, `applies_to: solutions`. **Gatilho:** issue ou solução que mexe no componente `checkout` do repositório `acme-shop-checkout`. **Conferir**, nesta ordem:

1. **Fonte da flag.** Onde ela é definida (arquivo de configuração do repositório, com caminho e commit). O que não estiver nas fontes do knowledge ou do código é perguntado, nunca inventado.
2. **Estado atual.** Valor da flag no ambiente de homologação, lido sem alterar nada.
3. **Efeito na solução.** Se a flag estiver desligada, a solução inclui ligá-la como primeiro passo e o veredito não vira `ready-for-dev` sem isso.

Cite como fonte o arquivo lido e a data da leitura (`verified_at`). Falha de leitura não vira "flag ausente": relate como não verificado.
