---
name: moiras-teach
description: "Ensina o knowledge das Moiras: transforma uma regra que o usuário dita (\"sempre que mexer com X, precisa de Y\") em critério em criteria/, com gatilho, o que conferir e como conferir, sempre com o \"sim\" à lista exata. Use para incrementar o knowledge, por exemplo: \"sempre que trabalhar com deeplink, App Link ou assetlinks, confira o Digital Asset Links (/.well-known/assetlinks.json) do domínio contra o package name e o fingerprint do app\"."
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
2. **Procurar o que já existe.** Leia `criteria/` de todos os knowledges configurados (título, `applies_to`, gatilho). Regra equivalente: não crie outra, mostre a existente. Regra que conflita: proponha um critério regenerado com `replaces` (apague só os antigos do knowledge local; os compartilhados ficam intocados e são citados como `knowledge:<name>/criteria/<arquivo>.md`).
3. **Rascunhar** o critério no modelo de `_templates/` do knowledge (sem ele, o modelo de `moiras-triage/stages/atropos.md`, seção 8), com `id` curto em inglês, `created_at` de hoje, `applies_to` e `replaces`. O corpo diz a regra em uma ou duas frases, o **Gatilho**, a lista **Conferir** e o **Por quê**. Sem segredo, dado pessoal, texto bruto de issue ou código com mais de 20 linhas (sempre com referência).
4. **Mostrar a lista exata** (arquivos a criar e a apagar) e pedir o "sim", mais um pseudônimo para `approved_by` (`reviewer-01`, `user-7`; ver "Regras de escrita" em `moiras-triage/SKILL.md`). Ajuste pedido volta para um novo "sim".
5. **Gravar** só o aprovado, um arquivo por critério, sem sobrescrever.
6. **Conferir** e corrigir o que falhar (correção que mude o conteúdo volta ao usuário):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/knowledge.ts" check <local-dir> --only criteria
   ```

7. **Relatar** o que foi gravado e sugerir `moiras-publish` se o time deve compartilhar a regra.

## Exemplo: deeplink exige assetlinks

Critério `deeplink-requires-assetlinks`, `applies_to: solutions`. **Gatilho:** issue ou solução que mexe em deeplink, App Link (`https` com `android:autoVerify`), esquema customizado trocado por link web, ou redirecionamento de links. **Conferir**, nesta ordem:

1. **Domínio e app.** Domínio dos links, `package_name` e fingerprints SHA-256 de cada assinatura em uso. Vêm do manifesto do app, da configuração da loja e do glossário; **o que não estiver nessas fontes é perguntado, nunca inventado**. Com Play App Signing, o fingerprint que vale é o da chave de assinatura do app no console da loja, não o da chave de upload.
2. **Arquivo ao vivo (só leitura).** Busque `https://<domínio>/.well-known/assetlinks.json` (e o `www.`, se os links usarem). Confira:
   - resposta `200` direta, sem redirecionamento, em HTTPS, `Content-Type: application/json`;
   - JSON válido, com uma entrada cujo `relation` inclui `delegate_permission/common.handle_all_urls`;
   - `target.namespace` = `android_app`, `target.package_name` igual ao do app, e **todos** os fingerprints em uso (release e, se for testar assim, debug) em `sha256_cert_fingerprints`, em maiúsculas e separados por `:`.
3. **Manifesto.** `<intent-filter android:autoVerify="true">` com `VIEW`, `DEFAULT`, `BROWSABLE` e os `scheme`/`host`/`pathPrefix` batendo com o que o arquivo cobre.
4. **Sinais de falha:** domínio ou subdomínio sem arquivo, arquivo servido por CDN com redirect, fingerprint de debug em produção, `package_name` de outro flavor, cache antigo (a verificação do Android não é imediata).
5. **iOS** é regra à parte (`apple-app-site-association`); se for necessário, ensine como um segundo critério.

Cite como fonte a URL consultada e a data da leitura (`verified_at`). Falha de rede não vira "arquivo ausente": relate como não verificado.
