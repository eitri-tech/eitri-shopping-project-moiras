/* Usage:
 * node knowledge.ts hash --base ~/work/acme-shop-checkout README.md package.json src/views
 * node knowledge.ts check .moiras/knowledge [--only glossary|criteria|learnings]
 * node knowledge.ts issues .moiras/knowledge ../acme-knowledge
 * node knowledge.ts provenance ../acme-shop-checkout
 * node knowledge.ts plan --local .moiras/knowledge --shared ../acme-knowledge --shared-name acme
 *
 * Read-only helpers for moiras-index, moiras-audit and moiras-publish. They never write
 * to a knowledge and never print the content of a record, only paths, rules and line numbers.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable (no enums, namespaces or
 * parameter properties) and import siblings with the .ts extension.
 */
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { hash as digest } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isIgnoredParts, layerOf } from './gitignore.ts';
import type { IgnoreLayer } from './gitignore.ts';
import { hash } from './memory.ts';

export const usage = 'Usage: node knowledge.ts hash --base <dir> [--meta <json-string>] <path...> | check <dir> [--only glossary|criteria|learnings] | issues <dir>... | plan --local <dir> --shared <dir> [--shared-name <name>] | provenance <repository>';

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
/** Where the indexed repository was when it was read (see moiras-index): all optional and outside `sources_hash`. */
const provenanceFields = ['indexed_commit_date', 'indexed_dirty'];
const commitSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const jiraKey = /^[A-Z][A-Z0-9]*-\d+$/;
/** Origin of a learning taken from GitHub with no Jira key: `<repository>#<number>` (a merged PR or an issue closed as completed). */
const githubRef = /^[A-Za-z0-9_][A-Za-z0-9._-]*#\d+$/;
const issueKey = (value: string): boolean => jiraKey.test(value) || githubRef.test(value);
// Optional pointer of a solution (usually a GitHub PR): a real https URL, no credentials, no whitespace.
export function validReferenceUrl(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch { return false; }
}
const platforms = new Set(['vtex', 'wake', 'shopify', 'other']);
const appliesTo = new Set(['category', 'origin', 'action', 'solutions']);
const results = new Set(['pending', 'resolved', 'not-resolved']);
const skipped = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.direnv']);

const maxFileBytes = 1024 * 1024;
const maxDepth = 32;
const maxLineLength = 8192;
/** Pseudonyms accepted for `approved_by`, `chosen_by` and `audit.auditors`. */
export const pseudonymPattern = /^(?:Fulano|Beltrana|Sicrano|(?:person|user|reviewer|pseudonym|pessoa|usuario|revisor)[-_][a-z0-9_-]+)$/i;

const fieldPlaceholder = /<[^>]*>/;
export const placeholder = (value: string) => /^(?:<[^>]+>|x{4,}|\*{4,})$/i.test(value);
const email = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,190}\.[A-Z]{2,24}\b/i;

// Inspect every path component below the base before resolving; even links within the base are skipped.
// Ancestors of the base are trusted (platform links such as /tmp and /var), but the base itself must not be a link.
function pathIssue(base: string, path: string): string | undefined {
  const supplied = resolve(base);
  let root: string;
  try {
    if (lstatSync(supplied).isSymbolicLink()) return 'symlink';
    root = realpathSync(supplied);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    if (code === 'ENOTDIR') return 'not-directory';
    if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
    throw error;
  }
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'missing';
      if (code === 'ENOTDIR') return 'not-directory';
      if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
      throw error;
    }
  }
  if (realpathSync(target) !== target) return 'symlink';
  return undefined;
}

function readSafe(file: string): { text?: string; issue?: string } {
  const stat = lstatSync(file);
  if (!stat.isFile()) return { issue: 'not-regular-file' };
  if (stat.size > maxFileBytes) return { issue: 'file-too-large' };
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return { issue: 'unreadable' };
    throw error;
  }
  if (bytes.includes(0) || !isUtf8(bytes)) return { issue: 'binary-file' };
  return { text: bytes.toString('utf8') };
}

