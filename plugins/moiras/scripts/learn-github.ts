/** Selection for `moiras-learn --from-github` and for the automatic run inside `moiras-sync`.
 * Usage: node learn-github.ts eligible --repo <name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... < gh.json
 *        node learn-github.ts auto --repo <name> --state <dir> [--since <date>] [--label <name>]... [--knowledge <dir>]... < gh.json
 *        node learn-github.ts watermark get --state <dir> --repo <name> | set --state <dir> --repo <name> [--pr <ts>] [--issue <ts>]
 *        node learn-github.ts pending list --state <dir> | remove --state <dir> --ref <name#n>...
 *
 * Reads the JSON of `gh pr list --state merged` and `gh issue list --state closed` from stdin ({ prs, issues })
 * and decides which items may become learnings. It never calls GitHub and never writes to a knowledge: the only
 * files it writes are the watermark and the pending list under `--state` (run state, outside any knowledge).
 * It prints references, reasons and timestamps, never the text of a PR or an issue.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable and import siblings with the .ts extension.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hasSecret, isCalendarDate, issues as knownIssues, patterns, validReferenceUrl } from './knowledge.ts';

export const usage = 'Usage: node learn-github.ts eligible --repo <name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... | auto --repo <name> --state <dir> [--since <date>] [--label <name>]... [--knowledge <dir>]... | watermark get|set --state <dir> --repo <name> [--pr <ts>] [--issue <ts>] | pending list|remove --state <dir> [--ref <name#n>]...';

/**
 * DECISION POINT (issue #68): what the automatic run does with what it finds. Today it only builds a pending list
 * that the user approves later (moiras-learn writes only after the "sim" to the exact list, see AGENTS.md). Writing
 * learnings straight from the automatic run would be a different value here, a matching branch in `auto`, and an
 * exception in AGENTS.md and in the moiras-learn skill. Nothing else depends on this choice.
 */
export const autoDisposition = 'pending' as const;

export type Kind = 'pr' | 'issue';
export type Reason = 'not-merged' | 'reverted' | 'is-revert' | 'not-completed' | 'outside-period' | 'label-mismatch' | 'already-known' | 'already-pending' | 'covered-by-pr' | 'secret' | 'invalid';

export interface Candidate {
  kind: Kind;
  /** `<repository>#<number>`: the `issue` of a solution when there is no Jira key. */
  ref: string;
  url: string;
  /** `mergedAt` of a PR, `closedAt` of an issue. */
  closed_at: string;
  /** Jira key found in the title or in the branch name of a PR. */
  jira_key?: string;
  /** Issues of the same repository that the PR closes (`Closes #n`). */
  closes?: string[];
  /** Suggested file name (and id) of the solution, free of the ids in use. */
  suggested_id: string;
}

export interface Skipped { ref: string; kind: Kind; reason: Reason }

export interface Selection {
  repository: string;
  candidates: Candidate[];
  skipped: Skipped[];
  /** Newest timestamp seen per kind (inside the window): what the watermark moves to once the candidates are safe in the pending list. */
  watermark: { pr?: string; issue?: string };
}

export interface Options {
  repository: string;
  since?: string;
  until?: string;
  afterPr?: string;
  afterIssue?: string;
  labels?: string[];
  /** Issue keys and refs the knowledge already cites (`knowledge.ts issues`). */
  known?: Set<string>;
  /** Ids and file names in use. */
  ids?: Set<string>;
  pending?: Set<string>;
}

const safeName = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const jiraKeyIn = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]*-\d+(?![A-Za-z0-9])/;
const secretPattern = patterns.find(entry => entry.rule === 'secret')!.test;
const maxItems = 5000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const moment = (value: unknown): string | undefined => (typeof value === 'string' && timestamp.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);
const later = (a: string | undefined, b: string): string => (a === undefined || Date.parse(b) > Date.parse(a) ? b : a);

