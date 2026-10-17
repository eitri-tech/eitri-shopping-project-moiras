/* Usage:
 * echo '{"b":2,"a":1}' | node memory.ts hash
 * echo '{"key":"jira:PROJ-1","content":{}}' | node memory.ts record clotho
 * node memory.ts query clotho --dir .moiras/memory --since 2026-01-01T00:00:00Z
 *
 * Runs as-is on Node 24 (type stripping): keep the syntax erasable (no enums,
 * namespaces or parameter properties) and import siblings with the .ts extension.
 */
import { hash as digest } from 'node:crypto';
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export type Stage = 'clotho' | 'lachesis' | 'atropos';
export type Change = 'new' | 'changed' | 'unchanged';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A line of the memory file. Raw content is never stored, only its hash. */
export interface MemoryRecord {
  key: string;
  hash: string;
  ts: string;
  change?: Change;
  [field: string]: unknown;
}

/** What callers hand to `record`: either `content` (hashed here) or a ready `hash`. */
export type Entry = { key: string; ts?: string; [field: string]: unknown } & (
  | { content: unknown; hash?: never }
  | { hash: string; content?: never }
);

export interface Result {
  key: string;
  hash: string;
  change: Change;
}

interface Options {
  dir?: string;
  warn?: (message: string) => void;
}

export const usage = 'Usage: node memory.ts hash | record <clotho|lachesis|atropos> [--dir <path>] | query <stage> [--dir <path>] [--key <k>] [--since <ISO>]';
export const stages: ReadonlySet<string> = new Set<Stage>(['clotho', 'lachesis', 'atropos']);
export const defaultDir = '.moiras/memory';

const stageFields: Record<Stage, readonly string[]> = {
  clotho: ['source', 'with_whom', 'updated_at'],
  lachesis: ['category', 'component', 'repositories', 'origin', 'complex', 'confidence', 'duplicates'],
  atropos: ['mode', 'action', 'solutions', 'choice', 'id'],
};
const commonFields = ['key', 'content', 'hash', 'ts', 'run_id'];
const hashPattern = /^sha256:[0-9a-fA-F]{64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// JSON with object keys sorted recursively; arrays keep their order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hash = (value: unknown): string =>
  `sha256:${digest('sha256', typeof value === 'string' ? value : canonical(value))}`;

// Stdin of the hash command: JSON when it parses, otherwise normalized text.
export function parseContent(raw: string): Json | string {
  try { return JSON.parse(raw) as Json; }
  catch { return raw.replaceAll('\r\n', '\n').replace(/\n+$/, ''); }
}

export function readRecords(
  file: string,
  warn: (message: string) => void = message => process.stderr.write(`${message}\n`),
): { records: MemoryRecord[]; source: string } {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], source: '' };
    throw error;
  }
  const records: MemoryRecord[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (isObject(record) && Object.hasOwn(record, 'chave')) {
        warn(`Warning: skipped legacy Portuguese-key record in ${file}:${index + 1}; re-collect with English keys; file left unchanged.`);
        continue;
      }
      if (!isObject(record) || typeof record.key !== 'string') throw new Error('invalid record');
      records.push(record as MemoryRecord);
    } catch {
      warn(`Warning: skipped invalid line in ${file}:${index + 1}`);
    }
  }
  return { records, source };
}

const latestByKey = (records: MemoryRecord[]): Map<string, MemoryRecord> =>
  new Map(records.map(record => [record.key, record]));

