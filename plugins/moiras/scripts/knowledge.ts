/* Usage:
 * node knowledge.ts hash --base ~/work/acme-shop-checkout README.md package.json src/views
 * node knowledge.ts check .moiras/knowledge [--only glossary|criteria|learnings]
 * node knowledge.ts plan --local .moiras/knowledge --shared ../acme-knowledge --shared-name acme
 *
 * Read-only helpers for moiras-index, moiras-audit and moiras-publish. They never write
 * to a knowledge and never print the content of a record, only paths, rules and line numbers.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable (no enums, namespaces or
 * parameter properties) and import siblings with the .ts extension.
 */
import { isUtf8 } from 'node:buffer';
import { hash as digest } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { hash } from './memory.ts';

export const usage = 'Usage: node knowledge.ts hash --base <dir> [--meta <json-string>] <path...> | check <dir> [--only glossary|criteria|learnings] | plan --local <dir> --shared <dir> [--shared-name <name>]';

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
// Frontmatter is metadata: a value that starts like a filesystem path is always machine-specific.
const absoluteValue = /^(?:\/|~|[A-Za-z]:[\\/])/;
const bodyPlaceholder = /<(?!https?:\/\/|mailto:)[^<>\n]{2,}>|AAAA-MM-DD/;
export const observationMarker = '**Observação:**';
const required: Record<string, string[]> = {
  solution: ['issue', 'chosen_by', 'repositories', 'category', 'confidence'],
  criterion: ['applies_to'],
  pattern: ['repositories', 'issues'],
  decision: ['source'],
};
const appliesTo = new Set(['category', 'origin', 'action', 'solutions']);
const results = new Set(['pending', 'resolved', 'not-resolved']);
const skipped = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.direnv']);

const maxFileBytes = 1024 * 1024;
const maxDepth = 32;
const maxLineLength = 8192;
const placeholder = (value: string) => /^(?:<[^>]+>|x{4,}|\*{4,})$/i.test(value);
const email = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,190}\.[A-Z]{2,24}\b/i;

// Inspect every path component before resolving; even links within the base are skipped.
function pathIssue(base: string, path: string): string | undefined {
  const root = resolve(base);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Path escapes base');
  const parts = rel ? rel.split(sep) : [];
  if (parts.length > maxDepth) return 'directory-too-deep';
  let current = root;
  for (const part of ['', ...parts]) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return 'symlink';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }
  // Also reject a symlink in an ancestor of the supplied base.
  if (realpathSync(root) !== root) return 'symlink';
  if (realpathSync(target) !== target) return 'symlink';
  return undefined;
}

function readSafe(file: string): { text?: string; issue?: string } {
  const stat = lstatSync(file);
  if (!stat.isFile()) return { issue: 'not-regular-file' };
  if (stat.size > maxFileBytes) return { issue: 'file-too-large' };
  const bytes = readFileSync(file);
  if (bytes.includes(0) || !isUtf8(bytes)) return { issue: 'binary-file' };
  return { text: bytes.toString('utf8') };
}

