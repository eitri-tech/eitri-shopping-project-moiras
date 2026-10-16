/* Usage:
 * node knowledge.ts hash --base ~/work/acme-shop-checkout README.md package.json src/views
 * node knowledge.ts check .moiras/knowledge [--only glossary|criteria|learnings]
 * node knowledge.ts plan --local .moiras/knowledge --shared ../acme-knowledge
 *
 * Read-only helpers for moiras-index, moiras-audit and moiras-publish. They never write
 * to a knowledge and never print the content of a record, only paths, rules and line numbers.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable (no enums, namespaces or
 * parameter properties) and import siblings with the .ts extension.
 */
import { hash as digest } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { hash } from './memory.ts';

export const usage = 'Usage: node knowledge.ts hash --base <dir> <path...> | check <dir> [--only glossary|criteria|learnings] | plan --local <dir> --shared <dir>';

type Value = string | string[];
type Severity = 'error' | 'warning';
type Scope = 'glossary' | 'criteria' | 'learnings';

export interface Doc {
  fields: Record<string, Value>;
  body: string;
  /** Line (1-based) where the body starts, so findings point at the right line. */
  bodyLine: number;
}

export interface Finding {
  path: string;
  rule: string;
  severity: Severity;
  line?: number;
}

export interface Item {
  path: string;
  action: 'add' | 'update' | 'skip' | 'conflict';
  reason: string;
}

export interface Plan {
  items: Item[];
  remove: { path: string; replacedBy: string }[];
}

interface Kind {
  dir: string;
  scope: Scope;
  type: string;
  date: 'indexed_at' | 'created_at';
}

export const kinds: readonly Kind[] = [
  { dir: 'glossary', scope: 'glossary', type: 'repository', date: 'indexed_at' },
  { dir: 'criteria', scope: 'criteria', type: 'criterion', date: 'created_at' },
  { dir: 'learnings/solutions', scope: 'learnings', type: 'solution', date: 'created_at' },
  { dir: 'learnings/patterns', scope: 'learnings', type: 'pattern', date: 'created_at' },
  { dir: 'learnings/decisions', scope: 'learnings', type: 'decision', date: 'created_at' },
];

const maxSnippetLines = 20;
export const observationMarker = '**Observação:**';
const results = new Set(['pending', 'resolved', 'not-resolved']);
const skipped = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.direnv']);

// What a record must never carry. Matches are reported by rule and line, never echoed.
const patterns: { rule: string; test: RegExp }[] = [
  { rule: 'absolute-path', test: /(?:(?<![\w.~-])\/(?:home|Users)\/[\w.-]+\/|(?<![\w.-])~\/[\w.-]+|[A-Za-z]:\\Users\\[\w.-]+)/ },
  {
    rule: 'secret',
    test: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[\w.~+/-]{20,}|(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"'<>]{8,})/i,
  },
];

export function parseDoc(text: string): Doc | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const fields: Record<string, Value> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2]!;
    fields[key] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean)
      : raw.replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fields, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 };
}

const asText = (value: Value | undefined): string => (Array.isArray(value) ? value.join(', ') : value ?? '');

export interface Entry {
  path: string;
  kind: Kind;
  text: string;
  doc: Doc | null;
}

/** The markdown records of a knowledge, in a stable order. `.gitkeep` and other files are ignored. */
export function records(dir: string, only?: Scope): Entry[] {
  return kinds
    .filter(kind => only === undefined || kind.scope === only)
    .flatMap(kind => {
      const folder = join(dir, kind.dir);
      if (!existsSync(folder)) return [];
      return readdirSync(folder)
        .filter(name => name.endsWith('.md'))
        .sort()
        .map(name => {
          const text = readFileSync(join(folder, name), 'utf8');
          return { path: `${kind.dir}/${name}`, kind, text, doc: parseDoc(text) };
        });
    });
}