export function hasSecret(line: string): boolean {
  // The key may be quoted (JSON, quoted YAML) and so may the value.
  const assignments = /\b([A-Z_][A-Z0-9_-]{0,127})(["']?)\s*([:=])\s*(["']?)(<[^>]{1,128}>|[^\s"'`;,]{1,2048})/gi;
  for (const match of line.matchAll(assignments)) {
    const [, key = '', keyQuote = '', separator = '', valueQuote = '', value = ''] = match;
    if (!/(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE_KEY|CREDENTIAL|SESSION_ID|DATABASE_URL)/i.test(key) || placeholder(value)) continue;
    // A bare `key: word` is often prose ("o token: ao expirar"): without quotes, a letters-only value is
    // intentionally not flagged when it is short (< 8) or more words follow it, to avoid false positives on prose.
    // A long standalone value is still flagged.
    if (separator === ':' && !keyQuote && !valueQuote && !/[^\p{L}-]/u.test(value)) {
      const tail = line.slice((match.index ?? 0) + match[0].length);
      if (value.length < 8 || /^\s+\p{L}/u.test(tail)) continue;
    }
    return true;
  }
  for (const match of line.matchAll(/\bAuthorization["']?\s*[:=]\s*["']?(?:Basic|Bearer|Token|Digest)\s+(<[^>]{1,128}>|[^\s"'`;,]{8,2048})/gi)) {
    if (!placeholder(match[1]!)) return true;
  }
  for (const match of line.matchAll(/[?&](?:access_token|token|key|password|secret|api_key)=([^\s&#"'`]{1,2048})/gi)) {
    let value = match[1]!;
    try { value = decodeURIComponent(value); } catch { /* Scan malformed values as supplied. */ }
    if (!placeholder(value)) return true;
  }
  return false;
}

// What a record must never carry. Matches are reported by rule and line, never echoed.
/** `owner/glob` for `index.github`: a GitHub login (no leading hyphen, no wildcard) and a glob of file-name characters with `*` and `?`, that keeps at least one letter or digit, so a glob of only wildcards and punctuation (`*`, `**`, `*?`, `???`, `*-*`, `.*`) never matches a whole owner. */
export function validPattern(pattern: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._*?-]+$/.test(pattern) && !pattern.includes('..') && /[A-Za-z0-9]/.test(pattern.split('/')[1]!);
}

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

const unquote = (value: string): string => value.replace(/^(["'])(.*)\1$/, '$2');

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
      ? raw.slice(1, -1).split(',').map(item => unquote(item.trim())).filter(Boolean)
      : unquote(raw);
  }
  return { fields, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 };
}

const asText = (value: Value | undefined): string => (Array.isArray(value) ? value.join(', ') : value ?? '');
const asScalar = (value: Value | undefined): string => (typeof value === 'string' ? value : '');
const safeName = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const learningSource = /^knowledge:[A-Za-z0-9_][A-Za-z0-9._-]*\/learnings\/(?:solutions|patterns|decisions)\/(?![^/]*\.\.)[A-Za-z0-9_][A-Za-z0-9._-]*\.md$/;

export interface Entry {
  path: string;
  kind: Kind;
  text: string;
  doc: Doc | null;
  issue?: string;
}

/** The markdown records of a knowledge, in a stable order. `.gitkeep` and other files are ignored. */
export function records(dir: string, only?: Scope): Entry[] {
  const root = lstatSync(dir, { throwIfNoEntry: false });
  if (root === undefined) throw new Error(`Knowledge directory not found: ${dir}`);
  if (root.isFile()) throw new Error(`${dir}: not a knowledge directory`);
  return kinds
    .filter(kind => only === undefined || kind.scope === only)
    .flatMap(kind => {
      const folder = join(dir, kind.dir);
      const folderIssue = pathIssue(dir, kind.dir);
      if (folderIssue === 'missing') return [];
      if (folderIssue) return [{ path: kind.dir, kind, text: '', doc: null, issue: folderIssue }];
      if (!lstatSync(folder).isDirectory()) return [{ path: kind.dir, kind, text: '', doc: null, issue: 'not-directory' }];
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') return [{ path: kind.dir, kind, text: '', doc: null, issue: 'unreadable' }];
        throw error;
      }
      return names
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
      for (const candidate of (Array.isArray(fields.id) ? fields.id : [fields.id])) {
        if (typeof candidate === 'string' && candidate) ids.add(candidate);
      }
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
      if (asScalar(fields.id) !== path.slice(path.lastIndexOf('/') + 1, -'.md'.length)) add('id-mismatch', 'error');
      if (asScalar(fields.type) !== kind.type) add('type-mismatch', 'error');
      const dateRaw = fields[kind.date];
      const date = asScalar(dateRaw);
      if (!asText(dateRaw)) add('date-missing', 'error');
      else if (!isCalendarDate(date)) add('date-invalid', 'error');
      if (Object.values(fields).some(value => fieldPlaceholder.test(asText(value)) || /AAAA-MM-DD|\s\|\s/.test(asText(value)))) add('placeholder', 'error');
      if (kind.type === 'criterion' && !asText(fields.approved_by)) add('approved-by-missing', 'error');
      for (const name of ['approved_by', 'chosen_by']) {
        const raw = fields[name];
        const value = asScalar(raw);
        if ((Array.isArray(raw) && asText(raw) !== '') || (value && !value.includes('<') && !pseudonymPattern.test(value))) add('pseudonym-required', 'error');
      }
      for (const name of required[kind.type] ?? []) if (!asText(fields[name])) add('field-missing', 'error');
      if (kind.type === 'criterion' && fields.replaces !== undefined && (!Array.isArray(fields.replaces) || fields.replaces.some(id => !/^(?:[a-zA-Z0-9_-]+|knowledge:[^/\s]+\/criteria\/[a-zA-Z0-9_.-]+\.md)$/.test(id)))) add('replaces-invalid', 'error');
      if (kind.type === 'criterion' && asText(fields.applies_to) && !appliesTo.has(asScalar(fields.applies_to))) add('applies-to-invalid', 'error');
      if (kind.type === 'solution' && asText(fields.category) && Array.isArray(fields.category)) add('category-invalid', 'error');
      if (kind.type === 'solution' && asText(fields.confidence) && !(/^\d{1,3}$/.test(asScalar(fields.confidence)) && Number(asScalar(fields.confidence)) <= 100)) add('confidence-invalid', 'error');
      if (kind.type === 'solution' && !results.has(asScalar(fields.result))) add('result-invalid', 'error');
      if (kind.type === 'solution' && fields.reference_url !== undefined && (Array.isArray(fields.reference_url) || (!fieldPlaceholder.test(asScalar(fields.reference_url)) && !validReferenceUrl(asScalar(fields.reference_url))))) add('reference-url-invalid', 'error');
      if (kind.type === 'solution' && asText(fields.issue) && (Array.isArray(fields.issue) || (!fieldPlaceholder.test(asScalar(fields.issue)) && !issueKey(asScalar(fields.issue))))) add('issue-invalid', 'error');
      // A learning imported from GitHub points at its source PR or issue, so it can be audited and removed later.
      if (kind.type === 'solution' && asScalar(fields.imported_from) === 'github' && !validReferenceUrl(asScalar(fields.reference_url))) add('reference-url-missing', 'error');
      if ((kind.type === 'solution' || kind.type === 'pattern') && asText(fields.repositories)) {
        if (!Array.isArray(fields.repositories) || fields.repositories.some(item => !fieldPlaceholder.test(item) && !safeName.test(item))) add('repositories-invalid', 'error');
      }
      if (kind.type === 'pattern' && asText(fields.issues)) {
        const list = (Array.isArray(fields.issues) ? fields.issues : fields.issues.split(',')).map(item => item.trim()).filter(Boolean);
        if (list.length === 0 || list.some(item => !fieldPlaceholder.test(item) && !issueKey(item))) add('issues-invalid', 'error');
      }
      if (kind.type === 'decision' && asText(fields.source)) {
        if (!Array.isArray(fields.source) || fields.source.some(item => !fieldPlaceholder.test(item) && !safeName.test(item) && !learningSource.test(item))) add('source-invalid', 'error');
      }
      if (kind.type === 'repository' && !/^sha256:[0-9a-f]{64}$/.test(asScalar(fields.sources_hash))) add('sources-hash-invalid', 'error');
      if (kind.type === 'repository') {
        const platform = asScalar(fields.platform);
        if (Array.isArray(fields.platform) || (platform && !fieldPlaceholder.test(platform) && !platforms.has(platform))) add('platform-invalid', 'error');
        if (fields.keywords !== undefined) {
          const list = Array.isArray(fields.keywords) ? fields.keywords : asText(fields.keywords).split(',').map(item => item.trim()).filter(Boolean);
          if (list.length > 10) add('keywords-too-many', 'error');
        }
        const commit = asScalar(fields.indexed_commit);
        if (Array.isArray(fields.indexed_commit) || (commit && !commitSha.test(commit))) add('indexed-commit-invalid', 'error');
        // A commit alone does not say when it was made or whether the tree matched it.
        const incomplete = asText(fields.indexed_commit) !== '' ? !asText(fields.indexed_commit_date) || !asText(fields.indexed_dirty) : provenanceFields.some(name => asText(fields[name]));
        if (incomplete) add('provenance-incomplete', 'error');
        const commitDate = asScalar(fields.indexed_commit_date);
        if (Array.isArray(fields.indexed_commit_date) || (commitDate && !isCalendarDate(commitDate))) add('indexed-commit-date-invalid', 'error');
        const dirty = asScalar(fields.indexed_dirty);
        if (Array.isArray(fields.indexed_dirty) || (dirty && dirty !== 'true' && dirty !== 'false')) add('indexed-dirty-invalid', 'error');
        // Branch and tag names are not recorded: they can be internal and say nothing the commit does not.
        if ('indexed_branch' in fields || 'indexed_tag' in fields) add('indexed-ref-unsupported', 'error');
      }
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
      if (!/(?:^|[\s`(])[A-Za-z0-9_.-]{1,128}\/(?:[A-Za-z0-9_.-]{1,128}\/)*[A-Za-z0-9_.-]{1,128}@[0-9a-f]{7,64}(?=$|[\s`)])/m.test(around)) add('code-without-reference', 'error', open + 1);
    }
  }
  return { checked: all.length, findings };
}