function hasSecret(line: string): boolean {
  const assignments = /\b([A-Z_][A-Z0-9_-]{0,127})\s*[:=]\s*["']?(<[^>]{1,128}>|[^\s"'`;,]{1,2048})/gi;
  for (const match of line.matchAll(assignments)) {
    const [, key = '', value = ''] = match;
    if (/(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE_KEY|CREDENTIAL|SESSION_ID|DATABASE_URL)/i.test(key) && !placeholder(value)) return true;
  }
  for (const match of line.matchAll(/[?&](?:access_token|token|key|password|secret|api_key)=([^\s&#"'`]{1,2048})/gi)) {
    let value = match[1]!;
    try { value = decodeURIComponent(value); } catch { /* Scan malformed values as supplied. */ }
    if (!placeholder(value)) return true;
  }
  return false;
}

// What a record must never carry. Matches are reported by rule and line, never echoed.
const patterns: { rule: string; test: RegExp }[] = [
  // Machine-specific paths in prose: personal homes and the usual system roots (a route like /home/products is not one).
  { rule: 'absolute-path', test: /(?:(?<![\w.~-])\/(?:home|Users)\/[\w.-]+\/|(?<![\w.~-])\/(?:root|srv|opt|workspaces?|tmp|var|mnt|usr|etc)\/[\w.-]+|(?<![\w.-])~\/[\w.-]+|[A-Za-z]:\\Users\\[\w.-]+)/ },
  // User info in a URL: user:password@ on any scheme, or a bare token@ on http(s).
  { rule: 'url-credentials', test: /\b(?:[a-z][\w+.-]*:\/\/[^\s/@:]{1,256}:[^\s/@]{1,256}@|https?:\/\/[^\s/@]{1,256}@)/i },
  { rule: 'personal-data', test: email },
  { rule: 'raw-conversation-reference', test: /\b[\w.-]{1,200}\.slack\.com\/archives\//i },
  {
    rule: 'secret',
    test: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[\w.~+/-]{20,})/i,
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
  issue?: string;
}

/** The markdown records of a knowledge, in a stable order. `.gitkeep` and other files are ignored. */
export function records(dir: string, only?: Scope): Entry[] {
  return kinds
    .filter(kind => only === undefined || kind.scope === only)
    .flatMap(kind => {
      const folder = join(dir, kind.dir);
      const folderIssue = pathIssue(dir, kind.dir);
      if (folderIssue === 'missing') return [];
      if (folderIssue) return [{ path: kind.dir, kind, text: '', doc: null, issue: folderIssue }];
      if (!lstatSync(folder).isDirectory()) return [{ path: kind.dir, kind, text: '', doc: null, issue: 'not-directory' }];
      return readdirSync(folder)
        .filter(name => name.endsWith('.md'))
        .sort()
        .map(name => {
          const path = `${kind.dir}/${name}`;
          const issue = pathIssue(dir, path);
          const result = issue ? { issue } : readSafe(join(folder, name));
          const text = result.text ?? '';
          return { path, kind, text, doc: result.issue ? null : parseDoc(text), issue: result.issue };
        });
    });
}

export function check(dir: string, only?: Scope): { checked: number; findings: Finding[] } {
  const all = records(dir, only);
  const findings: Finding[] = [];
  for (const { path, kind, text, doc, issue } of all) {
    const add = (rule: string, severity: Severity, line?: number) =>
      findings.push(line === undefined ? { path, rule, severity } : { path, rule, severity, line });
    if (issue) { add(issue, 'error'); continue; }
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
      for (const name of ['approved_by', 'chosen_by']) {
        const value = asText(fields[name]);
        if (value && !value.includes('<') && !/^(?:Fulano|Beltrana|Sicrano|(?:person|user|reviewer|pseudonym|pessoa|usuario|revisor)[-_][a-z0-9_-]+)$/i.test(value)) add('pseudonym-required', 'error');
      }
      for (const name of required[kind.type] ?? []) if (!asText(fields[name])) add('field-missing', 'error');
      if (kind.type === 'criterion' && asText(fields.applies_to) && !appliesTo.has(asText(fields.applies_to))) add('applies-to-invalid', 'error');
      if (kind.type === 'solution' && asText(fields.confidence) && !(/^\d{1,3}$/.test(asText(fields.confidence)) && Number(fields.confidence) <= 100)) add('confidence-invalid', 'error');
      if (kind.type === 'solution' && !results.has(asText(fields.result))) add('result-invalid', 'error');
      if (kind.type === 'repository' && !/^sha256:[0-9a-f]{64}$/.test(asText(fields.sources_hash))) add('sources-hash-invalid', 'error');
      if (/\bTODO\b/.test(doc.body)) add('todo-content', 'warning');
    }

    lines.forEach((line, index) => {
      if (line.length > maxLineLength) { add('line-too-long', 'error', index + 1); return; }
      if (hasSecret(line)) add('secret', 'error', index + 1);
      for (const { rule, test } of patterns) {
        const safeLine = rule === 'url-credentials' ? line.replace(/\b[a-z][\w+.-]*:\/\/([^\s/@]{1,512})@/gi, (url, info: string) => info.split(':').every(placeholder) ? '' : url) : line;
        const candidate = rule === 'personal-data' ? line.replace(/\b[a-z][\w+.-]*:\/\/[^\s/@]{1,512}@/gi, '').replace(/\bgit@(?=[\w.-]+:)/g, '') : safeLine;
        if (test.test(candidate) && !(rule === 'secret' && hasSecret(line))) add(rule, 'error', index + 1);
      }
    });

    // A path-like frontmatter value (local_path: /workspace/acme), unless the line scan already caught it.
    if (doc && !findings.some(f => f.path === path && f.rule === 'absolute-path')) {
      const values = Object.values(doc.fields).flatMap(value => (Array.isArray(value) ? value : [value]));
      if (values.some(value => absoluteValue.test(value))) add('absolute-path', 'error');
    }

    // Parse both Markdown fence styles, respecting the opening delimiter and length.
    const blocks: { open: number; close: number; count: number }[] = [];
    let fence: { open: number; marker: string; length: number } | undefined;
    let indentStart = -1;
    const finishIndent = (end: number) => {
      if (indentStart >= 0 && end - indentStart >= 3) blocks.push({ open: indentStart, close: end - 1, count: end - indentStart });
      indentStart = -1;
    };
    for (let i = (doc?.bodyLine ?? 1) - 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > maxLineLength) { finishIndent(i); continue; }
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
          blocks.push({ open: fence.open, close: i, count: i - fence.open - 1 });
          fence = undefined;
        }
        continue;
      }
      if (marker) { finishIndent(i); fence = { open: i, marker: marker[1]![0]!, length: marker[1]!.length }; continue; }
      if (/^(?: {4}|\t)/.test(line)) { if (indentStart < 0) indentStart = i; continue; }
      finishIndent(i);
      if (doc && bodyPlaceholder.test(line.replace(/`[^`]*`/g, ''))) add('placeholder', 'error', i + 1);
    }
    finishIndent(lines.length);
    if (fence) {
      add('code-fence-unclosed', 'error', fence.open + 1);
      blocks.push({ open: fence.open, close: lines.length - 1, count: lines.length - fence.open - 1 });
    }
    if (blocks.length > 1) add('multiple-snippets', 'error', blocks[1]!.open + 1);
    if (blocks.reduce((sum, block) => sum + block.count, 0) > 60) add('code-total-too-long', 'error');
    for (const { open, close, count } of blocks) {
      if (count > maxSnippetLines) add('code-too-long', 'error', open + 1);
      const around = lines.slice(Math.max(0, open - 3), close + 4).filter(line => line.length <= maxLineLength).join('\n');
      if (!/(?:^|[\s`(])[A-Za-z0-9_.-]{1,128}\/(?:[A-Za-z0-9_.-]{1,128}\/)*[A-Za-z0-9_.-]{1,128}@[0-9a-f]{7,40}(?=$|[\s`)])/m.test(around)) add('code-without-reference', 'error', open + 1);
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

const observation = ({ body }: Doc): string => body.split(observationMarker).slice(1).join(observationMarker).trim();

/**
 * Why a local solution may not replace the shared one, or null when it only moves it forward:
 * the observation keeps what is already shared, and a final result is never replaced by another
 * result, `pending` included (a stale local copy, left behind after the outcome was published
 * and synced; a real correction is a decision for the people who review the shared repository).
 */
function staleOutcome(local: Doc, shared: Doc): string | null {
  const sharedResult = asText(shared.fields.result);
  if (sharedResult !== 'pending' && asText(local.fields.result) !== sharedResult) return 'shared-has-final-result';
  return observation(local).startsWith(observation(shared)) ? null : 'shared-observation-not-kept';
}

export function plan(localDir: string, sharedDir: string, sharedName?: string): Plan {
  const shared = new Map(records(sharedDir).filter(entry => !entry.issue).map(entry => [entry.path, entry]));
  const items: Item[] = [];
  const remove: Plan['remove'] = [];
  for (const local of records(localDir).filter(entry => !entry.issue)) {
    const { path, kind, text, doc } = local;
    const other = shared.get(path);
    const item = (action: Item['action'], reason: string) => items.push({ path, action, reason });
    if (!other) item('add', 'new');
    else if (other.text === text) item('skip', 'unchanged');
    else if (kind.type === 'solution' && doc && other.doc && sameExceptResult(doc, other.doc)) {
      const stale = staleOutcome(doc, other.doc);
      if (stale) item('conflict', stale);
      else item('update', 'result-or-observation');
    }
    else if (kind.type === 'repository' && doc && other.doc) {
      const [mine, theirs] = [asText(doc.fields.indexed_at), asText(other.doc.fields.indexed_at)];
      if (mine > theirs) item('update', 'newer-index');
      else if (mine === theirs) item('conflict', 'same-date-different-index');
      else item('skip', 'shared-is-newer');
    } else item('conflict', kind.type === 'criterion' ? 'change-by-replaces' : 'append-only');

    if (kind.type === 'criterion' && doc) {
      const replaces = Array.isArray(doc.fields.replaces) ? doc.fields.replaces : [];
      for (const id of replaces) {
        // A qualified reference only counts for the knowledge it names; without --shared-name it stays unresolved.
        const source = /^knowledge:([^/\s]+)\/(criteria\/[a-zA-Z0-9_.-]+\.md)$/.exec(id);
        const old = source ? (source[1] === sharedName ? source[2]! : '') : /^[a-zA-Z0-9_-]+$/.test(id) ? `${kind.dir}/${id}.md` : '';
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
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value)!;
}

export function sourcesHash(base: string, paths: string[], meta?: unknown): string {
  const entries: string[] = [];
  const visited = new Set<string>();
  const walk = (path: string, explicit: boolean) => {
    const issue = pathIssue(base, path);
    if (issue) return;
    if (path.split(/[\\/]/).some(part => skipped.has(part))) return;
    const full = resolve(base, path);
    if (lstatSync(full).isDirectory()) {
      const real = realpathSync(full);
      if (visited.has(real)) return;
      visited.add(real);
      for (const name of readdirSync(full).sort()) walk(join(path, name), false);
    } else {
      const { issue } = readSafe(full);
      if (issue) return;
      entries.push(explicit ? `file:${path}:${digest('sha256', readFileSync(full))}` : `name:${relative(base, full)}`);
    }
  };
  for (const path of paths) walk(path, true);
  if (meta !== undefined) entries.push(`meta:${canonical(meta)}`);
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
        meta: { type: 'string' },
        only: { type: 'string' },
        local: { type: 'string' },
        shared: { type: 'string' },
        'shared-name': { type: 'string' },
      },
    });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${usage}`);
  }
  const { positionals: [command, ...rest], values } = parsed;
  if (command === 'hash') {
    if (values.base === undefined || !rest.length) throw new Error(usage);
    return { output: sourcesHash(values.base, rest, values.meta === undefined ? undefined : JSON.parse(values.meta)), code: 0 };
  }
  if (command === 'check') {
    if (rest.length !== 1) throw new Error(usage);
    const result = check(rest[0]!, scopeOf(values.only));
    return { output: JSON.stringify(result), code: result.findings.some(f => f.severity === 'error') ? 1 : 0 };
  }
  if (command === 'plan') {
    if (values.local === undefined || values.shared === undefined || rest.length) throw new Error(usage);
    return { output: JSON.stringify(plan(values.local, values.shared, values['shared-name'])), code: 0 };
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