/** True when any string of the item (title, body, branch, labels, file paths, comments) carries a secret. */
function hasSecretIn(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.split('\n').some(line => hasSecret(line) || secretPattern.test(line));
  if (depth > 6) return false;
  if (Array.isArray(value)) return value.some(item => hasSecretIn(item, depth + 1));
  if (isObject(value)) return Object.values(value).some(item => hasSecretIn(item, depth + 1));
  return false;
}

const labelNames = (item: Json): string[] => (Array.isArray(item.labels) ? item.labels : []).map(label => (isObject(label) ? text(label.name) : text(label))).filter(Boolean);

/** The URL must be this repository's PR or issue on github.com, so a record never points anywhere else. */
function urlFor(kind: Kind, repository: string, number: number, url: unknown): string | undefined {
  const match = typeof url === 'string' ? /^https:\/\/github\.com\/[A-Za-z0-9-]+\/([A-Za-z0-9_][A-Za-z0-9._-]*)\/(pull|issues)\/(\d+)$/.exec(url) : null;
  if (!match || !validReferenceUrl(url as string)) return undefined;
  if (match[1]!.toLowerCase() !== repository.toLowerCase() || match[2] !== (kind === 'pr' ? 'pull' : 'issues') || Number(match[3]) !== number) return undefined;
  return url as string;
}