export function check(dir: string, only?: Scope): { checked: number; findings: Finding[] } {
  const all = records(dir, only);
  const findings: Finding[] = [];
  for (const { path, kind, text, doc } of all) {
    const add = (rule: string, severity: Severity, line?: number) =>
      findings.push(line === undefined ? { path, rule, severity } : { path, rule, severity, line });
    const lines = text.replaceAll('\r\n', '\n').split('\n');

    if (!doc) {
      add('frontmatter-missing', 'error');
    } else {
      const { fields } = doc;
      if (asText(fields.id) !== path.slice(path.lastIndexOf('/') + 1, -'.md'.length)) add('id-mismatch', 'error');
      if (asText(fields.type) !== kind.type) add('type-mismatch', 'error');
      const date = asText(fields[kind.date]);
      if (!date) add('date-missing', 'error');
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) add('date-invalid', 'error');
      if (Object.values(fields).some(value => /<[^>]*>|AAAA-MM-DD|\s\|\s/.test(asText(value)))) add('placeholder', 'error');
      if (kind.type === 'criterion' && !asText(fields.approved_by)) add('approved-by-missing', 'error');
      if (kind.type === 'solution' && !results.has(asText(fields.result))) add('result-invalid', 'error');
      if (kind.type === 'repository' && !/^sha256:[0-9a-f]{64}$/.test(asText(fields.sources_hash))) add('sources-hash-invalid', 'error');
      if (/\bTODO\b/.test(doc.body)) add('todo-content', 'warning');
    }

    lines.forEach((line, index) => {
      for (const { rule, test } of patterns) if (test.test(line)) add(rule, 'error', index + 1);
    });

    // Snippets: at most one, at most 20 lines, always with a reference (repository/path@commit).
    const fences = lines.flatMap((line, index) => (line.trimStart().startsWith('```') ? [index] : []));
    if (fences.length % 2 === 1) add('code-fence-unclosed', 'error', (fences.at(-1) ?? 0) + 1);
    const blocks = Array.from({ length: Math.floor(fences.length / 2) }, (_, n) => [fences[2 * n]!, fences[2 * n + 1]!] as const);
    if (blocks.length > 1) add('multiple-snippets', 'error', blocks[1]![0] + 1);
    for (const [open, close] of blocks) {
      if (close - open - 1 > maxSnippetLines) add('code-too-long', 'error', open + 1);
      const around = lines.slice(Math.max(0, open - 3), close + 4).join('\n');
      if (!/\S+@[0-9a-f]{7,40}\b/.test(around)) add('code-without-reference', 'error', open + 1);
    }
  }
  return { checked: all.length, findings };
}

/** Everything but `result` in the frontmatter, and everything before the observation, must be equal. */
function sameExceptResult(local: Doc, shared: Doc): boolean {
  const strip = ({ fields }: Doc) => JSON.stringify(Object.entries(fields).filter(([key]) => key !== 'result').sort());
  const head = ({ body }: Doc) => body.split(observationMarker)[0]!.trimEnd();
  return strip(local) === strip(shared) && head(local) === head(shared);
}

export function plan(localDir: string, sharedDir: string): Plan {
  const shared = new Map(records(sharedDir).map(entry => [entry.path, entry]));
  const items: Item[] = [];
  const remove: Plan['remove'] = [];
  for (const local of records(localDir)) {
    const { path, kind, text, doc } = local;
    const other = shared.get(path);
    const item = (action: Item['action'], reason: string) => items.push({ path, action, reason });
    if (!other) item('add', 'new');
    else if (other.text === text) item('skip', 'unchanged');
    else if (kind.type === 'solution' && doc && other.doc && sameExceptResult(doc, other.doc)) item('update', 'result-or-observation');
    else if (kind.type === 'repository' && doc && other.doc) {
      if (asText(doc.fields.indexed_at) > asText(other.doc.fields.indexed_at)) item('update', 'newer-index');
      else item('skip', 'shared-is-newer-or-equal');
    } else item('conflict', kind.type === 'criterion' ? 'change-by-replaces' : 'append-only');

    if (kind.type === 'criterion' && doc) {
      const replaces = Array.isArray(doc.fields.replaces) ? doc.fields.replaces : [];
      for (const id of replaces) {
        const old = `${kind.dir}/${id}.md`;
        if (shared.has(old) && old !== path) remove.push({ path: old, replacedBy: path });
      }
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  remove.sort((a, b) => a.path.localeCompare(b.path));
  return { items, remove };
}

/**
 * Fingerprint of what a record was derived from: the content of files, and only the names
 * inside directories. A path that does not exist is ignored, so an optional file does not
 * change the hash until it shows up.
 */
export function sourcesHash(base: string, paths: string[]): string {
  const entries: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      if (skipped.has(name)) continue;
      const full = join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else entries.push(`name:${relative(base, full)}`);
    }
  };
  for (const path of paths) {
    const full = join(base, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full);
    else entries.push(`file:${path}:${digest('sha256', readFileSync(full))}`);
  }
  return hash([...new Set(entries)].sort().join('\n'));
}

const scopeOf = (value: string | undefined): Scope | undefined => {
  if (value === undefined) return undefined;
  if (value === 'glossary' || value === 'criteria' || value === 'learnings') return value;
  throw new Error(`Invalid --only. ${usage}`);
};

export function main(argv: string[]): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        only: { type: 'string' },
        local: { type: 'string' },
        shared: { type: 'string' },
      },
    });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${usage}`);
  }
  const { positionals: [command, ...rest], values } = parsed;
  if (command === 'hash') {
    if (values.base === undefined || !rest.length) throw new Error(usage);
    return { output: sourcesHash(values.base, rest), code: 0 };
  }
  if (command === 'check') {
    if (rest.length !== 1) throw new Error(usage);
    const result = check(rest[0]!, scopeOf(values.only));
    return { output: JSON.stringify(result), code: result.findings.some(f => f.severity === 'error') ? 1 : 0 };
  }
  if (command === 'plan') {
    if (values.local === undefined || values.shared === undefined || rest.length) throw new Error(usage);
    return { output: JSON.stringify(plan(values.local, values.shared)), code: 0 };
  }
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    const { output, code } = main(process.argv.slice(2));
    process.stdout.write(`${output}\n`);
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