export function record(
  stage: Stage,
  input: unknown,
  { dir = defaultDir, now = () => new Date().toISOString(), warn }: Options & { now?: () => string } = {},
): Result[] {
  const batch = (Array.isArray(input) ? input : [input]).map((entry: unknown): MemoryRecord => {
    if (!isObject(entry) || typeof entry.key !== 'string') throw new Error('Every record needs a string key.');
    const allowed = new Set([...commonFields, ...stageFields[stage]]);
    for (const field of Object.keys(entry)) {
      if (!allowed.has(field)) throw new Error(`Unknown ${stage} field: ${field}`);
    }
    if (Object.hasOwn(entry, 'hash') &&
        (typeof entry.hash !== 'string' || !hashPattern.test(entry.hash))) {
      throw new Error('Hash must be sha256:<64 hex digits>.');
    }
    if (Object.hasOwn(entry, 'hash') && Object.hasOwn(entry, 'content')) {
      throw new Error('Use content or hash, not both.');
    }
    // Nested metadata has its own allowlist; raw payload belongs only in content.
    const nestedFields = stage === 'clotho' ? { with_whom: ['reporter', 'updated_by', 'author', 'channel'] }
      : stage === 'atropos' ? { solutions: ['title', 'confidence'] } : {};
    for (const [field, fields] of Object.entries(nestedFields)) {
      if (!Object.hasOwn(entry, field)) continue;
      const values = field === 'solutions' ? entry[field] : [entry[field]];
      if (!Array.isArray(values) || values.some(value => !isObject(value) ||
          Object.keys(value).some(key => !fields.includes(key)) ||
          Object.values(value).some(value => typeof value !== 'string' && typeof value !== 'number'))) {
        throw new Error(`Invalid metadata: ${field}`);
      }
    }
    for (const field of stageFields[stage]) {
      if (!Object.hasOwn(entry, field) || field === 'with_whom' || field === 'solutions') continue;
      const value = entry[field];
      const valid = field === 'repositories' || field === 'duplicates'
        ? Array.isArray(value) && value.every(item => typeof item === 'string')
        : field === 'complex' ? typeof value === 'boolean'
        : field === 'confidence' ? typeof value === 'number' && Number.isFinite(value)
        : field === 'choice' ? value === null || typeof value === 'number' || value === 'none'
        : typeof value === 'string';
      if (!valid) throw new Error(`Invalid metadata: ${field}`);
    }
    for (const field of ['ts', 'run_id']) {
      if (Object.hasOwn(entry, field) && typeof entry[field] !== 'string') {
        throw new Error(`Invalid metadata: ${field}`);
      }
    }
    // Atropos records must agree internally: action and mode use the documented values,
    // a chosen solution is numbered against the summary list, and a learning id only
    // coexists with that choice.
    if (stage === 'atropos') {
      const action = entry.action;
      if (action !== undefined && !['duplicate', 'blocked', 'ready-for-dev', 'needs-info', 'close'].includes(action as string)) {
        throw new Error('Invalid metadata: action');
      }
      if (entry.mode !== undefined && entry.mode !== 'interactive' && entry.mode !== 'auto') {
        throw new Error('Invalid metadata: mode');
      }
      if (Object.hasOwn(entry, 'choice') && typeof entry.choice === 'number') {
        const solutions = Array.isArray(entry.solutions) ? entry.solutions : [];
        if (solutions.length === 0 || (entry.choice as number) < 1 || (entry.choice as number) > solutions.length) {
          throw new Error('Invalid metadata: choice');
        }
      }
      if (Object.hasOwn(entry, 'id') && !(typeof entry.choice === 'number' && (entry.choice as number) >= 1)) {
        throw new Error('Invalid metadata: id');
      }
    }
    const { content, ...rest } = entry;
    if (Object.hasOwn(entry, 'content')) rest.hash = hash(content);
    else if (!Object.hasOwn(entry, 'hash')) throw new Error('Record without content or hash.');
    rest.ts ??= now();
    return rest as MemoryRecord;
  });
  // The whole batch is validated above, before anything is created or appended.
  const file = join(dir, `${stage}.jsonl`);
  const { records, source } = readRecords(file, warn);
  const latest = latestByKey(records);
  const results = batch.map((entry): Result => {
    const previous = latest.get(entry.key);
    entry.change = !previous ? 'new' : previous.hash === entry.hash ? 'unchanged' : 'changed';
    latest.set(entry.key, entry);
    return { key: entry.key, hash: entry.hash, change: entry.change };
  });
  if (batch.length) {
    mkdirSync(dir, { recursive: true });
    const separator = source && !source.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${separator}${batch.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  }
  return results;
}

export function query(
  stage: Stage,
  { dir = defaultDir, key, since, warn }: Options & { key?: string; since?: string } = {},
): MemoryRecord[] {
  const sinceTime = since === undefined ? null : Date.parse(since);
  if (sinceTime !== null && Number.isNaN(sinceTime)) throw new Error(`Invalid date. ${usage}`);
  const { records } = readRecords(join(dir, `${stage}.jsonl`), warn);
  return latestByKey(records).values()
    .filter(entry => (key === undefined || entry.key === key) &&
      (sinceTime === null || Date.parse(entry.ts) >= sinceTime))
    .toArray();
}

const isStage = (value: string | undefined): value is Stage => value !== undefined && stages.has(value);

export function main(argv: string[], stdin: () => string = () => readFileSync(0, 'utf8')): string {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { dir: { type: 'string' }, key: { type: 'string' }, since: { type: 'string' } },
    });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${usage}`);
  }
  const { positionals: [command, stage, ...extra], values } = parsed;
  if (command === 'hash') {
    if (stage !== undefined || Object.keys(values).length) throw new Error(usage);
    return hash(parseContent(stdin()));
  }
  if (!['record', 'query'].includes(command ?? '') || extra.length) throw new Error(usage);
  if (!isStage(stage)) throw new Error(`Invalid stage. ${usage}`);
  if (command === 'record') {
    if (values.key !== undefined || values.since !== undefined) throw new Error(usage);
    return JSON.stringify(record(stage, JSON.parse(stdin()), values));
  }
  return JSON.stringify(query(stage, values));
}

if (import.meta.main) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