/** Numbers of the PRs that a revert PR names: `Revert "<title>"` by title, or `Reverts #n` / `This reverts ... #n` in the text. */
function revertedBy(prs: Json[]): { titles: Set<string>; numbers: Set<number> } {
  const titles = new Set<string>(), numbers = new Set<number>();
  for (const pr of prs) {
    const title = text(pr.title).trim();
    const byTitle = /^revert\s+"(.+)"\s*$/i.exec(title);
    if (byTitle) titles.add(byTitle[1]!.trim().toLowerCase());
    // `Reverts #n` names a PR in any PR; a plain "revert" counts only in the title of a revert PR ("does not revert #3" is not one).
    const phrase = /^revert\b/i.test(title) ? /\breverts?\b[^\n#]{0,80}?#(\d{1,9})\b/gi : /\b(?:this\s+)?reverts\b[^\n#]{0,80}?#(\d{1,9})\b/gi;
    for (const match of `${title}\n${text(pr.body)}`.matchAll(phrase)) numbers.add(Number(match[1]));
  }
  return { titles, numbers };
}

/**
 * Decides, for each merged PR and each closed issue, whether it may become a learning. Only merged PRs that were not
 * reverted and issues closed as completed pass; the period, label, watermark, knowledge and pending list narrow the rest.
 * Nothing in the result is text from the PR or the issue.
 */
export function select(input: unknown, options: Options): Selection {
  if (!isObject(input)) throw new Error('Expected { prs, issues }.');
  const prs = input.prs === undefined ? [] : input.prs;
  const issues = input.issues === undefined ? [] : input.issues;
  if (!Array.isArray(prs) || !Array.isArray(issues) || prs.length + issues.length > maxItems) throw new Error('Expected { prs, issues }.');
  const { repository } = options;
  if (!safeName.test(repository)) throw new Error(usage);
  for (const date of [options.since, options.until]) if (date !== undefined && !isCalendarDate(date)) throw new Error(usage);
  const since = options.since === undefined ? undefined : Date.parse(`${options.since}T00:00:00Z`);
  const until = options.until === undefined ? undefined : Date.parse(`${options.until}T00:00:00Z`) + 86_400_000;
  const wanted = (options.labels ?? []).map(label => label.toLowerCase());
  const known = options.known ?? new Set<string>();
  const used = new Set(options.ids ?? []);
  const pending = options.pending ?? new Set<string>();
  const result: Selection = { repository, candidates: [], skipped: [], watermark: {} };

  const records = (list: unknown[]): Json[] => list.filter(isObject);
  const allPrs = records(prs);
  const { titles: revertTitles, numbers: revertNumbers } = revertedBy(allPrs);
  const reverted = (pr: Json): boolean => revertNumbers.has(Number(pr.number)) || revertTitles.has(text(pr.title).trim().toLowerCase());
  const closedBy = new Map<number, { good: boolean }>();
  for (const pr of allPrs) {
    if (text(pr.state).toUpperCase() !== 'MERGED' || !moment(pr.mergedAt) || /^revert\b/i.test(text(pr.title).trim())) continue;
    for (const closing of Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences : []) {
      const number = isObject(closing) ? Number(closing.number) : NaN;
      if (Number.isInteger(number)) closedBy.set(number, { good: (closedBy.get(number)?.good ?? false) || !reverted(pr) });
    }
  }

  const take = (kind: Kind, item: Json, after: string | undefined, verdict: (ref: string) => Reason | undefined, extra: (item: Json) => Partial<Candidate>) => {
    const number = Number(item.number);
    const ref = Number.isInteger(number) && number > 0 ? `${repository}#${number}` : `${repository}#?`;
    const skip = (reason: Reason) => { result.skipped.push({ ref, kind, reason }); };
    const when = moment(kind === 'pr' ? item.mergedAt : item.closedAt);
    const url = Number.isInteger(number) && number > 0 ? urlFor(kind, repository, number, item.url) : undefined;
    if (!url) return skip(kind === 'pr' && text(item.state).toUpperCase() !== 'MERGED' ? 'not-merged' : 'invalid');
    const early = verdict(ref);
    if (early && (early === 'not-merged' || early === 'not-completed' || early === 'is-revert' || early === 'reverted')) return skip(early);
    if (!when) return skip('invalid');
    const time = Date.parse(when);
    if ((since !== undefined && time < since) || (until !== undefined && time >= until)) return skip('outside-period');
    // The watermark only looks at what is new: an item before it was already seen by an earlier run.
    if (after !== undefined && time <= Date.parse(after)) return skip('outside-period');
    result.watermark[kind] = later(result.watermark[kind], when);
    if (wanted.length && !labelNames(item).some(label => wanted.includes(label.toLowerCase()))) return skip('label-mismatch');
    if (hasSecretIn(item)) return skip('secret');
    if (early) return skip(early);
    const fields = extra(item);
    const keys = [ref, ...(fields.jira_key ? [fields.jira_key] : [])];
    if (keys.some(key => known.has(key))) return skip('already-known');
    if (pending.has(ref)) return skip('already-pending');
    let suggested = `${repository.toLowerCase()}-${kind}-${number}`;
    for (let n = 2; used.has(suggested); n++) suggested = `${repository.toLowerCase()}-${kind}-${number}-${n}`;
    used.add(suggested);
    result.candidates.push({ kind, ref, url, closed_at: when, ...fields, suggested_id: suggested });
  };

  for (const pr of allPrs) {
    take('pr', pr, options.afterPr, () => {
      if (text(pr.state).toUpperCase() !== 'MERGED' || !moment(pr.mergedAt)) return 'not-merged';
      if (/^revert\b/i.test(text(pr.title).trim())) return 'is-revert';
      return reverted(pr) ? 'reverted' : undefined;
    }, item => {
      const key = jiraKeyIn.exec(text(item.title))?.[0] ?? jiraKeyIn.exec(text(item.headRefName))?.[0];
      const closes = (Array.isArray(item.closingIssuesReferences) ? item.closingIssuesReferences : []).map(closing => (isObject(closing) ? Number(closing.number) : NaN)).filter(number => Number.isInteger(number) && number > 0).map(number => `${repository}#${number}`);
      return { ...(key ? { jira_key: key } : {}), ...(closes.length ? { closes } : {}) };
    });
  }
  for (const issue of records(issues)) {
    take('issue', issue, options.afterIssue, () => {
      // Closed as "not planned" or as a duplicate is not a solution; only COMPLETED counts.
      if (text(issue.state).toUpperCase() !== 'CLOSED' || text(issue.stateReason).toUpperCase() !== 'COMPLETED') return 'not-completed';
      const closing = closedBy.get(Number(issue.number));
      if (closing) return closing.good ? 'covered-by-pr' : 'reverted';
      return undefined;
    }, () => ({}));
  }
  return result;
}

/* Run state: the watermark and the pending list. They are not knowledge and never leave the machine. */

interface Watermark { pr?: string; issue?: string }
interface PendingItem { kind: Kind; ref: string; url: string; closed_at: string; jira_key?: string; added_at: string }

function stateFile(dir: string, name: string): string {
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('State folder refused.');
  const file = join(dir, name);
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('State file refused.');
  return file;
}

function readState<T>(dir: string, name: string, empty: T): T {
  const file = stateFile(dir, name);
  if (!existsSync(file)) return empty;
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { throw new Error('State file invalid.'); }
}

function writeState(dir: string, name: string, value: unknown): void {
  const file = stateFile(dir, name);
  mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}

const watermarkFile = 'watermark.json';
const pendingFile = 'pending.json';

export function readWatermark(dir: string, repository: string): Watermark {
  const all = readState<{ repositories?: Record<string, Watermark> }>(dir, watermarkFile, {});
  const entry = Object.hasOwn(all.repositories ?? {}, repository) ? all.repositories![repository] : undefined;
  return { ...(moment(entry?.pr) ? { pr: entry!.pr } : {}), ...(moment(entry?.issue) ? { issue: entry!.issue } : {}) };
}

/** The watermark only moves forward: an older value never replaces a newer one. */
export function writeWatermark(dir: string, repository: string, next: Watermark): Watermark {
  if (!safeName.test(repository) || [next.pr, next.issue].some(value => value !== undefined && !moment(value))) throw new Error(usage);
  const all = readState<{ version: number; repositories: Record<string, Watermark> }>(dir, watermarkFile, { version: 1, repositories: {} });
  const current = readWatermark(dir, repository);
  const merged: Watermark = {
    ...(next.pr ? { pr: later(current.pr, next.pr) } : current.pr ? { pr: current.pr } : {}),
    ...(next.issue ? { issue: later(current.issue, next.issue) } : current.issue ? { issue: current.issue } : {}),
  };
  writeState(dir, watermarkFile, { version: 1, repositories: { ...all.repositories, [repository]: merged } });
  return merged;
}

export function readPending(dir: string): PendingItem[] {
  const all = readState<{ items?: PendingItem[] }>(dir, pendingFile, {});
  return Array.isArray(all.items) ? all.items.filter(item => isObject(item) && typeof item.ref === 'string') : [];
}

export function addPending(dir: string, candidates: Candidate[], now = new Date().toISOString()): PendingItem[] {
  const items = readPending(dir);
  for (const candidate of candidates) {
    if (items.some(item => item.ref === candidate.ref)) continue;
    items.push({ kind: candidate.kind, ref: candidate.ref, url: candidate.url, closed_at: candidate.closed_at, ...(candidate.jira_key ? { jira_key: candidate.jira_key } : {}), added_at: now });
  }
  writeState(dir, pendingFile, { version: 1, items });
  return items;
}

export function removePending(dir: string, refs: string[]): PendingItem[] {
  const items = readPending(dir).filter(item => !refs.includes(item.ref));
  writeState(dir, pendingFile, { version: 1, items });
  return items;
}

function knowledgeIndex(dirs: string[]): { known: Set<string>; ids: Set<string> } {
  if (!dirs.length) return { known: new Set(), ids: new Set() };
  const index = knownIssues(dirs);
  return { known: new Set(Object.keys(index.issues)), ids: new Set(index.ids) };
}

/**
 * The automatic run: selects what closed since the watermark, adds it to the pending list and moves the watermark.
 * It never writes a learning (see `autoDisposition`). The watermark only moves after the list was saved, so a failure
 * leaves it where it was and the next run takes the same items again.
 */
export function auto(input: unknown, options: Omit<Options, 'afterPr' | 'afterIssue' | 'pending' | 'until'> & { state: string }): Selection & { disposition: typeof autoDisposition; pending: number; first_run: boolean } {
  if (autoDisposition !== 'pending') throw new Error('Automatic mode only builds the pending list.');
  const mark = readWatermark(options.state, options.repository);
  const first = mark.pr === undefined && mark.issue === undefined;
  // Without a watermark the run would take the whole history: it needs an explicit starting date.
  if (first && options.since === undefined) throw new Error('First automatic run needs --since.');
  const selection = select(input, { ...options, afterPr: mark.pr, afterIssue: mark.issue, pending: new Set(readPending(options.state).map(item => item.ref)) });
  const items = addPending(options.state, selection.candidates);
  writeWatermark(options.state, options.repository, selection.watermark);
  return { ...selection, disposition: autoDisposition, pending: items.length, first_run: first };
}

function readJson(input?: string): unknown {
  try { return JSON.parse(input ?? readFileSync(0, 'utf8')); } catch { throw new Error('Invalid JSON input.'); }
}

export function main(argv: string[], input?: string): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      repo: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, after: { type: 'string' }, label: { type: 'string', multiple: true },
      state: { type: 'string' }, knowledge: { type: 'string', multiple: true }, pr: { type: 'string' }, issue: { type: 'string' }, ref: { type: 'string', multiple: true },
    } });
  } catch { throw new Error(usage); }
  const { positionals: [command, sub, ...extra], values: v } = parsed;
  const out = (value: unknown) => ({ output: JSON.stringify(value), code: 0 });
  const allowed: Record<string, string[]> = {
    eligible: ['repo', 'since', 'until', 'after', 'label', 'state', 'knowledge'],
    auto: ['repo', 'since', 'label', 'state', 'knowledge'],
    watermark: ['state', 'repo', 'pr', 'issue'],
    pending: ['state', 'ref'],
  };
  if (!command || !allowed[command] || extra.length || Object.keys(v).some(key => !allowed[command]!.includes(key))) throw new Error(usage);
  if ((command === 'eligible' || command === 'auto') && sub === undefined && v.repo) {
    const index = knowledgeIndex(v.knowledge ?? []);
    if (v.after !== undefined && !moment(v.after)) throw new Error(usage);
    if (command === 'auto') {
      if (!v.state) throw new Error(usage);
      return out(auto(readJson(input), { repository: v.repo, since: v.since, labels: v.label, known: index.known, ids: index.ids, state: v.state }));
    }
    const pending = v.state ? new Set(readPending(v.state).map(item => item.ref)) : undefined;
    return out(select(readJson(input), { repository: v.repo, since: v.since, until: v.until, afterPr: v.after, afterIssue: v.after, labels: v.label, known: index.known, ids: index.ids, pending }));
  }
  if (command === 'watermark' && v.state && v.repo && Object.keys(v).every(key => key === 'state' || key === 'repo' || (sub === 'set' && (key === 'pr' || key === 'issue')))) {
    if (sub === 'get') return out(readWatermark(v.state, v.repo));
    if (sub === 'set' && (v.pr || v.issue)) return out(writeWatermark(v.state, v.repo, { pr: v.pr, issue: v.issue }));
  }
  if (command === 'pending' && v.state) {
    if (sub === 'list' && !v.ref) return out({ items: readPending(v.state) });
    if (sub === 'remove' && v.ref?.length) return out({ items: removePending(v.state, v.ref) });
  }
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${result.output}\n`);
    process.exitCode = result.code;
  } catch (error) {
    // Messages are fixed strings (or knowledge.ts errors about the knowledge folder): none carries text from a PR or an issue.
    process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
    process.exitCode = 2;
  }
}
