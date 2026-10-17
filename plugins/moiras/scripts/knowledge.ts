/* Usage:
 * node knowledge.ts hash --base ~/work/acme-shop-checkout README.md package.json src/views
 * node knowledge.ts check .moiras/knowledge [--only glossary|criteria|learnings]
 * node knowledge.ts issues .moiras/knowledge ../acme-knowledge
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
import { isIgnoredParts, layerOf } from './gitignore.ts';
import type { IgnoreLayer } from './gitignore.ts';
import { hash } from './memory.ts';

export const usage = 'Usage: node knowledge.ts hash --base <dir> [--meta <json-string>] <path...> | check <dir> [--only glossary|criteria|learnings] | issues <dir>... | plan --local <dir> --shared <dir> [--shared-name <name>]';

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
/** Pseudonyms accepted for `approved_by`, `chosen_by` and `audit.auditors`. */
export const pseudonymPattern = /^(?:Fulano|Beltrana|Sicrano|(?:person|user|reviewer|pseudonym|pessoa|usuario|revisor)[-_][a-z0-9_-]+)$/i;

export const placeholder = (value: string) => /^(?:<[^>]+>|x{4,}|\*{4,})$/i.test(value);
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

export function hasSecret(line: string): boolean {
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
export const patterns: { rule: string; test: RegExp }[] = [
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

/**
 * Issue keys that `learnings/` already cite (only from records that pass `check`) and every id or file
 * name in use, over one or more knowledges. A caller uses it to skip known issues and avoid collisions.
 */
export function issues(dirs: string | string[]): { issues: Record<string, { solutions: string[]; patterns: string[] }>; ids: string[] } {
  const ids = new Set<string>();
  const mentions = new Map<string, { solutions: Set<string>; patterns: Set<string> }>();
  for (const dir of [dirs].flat()) {
    const invalid = new Set(check(dir, 'learnings').findings.filter(finding => finding.severity === 'error').map(finding => finding.path));
    for (const entry of records(dir, 'learnings')) {
      // A folder that cannot be read (symlink, not a directory) would hide ids and issues: fail instead of a partial index.
      if (entry.issue && !entry.path.endsWith('.md')) throw new Error(`${dir}: ${entry.path} cannot be indexed (${entry.issue}).`);
      const stem = entry.path.slice(entry.path.lastIndexOf('/') + 1, -'.md'.length);
      ids.add(stem);
      const fields = entry.doc?.fields;
      if (!fields || entry.issue) continue;
      if (typeof fields.id === 'string' && fields.id) ids.add(fields.id);
      // Empty and TODO records are not evidence (see moiras-triage), so they do not cover an issue.
      if (invalid.has(entry.path) || !entry.doc!.body.trim() || /\bTODO\b/.test(entry.doc!.body)) continue;
      const id = stem;
      const raw = entry.kind.type === 'solution' ? fields.issue : entry.kind.type === 'pattern' ? fields.issues : undefined;
      const keys = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).map(key => key.trim()).filter(Boolean);
      for (const key of keys) {
        const group = mentions.get(key) ?? { solutions: new Set<string>(), patterns: new Set<string>() };
        group[entry.kind.type === 'solution' ? 'solutions' : 'patterns'].add(id);
        mentions.set(key, group);
      }
    }
  }
  return {
    issues: Object.fromEntries([...mentions.keys()].sort().map(key => {
      const group = mentions.get(key)!;
      return [key, { solutions: [...group.solutions].sort(), patterns: [...group.patterns].sort() }];
    })),
    ids: [...ids].sort(),
  };
}

/** `YYYY-MM-DD` that exists on the calendar (2026-02-30 and 2026-99-99 do not). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

interface CodeBlock {
  open: number; // index of the first line (the opening fence, or the first indented line)
  close: number; // index of the last line (the closing fence, or the last indented line)
  size: number; // lines of code, fences excluded
}

const unwrap = (line: string): string => line.replace(/^(?:\s{0,3}>[ \t]?)+/, '');
const expandTabs = (line: string): string => line.replace(/^[ \t]+/, ws => ws.replaceAll('\t', '    '));
const fenceStart = /^(`{3,}|~{3,})/;
const listMarker = /^([-*+]|\d{1,9}[.)])( +|$)/;

/**
 * Code blocks from line `from` on, as CommonMark reads them: fenced with ``` or ~~~ (up to 3 spaces of
 * indentation, relative to the list item that holds it; closed by a fence of the same character, at least as
 * long), or indented by 4 spaces past the enclosing content (after a blank line). Blockquote markers are
 * stripped, and list items shift the content column, so a fence or code block nested in a quote or in a list
 * item is found too, while an indented paragraph that continues a list item is text. `unclosed` is the line
 * of a fence that never closes.
 */
function codeBlocks(rawLines: string[], from: number): { blocks: CodeBlock[]; unclosed?: number } {
  const lines = rawLines.map(line => expandTabs(unwrap(line)));
  const blocks: CodeBlock[] = [];
  const contents: number[] = []; // content column of each open list item, outermost first
  const indentOf = (line: string) => line.length - line.trimStart().length;
  let previousBlank = true;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      previousBlank = true;
      continue;
    }
    const indent = indentOf(line);
    if (previousBlank) while (contents.length > 0 && indent < contents.at(-1)!) contents.pop();
    let rest = line.slice(indent);
    let relative = indent - (contents.at(-1) ?? 0);
    if (relative <= 3) {
      const marker = listMarker.exec(rest);
      if (marker) {
        while (contents.length > 0 && indent < contents.at(-1)!) contents.pop();
        const gap = marker[2]!.length;
        const width = marker[1]!.length + (gap === 0 || gap > 4 ? 1 : gap);
        contents.push(indent + width);
        rest = rest.slice(width);
        relative = rest.length - rest.trimStart().length;
        rest = rest.trimStart();
        if (rest === '') {
          previousBlank = false;
          continue;
        }
      }
    }
    previousBlank = false;
    const fence = relative <= 3 ? fenceStart.exec(rest) : null;
    if (fence) {
      const mark = fence[1]!;
      const closing = new RegExp(`^${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`);
      const container = indent - relative;
      const close = lines.findIndex((candidate, j) => j > i && indentOf(candidate) <= container + 3 && closing.test(candidate.trimStart()));
      if (close === -1) return { blocks, unclosed: i };
      blocks.push({ open: i, close, size: close - i - 1 });
      i = close;
      continue;
    }
    if (relative >= 4 && (i === from || lines[i - 1]!.trim() === '')) {
      const base = indent - relative + 4;
      let end = i;
      for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || indentOf(lines[j]!) >= base); j++) if (lines[j]!.trim() !== '') end = j;
      blocks.push({ open: i, close: end, size: end - i + 1 });
      i = end;
    }
  }
  return { blocks };
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
      else if (!isCalendarDate(date)) add('date-invalid', 'error');
      if (Object.values(fields).some(value => /<[^>]*>|AAAA-MM-DD|\s\|\s/.test(asText(value)))) add('placeholder', 'error');
      if (kind.type === 'criterion' && !asText(fields.approved_by)) add('approved-by-missing', 'error');
      for (const name of ['approved_by', 'chosen_by']) {
        const value = asText(fields[name]);
        if (value && !value.includes('<') && !pseudonymPattern.test(value)) add('pseudonym-required', 'error');
      }
      for (const name of required[kind.type] ?? []) if (!asText(fields[name])) add('field-missing', 'error');
      if (kind.type === 'criterion' && fields.replaces !== undefined && !Array.isArray(fields.replaces)) add('replaces-invalid', 'error');
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

    // Code blocks of the body (fenced with ``` or ~~~, or indented): they are code, not prose, and are limited below.
    const first = doc ? doc.bodyLine - 1 : 0;
    const { blocks, unclosed } = codeBlocks(lines.map(line => line.slice(0, maxLineLength)), first);

    // Template placeholders left in the body (<descrição>, AAAA-MM-DD); code is not prose, so it is skipped.
    if (doc) {
      lines.forEach((line, index) => {
        if (index < first || blocks.some(block => index >= block.open && index <= block.close)) return;
        if (bodyPlaceholder.test(line.replace(/`[^`]*`/g, ''))) add('placeholder', 'error', index + 1);
      });
    }

    // Snippets: at most one, at most 20 lines, always with a reference (repository/path@commit).
    if (unclosed !== undefined) add('code-fence-unclosed', 'error', unclosed + 1);
    if (blocks.length > 1) add('multiple-snippets', 'error', blocks[1]!.open + 1);
    if (blocks.reduce((sum, block) => sum + block.size, 0) > 60) add('code-total-too-long', 'error');
    for (const { open, close, size } of blocks) {
      if (size > maxSnippetLines) add('code-too-long', 'error', open + 1);
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

    // A substitute that is not going to be published (conflict) must not remove anything.
    if (kind.type === 'criterion' && doc && items[items.length - 1]!.action !== 'conflict') {
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
 * change the hash until it shows up. Walking a directory leaves out what the `.gitignore` of
 * the base and of every folder below it excludes, as Git would (never one above the base):
 * ignored folders are not even read. A file named explicitly is always read; a folder named explicitly is skipped when a .gitignore above it excludes it.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value)!;
}

/** The rules of the `.gitignore` in `dir` (relative to the base): none when it is missing, a link, too large or not UTF-8 text. */
function ignoreLayer(base: string, dir: string): IgnoreLayer | undefined {
  try {
    const { text } = readSafe(join(resolve(base), dir, '.gitignore'));
    return text === undefined ? undefined : layerOf(dir.split(sep).join('/'), text);
  } catch {
    return undefined;
  }
}

export function sourcesHash(base: string, paths: string[], meta?: unknown): string {
  const entries: string[] = [];
  const visited = new Set<string>();
  // Each .gitignore is read and parsed once per call, however many named paths pass through its folder.
  const layerCache = new Map<string, IgnoreLayer | undefined>();
  const cachedLayer = (dir: string) => {
    if (!layerCache.has(dir)) layerCache.set(dir, ignoreLayer(base, dir));
    return layerCache.get(dir);
  };
  const toParts = (relDir: string) => (relDir === '' ? [] : relDir.split('/').map(name => Buffer.from(name, 'utf8')));
  // `rel` is the folder relative to the base, `/`-separated; `parts` is the same as bytes, only built once a .gitignore applies.
  const walk = (path: string, explicit: boolean, inherited: IgnoreLayer[], rel: string, parts: Buffer[] | undefined) => {
    const issue = pathIssue(base, path);
    if (issue) return;
    if (path.split(/[\\/]/).some(part => skipped.has(part))) return;
    const full = resolve(base, path);
    if (lstatSync(full).isDirectory()) {
      const real = realpathSync(full);
      if (visited.has(real)) return;
      visited.add(real);
      let layers = inherited;
      let here = parts;
      let relDir = rel;
      if (explicit) {
        // A path named on its own still obeys the .gitignore of the folders between it and the base (never above the base), and
        // is skipped when one of those folders, or itself, is excluded. A file named on its own is always read.
        const names = relative(resolve(base), full).split(sep).filter(Boolean);
        relDir = names.join('/');
        here = toParts(relDir);
        layers = [];
        for (let depth = 0; depth < names.length; depth += 1) {
          const above = cachedLayer(names.slice(0, depth).join(sep));
          if (above) layers.push(above);
          if (isIgnoredParts(layers, here.slice(0, depth + 1), true)) return;
        }
      }
      const children = readdirSync(full, { withFileTypes: true });
      // Only a folder that holds a .gitignore pays for reading one.
      if (children.some(child => child.name === '.gitignore')) {
        const own = cachedLayer(relative(resolve(base), full));
        if (own) layers = [...layers, own];
      }
      if (layers.length) here ??= toParts(relDir);
      for (const child of children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const childRel = relDir === '' ? child.name : `${relDir}/${child.name}`;
        let childParts: Buffer[] | undefined;
        if (layers.length) {
          childParts = [...here!, Buffer.from(child.name, 'utf8')];
          if (isIgnoredParts(layers, childParts, child.isDirectory())) continue;
        }
        walk(join(path, child.name), false, layers, childRel, childParts);
      }
    } else {
      const { issue } = readSafe(full);
      if (issue) return;
      entries.push(explicit ? `file:${path}:${digest('sha256', readFileSync(full))}` : `name:${relative(base, full)}`);
    }
  };
  for (const path of paths) walk(path, true, [], '', undefined);
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
  if (command === 'issues') {
    if (!rest.length || Object.keys(values).length) throw new Error(usage);
    return { output: JSON.stringify(issues(rest)), code: 0 };
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
