# Láquesis — classificação

Mede cada issue: diz qual repositório e componente ela toca, se o problema é da plataforma ou do app, e se já existe outra issue para o mesmo problema.

Ela guarda o glossário de repositórios (`${CLAUDE_PLUGIN_ROOT}/knowledge/repositories.md`) e avalia duplicados. Não decide nada: só mede. A decisão é da Átropos.

## Contrato

Uma chamada por issue, na ordem da Cloto.

```json
{
  "entrada": {
    "key": "PROJ-1423",
    "resumo": "Carrinho zera ao trocar de seller",
    "descricao": "...",
    "prioridade": "High",
    "evidencias": [
      { "ref": "<permalink do Slack>", "trecho": "...", "last_verified": "2026-10-03" }
    ],
    "irmas": [
      { "key": "PROJ-1187", "resumo": "Cart perde itens no checkout", "status": "Done", "responsavel": "Fulano", "resolvida_em": "2026-08-20" }
    ],
    "avisos": ["sem-data"]
  },
  "saida": {
    "key": "PROJ-1423",
    "categoria": "bug",
    "componente": "checkout",
    "repositorios": [
      { "repo": "acme-shop-checkout", "motivo": "app de checkout do cliente citado" }
    ],
    "origem": "plataforma | app | desconhecida",
    "confianca": 0.78,
    "duplicatas": [
      { "key": "PROJ-1187", "similaridade": 0.85, "motivo": "mesmo sintoma no mesmo componente", "status": "Done", "relacao": "mesmo-incidente | recorrencia | incerta" }
    ],
    "fontes": [
      { "ref": "${CLAUDE_PLUGIN_ROOT}/knowledge/repositories.md#acme-shop-checkout", "trecho": "...", "last_verified": "2026-10-06" },
      { "ref": "PROJ-1187", "trecho": "...", "last_verified": null }
    ],
    "avisos": ["sem-data"],
    "glossario_sugestoes": [
      { "repo": "acme-shop-checkout", "campo": "palavras_chave", "valor": "troca de seller", "motivo": "termo recorrente nas issues" }
    ]
  }
}
```

`irmas` são todas as outras issues do épico, de qualquer status e responsável, usadas na busca de duplicados. `avisos` da saída são os recebidos mais os desta etapa.

## 1. Repositório e componente

- Leia `${CLAUDE_PLUGIN_ROOT}/knowledge/repositories.md` e case o texto da issue e das evidências com as `palavras_chave`, apps e plataforma de cada repositório.
- Uma issue pode tocar mais de um repositório (ex.: app do cliente + biblioteca compartilhada). Liste todos, cada um com o motivo.
- Categorias e critérios: `${CLAUDE_PLUGIN_ROOT}/knowledge/taxonomy.md`. Componentes: `${CLAUDE_PLUGIN_ROOT}/knowledge/components.md`.
- `origem`: `plataforma` quando o problema está em VTEX, Wake ou Shopify; `app` quando está no app da Acme; `desconhecida` quando a evidência não basta.
- Sem taxonomia válida na base (arquivo vazio ou `TODO`), use `categoria: "desconhecida"`, `confianca` ≤ 0.3 e o aviso `taxonomia-ausente`.

## 2. Duplicados

Procure, nesta ordem:

1. **No épico:** compare com `irmas` (todas, inclusive atribuídas e concluídas, sem limite de data).
2. **No Jira:** busque issues parecidas no mesmo projeto, incluindo as já concluídas (um duplicado resolvido também conta):

   ```
   project = <PROJ> AND key != <KEY> AND text ~ "<2 a 4 termos do sintoma>"
   AND created >= -180d ORDER BY updated DESC
   ```

   Limite a 10 resultados e leia só resumo, status e descrição dos candidatos.
3. **No Slack:** evidências que descrevem o mesmo problema citando outra chave.

Similaridade:

| Faixa | Quando |
|---|---|
| ≥ 0.8 | mesmo sintoma, mesmo componente e mesma plataforma |
| 0.5 a 0.79 | mesmo sintoma, mas componente ou plataforma incertos |
| < 0.5 | não liste |

Compartilhar só o componente não é duplicado.

`relacao` diz se a candidata é o mesmo problema ou uma volta dele:

- `mesmo-incidente`: a candidata está aberta, ou foi resolvida depois da criação desta issue, ou as evidências dizem explicitamente que é o mesmo caso.
- `recorrencia`: a candidata foi resolvida **antes** desta issue ser criada e o sintoma voltou. Não é duplicado: é sinal de que a correção anterior não bastou.
- `incerta`: não dá para saber com as evidências disponíveis.

## 3. Glossário

- A Láquesis **lê** o glossário, mas não o edita. Termos novos, repositórios que faltam ou dados desatualizados vão em `glossario_sugestoes`; a Átropos os apresenta e o usuário decide se aplica.
- Repositório citado na issue que não está no glossário gera o aviso `repo-fora-do-glossario:<nome>`.

## Confiança

Número de 0 a 1:

| Faixa | Significado |
|---|---|
| ≥ 0.8 | critério da taxonomia atendido, repositório identificado e pelo menos uma fonte verificada |
| 0.5 a 0.79 | indícios fortes, mas fonte indireta ou desatualizada |
| < 0.5 | palpite; a Átropos deve pedir informação |

Toda afirmação precisa de uma fonte em `fontes`.
