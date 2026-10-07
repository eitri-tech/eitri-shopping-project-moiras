# moiras
Analisar, conhecer e gerar soluções com base de conhecimento.

## Plugin

- [`plugins/moiras`](plugins/moiras): triagem de issues do Jira com base de conhecimento do projeto (Cloto → Láquesis → Átropos).

## Ambiente de desenvolvimento

Com Nix e direnv: `direnv allow` (ou `nix develop`) entra num shell com Node LTS, TypeScript (só para checar tipos: `tsc -p tsconfig.json`), Python 3 e jq. Sem Nix: `nvm use`.
