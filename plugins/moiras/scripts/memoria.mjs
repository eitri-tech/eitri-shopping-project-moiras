/* Usage:
 * echo '{"b":2,"a":1}' | node memoria.mjs hash
 * echo '{"chave":"PROJ-1","conteudo":{}}' | node memoria.mjs registrar cloto
 * node memoria.mjs consultar cloto --dir .moiras/memoria --desde 2026-01-01T00:00:00Z
 */
import { hash as digest } from 'node:crypto';
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export const usage = 'Uso: node memoria.mjs hash | registrar <cloto|laquesis|atropos> [--dir <path>] | consultar <etapa> [--dir <path>] [--chave <k>] [--desde <ISO>]';
export const etapas = new Set(['cloto', 'laquesis', 'atropos']);
export const diretorioPadrao = '.moiras/memoria';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// JSON with object keys sorted recursively; arrays keep their order.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hash = value => `sha256:${digest('sha256', typeof value === 'string' ? value : canonical(value))}`;

// Stdin of the hash command: JSON when it parses, otherwise normalized text.
export function parseConteudo(raw) {
  try { return JSON.parse(raw); }
  catch { return raw.replaceAll('\r\n', '\n').replace(/\n+$/, ''); }
}

export function lerRegistros(file, avisar = message => process.stderr.write(`${message}\n`)) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { registros: [], source: '' };
    throw error;
  }
  const registros = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const registro = JSON.parse(line);
      if (!isObject(registro) || typeof registro.chave !== 'string') throw new Error('registro inválido');
      registros.push(registro);
    } catch {
      avisar(`Aviso: linha inválida ignorada em ${file}:${index + 1}`);
    }
  }
  return { registros, source };
}

const ultimos = registros => new Map(registros.map(registro => [registro.chave, registro]));

export function registrar(etapa, input, { dir = diretorioPadrao, agora = () => new Date().toISOString(), avisar } = {}) {
  const lote = (Array.isArray(input) ? input : [input]).map(registro => {
    if (!isObject(registro) || typeof registro.chave !== 'string') throw new Error('Cada registro deve ter chave string.');
    const { conteudo, ...resto } = registro;
    if (Object.hasOwn(registro, 'conteudo')) resto.hash = hash(conteudo);
    else if (!Object.hasOwn(registro, 'hash')) throw new Error('Registro sem conteudo ou hash.');
    resto.ts ??= agora();
    return resto;
  });
  // The whole batch is validated above, before anything is created or appended.
  const file = join(dir, `${etapa}.jsonl`);
  const { registros, source } = lerRegistros(file, avisar);
  const latest = ultimos(registros);
  const resultado = lote.map(registro => {
    const anterior = latest.get(registro.chave);
    registro.mudanca = !anterior ? 'novo' : anterior.hash === registro.hash ? 'inalterado' : 'alterado';
    latest.set(registro.chave, registro);
    return { chave: registro.chave, hash: registro.hash, mudanca: registro.mudanca };
  });
  if (lote.length) {
    mkdirSync(dir, { recursive: true });
    const separator = source && !source.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${separator}${lote.map(registro => JSON.stringify(registro)).join('\n')}\n`);
  }
  return resultado;
}

export function consultar(etapa, { dir = diretorioPadrao, chave, desde, avisar } = {}) {
  const since = desde === undefined ? null : Date.parse(desde);
  if (Number.isNaN(since)) throw new Error(`Data inválida. ${usage}`);
  const { registros } = lerRegistros(join(dir, `${etapa}.jsonl`), avisar);
  return ultimos(registros).values()
    .filter(registro => (chave === undefined || registro.chave === chave) &&
      (since === null || Date.parse(registro.ts) >= since))
    .toArray();
}

export function main(argv, stdin = () => readFileSync(0, 'utf8')) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { dir: { type: 'string' }, chave: { type: 'string' }, desde: { type: 'string' } },
    });
  } catch (error) {
    throw new Error(`${error.message}\n${usage}`);
  }
  const { positionals: [comando, etapa, ...extra], values } = parsed;
  if (comando === 'hash') {
    if (etapa !== undefined || Object.keys(values).length) throw new Error(usage);
    return hash(parseConteudo(stdin()));
  }
  if (!['registrar', 'consultar'].includes(comando) || extra.length) throw new Error(usage);
  if (!etapas.has(etapa)) throw new Error(`Etapa inválida. ${usage}`);
  if (comando === 'registrar') {
    if (values.chave !== undefined || values.desde !== undefined) throw new Error(usage);
    return JSON.stringify(registrar(etapa, JSON.parse(stdin()), values));
  }
  return JSON.stringify(consultar(etapa, values));
}

if (import.meta.main) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
