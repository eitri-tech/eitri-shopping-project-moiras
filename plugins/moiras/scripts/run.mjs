// Launcher dos scripts do Moiras. Node < 22.18 não executa .ts e falha com um erro que não diz a versão,
// então este arquivo (JavaScript comum, legível em Node antigo) confere a versão antes de carregar o .ts.
// Uso: node scripts/run.mjs <config|github|knowledge|learn-github|memory> [argumentos]
// MOIRAS_TEST_NODE_VERSION existe só para os testes (run.test.ts): substitui a versão lida do processo.
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIS = ['config', 'github', 'knowledge', 'learn-github', 'memory'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

// Versão mínima: 22.18.0 (sem pré-lançamento, pois semver ordena 22.18.0-pre antes de 22.18.0).
function atLeast22_18(core, prerelease) {
  const min = [22, 18, 0];
  for (let i = 0; i < 3; i++) {
    if (core[i] !== min[i]) return core[i] > min[i];
  }
  return !prerelease;
}

// Retorna a mensagem de erro para a versão dada, ou null quando o Node serve.
export function checkNodeVersion(version) {
  const match = typeof version === 'string' ? SEMVER.exec(version) : null;
  if (!match) return 'O Moiras precisa do Node 22.18 ou mais novo (versão não identificada).';
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (atLeast22_18(core, match[4] !== undefined)) return null;
  return `O Moiras precisa do Node 22.18 ou mais novo (encontrado v${version}).`;
}

async function launch(argv) {
  const message = checkNodeVersion(process.env.MOIRAS_TEST_NODE_VERSION ?? process.versions.node);
  if (message !== null) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }
  const [name, ...args] = argv;
  // Lista fechada: o nome nunca vira caminho sem passar por aqui (sem ../, barra nem extensão).
  if (!CLIS.includes(name)) {
    process.stderr.write(`uso: node run.mjs <${CLIS.join('|')}> [argumentos]\n`);
    process.exitCode = 2;
    return;
  }
  let cli;
  try {
    cli = await import(pathToFileURL(join(HERE, `${name}.ts`)).href);
  } catch {
    process.stderr.write('Não foi possível carregar o script.\n');
    process.exitCode = 2;
    return;
  }
  cli.runCli(args);
}

// Só roda quando é o arquivo executado; importar (como nos testes) não dispara nada.
function isEntry() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) await launch(process.argv.slice(2));
