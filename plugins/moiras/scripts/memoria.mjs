/* Usage:
 * echo '{"b":2,"a":1}' | node memoria.mjs hash
 * echo '{"chave":"PROJ-1","conteudo":{}}' | node memoria.mjs registrar cloto
 * node memoria.mjs consultar cloto --dir .moiras/memoria --desde 2026-01-01T00:00:00Z
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const usage = 'Uso: node memoria.mjs hash | registrar <cloto|laquesis|atropos> [--dir <path>] | consultar <etapa> [--dir <path>] [--chave <k>] [--desde <ISO>]';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  const content = typeof value === 'string' ? value : stable(value);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function readRecords(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], source: '' };
    throw error;
  }
  const records = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (index === lines.length - 1 && !line) return;
    try {
      const record = JSON.parse(line);
      if (!object(record) || typeof record.chave !== 'string') throw new Error('registro inválido');
      records.push(record);
    } catch {
      process.stderr.write(`Aviso: linha inválida ignorada em ${file}:${index + 1}\n`);
    }
  });
  return { records, source };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'hash') {
    if (args.length) throw new Error(usage);
    const raw = readFileSync(0, 'utf8');
    let value;
    try { value = JSON.parse(raw); }
    catch { value = raw.replace(/\r\n/g, '\n').replace(/\n+$/, ''); }
    process.stdout.write(`${hash(value)}\n`);
    return;
  }
  if (!['registrar', 'consultar'].includes(command)) throw new Error(usage);
  const stage = args.shift();
  if (!['cloto', 'laquesis', 'atropos'].includes(stage)) throw new Error(`Etapa inválida. ${usage}`);
  const options = { '--dir': '.moiras/memoria' };
  const allowed = command === 'registrar' ? ['--dir'] : ['--dir', '--chave', '--desde'];
  while (args.length) {
    const option = args.shift();
    if (!allowed.includes(option) || !args.length || args[0].startsWith('--')) throw new Error(usage);
    options[option] = args.shift();
  }
  const since = own(options, '--desde') ? Date.parse(options['--desde']) : null;
  if (since !== null && Number.isNaN(since)) throw new Error(`Data inválida. ${usage}`);
  const file = join(options['--dir'], `${stage}.jsonl`);
  let batch;
  if (command === 'registrar') {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    batch = Array.isArray(input) ? input : [input];
    // Validate the entire batch before creating or appending files.
    batch.forEach(record => {
      if (!object(record) || typeof record.chave !== 'string') throw new Error('Cada registro deve ter chave string.');
      if (own(record, 'conteudo')) {
        record.hash = hash(record.conteudo);
        delete record.conteudo;
      } else if (!own(record, 'hash')) throw new Error('Registro sem conteudo ou hash.');
      if (!own(record, 'ts')) record.ts = new Date().toISOString();
    });
  }
  const { records, source } = readRecords(file);
  const latest = new Map(records.map(record => [record.chave, record]));
  if (command === 'consultar') {
    const result = [...latest.values()].filter(record =>
      (!own(options, '--chave') || record.chave === options['--chave']) &&
      (since === null || Date.parse(record.ts) >= since));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const result = batch.map(record => {
    const previous = latest.get(record.chave);
    record.mudanca = !previous ? 'novo' : previous.hash === record.hash ? 'inalterado' : 'alterado';
    latest.set(record.chave, record);
    return { chave: record.chave, hash: record.hash, mudanca: record.mudanca };
  });
  if (batch.length) {
    mkdirSync(options['--dir'], { recursive: true });
    const separator = source && !source.endsWith('\n') ? '\n' : '';
    appendFileSync(file, separator + batch.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