const observationPattern = /\*\*Observação(?::\*\*|\*\*:)/;

/** Everything but `result` in the frontmatter, and everything before the observation, must be equal. */
function sameExceptResult(local: Doc, shared: Doc): boolean {
  const strip = ({ fields }: Doc) => JSON.stringify(Object.entries(fields).filter(([key]) => key !== 'result').sort());
  const head = ({ body }: Doc) => body.split(observationPattern)[0]!.trimEnd();
  return strip(local) === strip(shared) && head(local) === head(shared);
}

const observation = ({ body }: Doc): string => {
  const match = observationPattern.exec(body);
  return match ? body.slice(match.index + match[0].length).trim() : '';
};

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

/** Two glossary records are the same index when they were built from the same sources: the `sources_hash` is the only thing compared. */
function sameSources(a: Doc, b: Doc): boolean {
  const hash = asText(a.fields.sources_hash);
  return hash !== '' && hash === asText(b.fields.sources_hash);
}

export function plan(localDir: string, sharedDir: string, sharedName?: string): Plan {
  // Broken registries (unreadable, too large, not UTF-8) are surfaced as conflicts instead of vanishing
  // from the plan: `shared:` marks a problem on the shared side, so the publish does not offer an `add`
  // for a path the shared repository already holds.
  const shared = new Map(records(sharedDir).map(entry => [entry.path, entry]));
  const items: Item[] = [];
  const remove: Plan['remove'] = [];
  const covered = new Set<string>();
  for (const local of records(localDir)) {
    covered.add(local.path);
    const { path, kind, text, doc } = local;
    const item = (action: Item['action'], reason: string) => items.push({ path, action, reason });
    // A shared kind folder that is a link or not a directory is reported once under its own path; everything
    // beneath it is blocked too, so no `add` can write through it.
    const sharedIssue = shared.get(path)?.issue ?? shared.get(kind.dir)?.issue;
    if (local.issue) item('conflict', local.issue);
    else if (sharedIssue) item('conflict', `shared:${sharedIssue}`);
    else {
      const other = shared.get(path);
      if (!other) item('add', 'new');
      else if (other.text === text) item('skip', 'unchanged');
      else if (kind.type === 'solution' && doc && other.doc && sameExceptResult(doc, other.doc)) {
        const stale = staleOutcome(doc, other.doc);
        if (stale) item('conflict', stale);
        else item('update', 'result-or-observation');
      }
      else if (kind.type === 'repository' && doc && other.doc && sameSources(doc, other.doc)) item('skip', 'unchanged');
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
          // A shared criterion that could not be read is reported as a conflict; it is never removed unseen.
          const target = shared.get(old);
          if (target && !target.issue && old !== path) remove.push({ path: old, replacedBy: path });
        }
      }
    }
  }
  // A broken record only shared stays in the plan too: nothing can be published for it,
  // but the reviewer needs to know the shared file is unreadable.
  for (const entry of shared.values()) {
    if (entry.issue && !covered.has(entry.path)) items.push({ path: entry.path, action: 'conflict', reason: `shared:${entry.issue}` });
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

/**
 * The rules of the `.gitignore` in `dir` (relative to the base): none when it is missing, too large or not UTF-8 text.
 * One that exists as a symlink or without read permission fails the hash: skipping it would put the files it excludes into the fingerprint unannounced.
 */
function ignoreLayer(base: string, dir: string): IgnoreLayer | undefined {
  const file = join(base, dir, '.gitignore');
  let read: { text?: string; issue?: string };
  try {
    read = readSafe(file);
  } catch {
    return undefined;
  }
  if (read.issue === 'unreadable' || read.issue === 'not-regular-file') throw new Error(`${join(dir, '.gitignore')}: ${read.issue}`);
  return read.text === undefined ? undefined : layerOf(dir.split(sep).join('/'), read.text);
}

export function sourcesHash(base: string, paths: string[], meta?: unknown): string {
  // The base is resolved once, so an entry point into the same tree (a symlink such as /tmp on
  // macOS, or a convenience alias) fingerprints like the real folder. A missing or non-directory
  // base fails instead of hashing an empty tree.
  let root: string;
  try {
    root = realpathSync(resolve(base));
  } catch {
    throw new Error(`Base directory not found: ${base}`);
  }
  if (!lstatSync(root).isDirectory()) throw new Error(`${base}: not a base directory`);
  const entries: string[] = [];
  const visited = new Set<string>();
  // Each .gitignore is read and parsed once per call, however many named paths pass through its folder.
  const layerCache = new Map<string, IgnoreLayer | undefined>();
  const cachedLayer = (dir: string) => {
    if (!layerCache.has(dir)) layerCache.set(dir, ignoreLayer(root, dir));
    return layerCache.get(dir);
  };
  const toParts = (relDir: string) => (relDir === '' ? [] : relDir.split('/').map(name => Buffer.from(name, 'utf8')));
  // `rel` is the folder relative to the base, `/`-separated; `parts` is the same as bytes, only built once a .gitignore applies.
  const walk = (path: string, explicit: boolean, inherited: IgnoreLayer[], rel: string, parts: Buffer[] | undefined) => {
    const issue = pathIssue(root, path);
    // A path that exists but cannot be inspected must fail the hash, not look like a source that is absent.
    if (issue === 'unreadable' || issue === 'not-directory') throw new Error(`${path}: ${issue}`);
    if (issue) return;
    if (path.split(/[\\/]/).some(part => skipped.has(part))) return;
    const full = resolve(root, path);
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
        const names = relative(root, full).split(sep).filter(Boolean);
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
        const own = cachedLayer(relative(root, full));
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
      if (issue) {
        if (explicit) throw new Error(`${path}: ${issue}`);
        entries.push(`name:${relative(root, full)}`);
        return;
      }
      entries.push(explicit ? `file:${path}:${digest('sha256', readFileSync(full))}` : `name:${relative(root, full)}`);
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

/** Variables that point Git at another repository, work tree or index would make the answer describe something else. */
function gitEnv(): NodeJS.ProcessEnv {
  // Replacement refs would make the commit, its date and its tree describe another commit than HEAD.
  const env: NodeJS.ProcessEnv = { ...process.env, TZ: 'UTC', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']) delete env[name];
  return env;
}

export interface Provenance {
  git: boolean;
  /** Why `git` is false when it is more than "not a repository": the dirty state could not be read. */
  reason?: string;
  indexed_commit?: string;
  indexed_commit_date?: string;
  indexed_dirty?: boolean;
}

/**
 * Where an indexed repository was when it was read: HEAD, the date of that commit (UTC) and whether the working tree had changes. Read-only Git commands only; `{ git: false }` without a repository or a commit.
 */
export function provenance(repository: string, maxBuffer = 64 * 1024 * 1024): Provenance {
  const env = gitEnv();
  // core.fsmonitor and the clean/process commands of .gitattributes filters are executables that `git status` would run: reading a
  // repository must not run its scripts. Filters are emptied one by one; the dirty state may then be reported a little too eagerly
  // (a file whose clean filter changes its content looks modified), never missed.
  // `log.showSignature` would make `git log` run the signature verifier the repository configures.
  // `core.checkStat=minimal` with `core.trustctime=false` (and `core.ignoreStat`) make `git status` trust size and mtime alone, so an edit
  // that keeps both would read as clean; the defaults also compare ctime, which an edit cannot keep. `core.ignoreCase=true` on a
  // case-sensitive disk folds `foo` into a tracked `Foo`, so the untracked file would not show up.
  const base = ['-C', repository, '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.checkStat=default', '-c', 'core.trustctime=true', '-c', 'core.ignoreStat=false', '-c', 'core.ignoreCase=false'];
  const listed = spawnSync('git', [...base, 'config', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|process)$'], { encoding: 'utf8', env, maxBuffer });
  // Exit 1 is "no filter configured". A listing that was cut short (buffer overflow, which still reports exit 0, or a killed process) is
  // only part of the filters: going on would let `git status` run the ones that are missing, so the answer is no provenance. A missing
  // Git binary falls through to `{ git: false }`.
  if ((listed.error || listed.status === null) && (listed.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return { git: false, reason: 'filters-unreadable' };
  const filters = listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).flatMap(key => ['-c', `${key}=`]) : [];
  const run = (...args: string[]) => spawnSync('git', [...base, ...filters, ...args], { encoding: 'utf8', env, maxBuffer });
  const git = (...args: string[]) => {
    const result = run(...args);
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  // A folder that only sits inside another work tree would answer with the parent's HEAD: the path must be the repository's own root.
  const top = git('rev-parse', '--show-toplevel');
  let own = false;
  try { own = top !== undefined && realpathSync(top) === realpathSync(repository); } catch { /* A path that does not resolve is not a repository. */ }
  const commit = own ? git('rev-parse', '--verify', '-q', 'HEAD') : undefined;
  if (!commit || !commitSha.test(commit)) return { git: false };
  const result: Provenance = { git: true, indexed_commit: commit };
  const date = git('log', '-1', '--date=format-local:%Y-%m-%d', '--format=%cd');
  if (!date || !isCalendarDate(date)) return { git: false, reason: 'commit-date-unreadable' };
  result.indexed_commit_date = date;
  // Submodules are not entered: their own config (filters) would run, and the indexer reads the main repository, not their content.
  const status = run('status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all');
  if (status.status === 0) result.indexed_dirty = status.stdout.trim() !== '';
  // So many changes that the output overflowed the buffer: whatever arrived already proves the tree is not clean.
  else if ((status.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS' && status.stdout) result.indexed_dirty = true;
  // Any other failure (a corrupt index, say): without the dirty state the commit does not say what was read, so no provenance at all.
  else return { git: false, reason: 'status-unreadable' };
  // `--ignore-submodules=all` also hides a staged gitlink update (`git add libs/sub`); index against HEAD compares object ids only,
  // so it counts that without entering the submodule or reading any content.
  if (result.indexed_dirty === false) {
    const staged = run('diff-index', '--cached', '--ignore-submodules=none', '--name-only', 'HEAD');
    if (staged.status !== 0) return { git: false, reason: 'index-unreadable' };
    if (staged.stdout.trim() !== '') result.indexed_dirty = true;
  }
  // `assume-unchanged` and `skip-worktree` entries hide edits from `git status`. `ls-files -v` marks them (lowercase tag, or `S`)
  // without comparing content, so no filter runs. A skip-worktree file that is not on disk (sparse checkout) is not read by the indexer.
  if (result.indexed_dirty === false) {
    const flags = run('ls-files', '-v', '-z');
    const overflow = (flags.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
    if (flags.status !== 0 && !overflow) return { git: false, reason: 'index-unreadable' };
    const hidden = flags.stdout.split('\0').some(entry => /^[a-z] /.test(entry) || (entry.startsWith('S ') && existsSync(join(repository, entry.slice(2)))));
    if (hidden || overflow) result.indexed_dirty = true;
  }
  return result;
}

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
  if (command === 'provenance') {
    if (rest.length !== 1 || Object.keys(values).length) throw new Error(usage);
    return { output: JSON.stringify(provenance(rest[0]!)), code: 0 };
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
