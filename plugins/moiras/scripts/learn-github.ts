/** Selection for `moiras-learn --from-github` and for the automatic run inside `moiras-sync`.
 * Usage: node learn-github.ts eligible --repo <owner/name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... < gh.json
 *        node learn-github.ts auto --repo <owner/name> --state <dir> --limit <n> [--since <date>] [--label <name>]... [--knowledge <dir>]... < gh.json
 *        node learn-github.ts revalidate --repo <owner/name> --state <dir> [--knowledge <dir>]... < gh.json
 *        node learn-github.ts scan < context.txt   (exit 1 when it carries a secret)
 *        node learn-github.ts watermark get --state <dir> --repo <owner/name> | set --state <dir> --repo <owner/name> [--pr <ts>] [--issue <ts>]
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

export const usage = 'Usage: node learn-github.ts eligible --repo <owner/name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... | auto --repo <owner/name> --state <dir> --limit <n> [--since <date>] [--label <name>]... [--knowledge <dir>]... | revalidate --repo <owner/name> --state <dir> [--knowledge <dir>]... | scan | watermark get|set --state <dir> --repo <owner/name> [--pr <ts>] [--issue <ts>] | pending list|remove --state <dir> [--ref <owner/name#n>]...';

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
  /** `<owner>/<repository>#<number>`: the `issue` of a solution when there is no Jira key. */
  ref: string;
  url: string;
  /** `mergedAt` of a PR, `closedAt` of an issue. */
  closed_at: string;
  /** Jira key found in the title or in the branch name of a PR. */
  jira_key?: string;
  /** Issues of the same owner and repository that the PR closes (`Closes #n`); a reference to another repository is dropped. */
  closes?: string[];
  /** Suggested file name (and id) of the solution, free of the ids in use. */
  suggested_id: string;
}

export interface Skipped { ref: string; kind: Kind; reason: Reason }

export interface Selection {
  owner: string;
  repository: string;
  candidates: Candidate[];
  skipped: Skipped[];
  /** Newest timestamp seen per kind (inside the window): what the watermark moves to once the candidates are safe in the pending list. */
  watermark: { pr?: string; issue?: string };
}

export interface Options {
  /** GitHub owner of the repository: the URL of a PR or issue must belong to `owner/repository`. */
  owner: string;
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
const ownerName = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
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

/** The URL must be this `owner/repository` PR or issue on github.com, so a record never points anywhere else (not even to a fork or a repository of the same name). */
function urlFor(kind: Kind, owner: string, repository: string, number: number, url: unknown): string | undefined {
  const match = typeof url === 'string' ? /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_][A-Za-z0-9._-]*)\/(pull|issues)\/(\d+)$/.exec(url) : null;
  if (!match || !validReferenceUrl(url as string)) return undefined;
  if (match[1]!.toLowerCase() !== owner.toLowerCase() || match[2]!.toLowerCase() !== repository.toLowerCase() || match[3] !== (kind === 'pr' ? 'pull' : 'issues') || Number(match[4]) !== number) return undefined;
  return url as string;
}

// Revert PRs in English and Portuguese: "Revert", "Reverts", "Reverte", "Reverter", "Revertendo", "Desfaz", "Desfazer".
const revertTitle = /^(?:revert(?:s|e|er|ing|endo)?|desfaz(?:er)?)(?![\p{L}\p{N}])/iu;
const revertQuoted = /^(?:revert(?:s|e|er|ing|endo)?|desfaz(?:er)?)\s+"(.+)"\s*$/iu;
// A negation right before the verb ("não desfaz o #3", "does not reverts #3", "never reverts #3") is not a revert.
const notNegated = String.raw`(?<!\b(?:n[ãa]o|nunca|not|never|n't)\s)(?<!n't\s)`;
// `#n` alone: "org/repo#5" or "x#5" names another repository (or something else) and is ignored.
const numberRef = String.raw`[^\n#]{0,80}?(?<![\p{L}\p{N}_/.-])#(\d{1,9})\b`;
// A plain English "revert" counts only in the title of a revert PR ("does not revert #3" is not one); the other verbs name a PR in any text.
const revertNamed = new RegExp(`${notNegated}(?<![\\p{L}\\p{N}])(?:reverts|reverte|reverter|revertendo|desfaz|desfazer)(?![\\p{L}\\p{N}])${numberRef}`, 'giu');
const revertNamedInTitle = new RegExp(`${notNegated}(?<![\\p{L}\\p{N}])(?:reverts?|reverte|reverter|reverting|revertendo|desfaz|desfazer)(?![\\p{L}\\p{N}])${numberRef}`, 'giu');
const startsWithRevert = (pr: Json): boolean => revertTitle.test(text(pr.title).trim());

/** Numbers of the PRs that this PR says it reverts (in its title and body). */
function revertsOf(pr: Json): number[] {
  const title = text(pr.title).trim();
  return [...`${title}\n${text(pr.body)}`.matchAll(startsWithRevert(pr) ? revertNamedInTitle : revertNamed)].map(match => Number(match[1]));
}

/** A revert PR: a title that starts like one, or a text that says it reverts a PR ("This reverts #n", "Reverte o #n"). */
const isRevert = (pr: Json): boolean => startsWithRevert(pr) || revertsOf(pr).length > 0;

/** PRs that revert PRs: by quoted title (`Revert "<title>"`) and by number. */
function revertedBy(prs: Json[]): { titles: Set<string>; numbers: Set<number> } {
  const titles = new Set<string>(), numbers = new Set<number>();
  for (const pr of prs) {
    const byTitle = revertQuoted.exec(text(pr.title).trim());
    if (byTitle) titles.add(byTitle[1]!.trim().toLowerCase());
    for (const number of revertsOf(pr)) numbers.add(number);
  }
  return { titles, numbers };
}

/**
 * Issues of this `owner/repository` that a PR closes (`closingIssuesReferences`). A reference to another repository, or one
 * that does not say which repository it is, is ignored: its number means nothing here.
 */
function closingNumbers(pr: Json, owner: string, repository: string): number[] {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const numbers: number[] = [];
  for (const closing of Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences : []) {
    if (!isObject(closing)) continue;
    const number = Number(closing.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const home = isObject(closing.repository) ? closing.repository : undefined;
    const name = text(home?.name), login = isObject(home?.owner) ? text((home!.owner as Json).login) : '';
    const url = typeof closing.url === 'string' ? /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_][A-Za-z0-9._-]*)\/issues\/(\d+)$/.exec(closing.url) : null;
    const checks = [
      ...(name || login ? [same(name, repository) && same(login, owner)] : []),
      ...(typeof closing.url === 'string' ? [!!url && same(url[1]!, owner) && same(url[2]!, repository) && Number(url[3]) === number] : []),
    ];
    if (checks.length && checks.every(Boolean)) numbers.push(number);
  }
  return numbers;
}

/** `<name>#<n>` of a ref, with or without the `<owner>/` in front (the format of the first version had no owner). */
const tail = (ref: string): string => ref.slice(ref.indexOf('/') + 1);
const hasRef = (refs: Set<string>, ref: string): boolean => refs.has(ref) || refs.has(tail(ref));
const sameRef = (a: string, b: string): boolean => a === b || (a.includes('/') !== b.includes('/') && tail(a) === tail(b));

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
  const { owner, repository } = options;
  if (!ownerName.test(owner) || !safeName.test(repository)) throw new Error(usage);
  for (const date of [options.since, options.until]) if (date !== undefined && !isCalendarDate(date)) throw new Error(usage);
  const since = options.since === undefined ? undefined : Date.parse(`${options.since}T00:00:00Z`);
  const until = options.until === undefined ? undefined : Date.parse(`${options.until}T00:00:00Z`) + 86_400_000;
  const wanted = (options.labels ?? []).map(label => label.toLowerCase());
  const known = options.known ?? new Set<string>();
  const used = new Set(options.ids ?? []);
  const pending = options.pending ?? new Set<string>();
  const result: Selection = { owner, repository, candidates: [], skipped: [], watermark: {} };

  const records = (list: unknown[]): Json[] => list.filter(isObject);
  const allPrs = records(prs);
  const { titles: revertTitles, numbers: revertNumbers } = revertedBy(allPrs);
  const reverted = (pr: Json): boolean => revertNumbers.has(Number(pr.number)) || revertTitles.has(text(pr.title).trim().toLowerCase());
  const closedBy = new Map<number, { good: boolean }>();
  for (const pr of allPrs) {
    if (text(pr.state).toUpperCase() !== 'MERGED' || !moment(pr.mergedAt) || isRevert(pr)) continue;
    for (const number of closingNumbers(pr, owner, repository)) closedBy.set(number, { good: (closedBy.get(number)?.good ?? false) || !reverted(pr) });
  }

  const take = (kind: Kind, item: Json, after: string | undefined, verdict: (ref: string) => Reason | undefined, extra: (item: Json) => Partial<Candidate>) => {
    const number = Number(item.number);
    const ref = Number.isInteger(number) && number > 0 ? `${owner}/${repository}#${number}` : `${owner}/${repository}#?`;
    const skip = (reason: Reason) => { result.skipped.push({ ref, kind, reason }); };
    const when = moment(kind === 'pr' ? item.mergedAt : item.closedAt);
    const url = Number.isInteger(number) && number > 0 ? urlFor(kind, owner, repository, number, item.url) : undefined;
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
    if (keys.some(key => hasRef(known, key))) return skip('already-known');
    if (hasRef(pending, ref)) return skip('already-pending');
    let suggested = `${repository.toLowerCase()}-${kind}-${number}`;
    for (let n = 2; used.has(suggested); n++) suggested = `${repository.toLowerCase()}-${kind}-${number}-${n}`;
    used.add(suggested);
    result.candidates.push({ kind, ref, url, closed_at: when, ...fields, suggested_id: suggested });
  };

  for (const pr of allPrs) {
    take('pr', pr, options.afterPr, () => {
      if (text(pr.state).toUpperCase() !== 'MERGED' || !moment(pr.mergedAt)) return 'not-merged';
      if (isRevert(pr)) return 'is-revert';
      return reverted(pr) ? 'reverted' : undefined;
    }, item => {
      const key = jiraKeyIn.exec(text(item.title))?.[0] ?? jiraKeyIn.exec(text(item.headRefName))?.[0];
      const closes = closingNumbers(item, owner, repository).map(number => `${owner}/${repository}#${number}`);
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
const slug = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const splitRepo = (value: string): { owner: string; repository: string } => {
  if (!slug.test(value)) throw new Error(usage);
  const [owner, repository] = value.split('/');
  return { owner: owner!, repository: repository! };
};
const pendingFile = 'pending.json';

/** The watermark is kept per `owner/repository`. */
export function readWatermark(dir: string, repository: string): Watermark {
  const all = readState<{ repositories?: Record<string, Watermark> }>(dir, watermarkFile, {});
  const entry = Object.hasOwn(all.repositories ?? {}, repository) ? all.repositories![repository] : undefined;
  return { ...(moment(entry?.pr) ? { pr: entry!.pr } : {}), ...(moment(entry?.issue) ? { issue: entry!.issue } : {}) };
}

/** The watermark only moves forward: an older value never replaces a newer one. */
export function writeWatermark(dir: string, repository: string, next: Watermark): Watermark {
  if (!slug.test(repository) || [next.pr, next.issue].some(value => value !== undefined && !moment(value))) throw new Error(usage);
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
    if (items.some(item => sameRef(item.ref, candidate.ref))) continue;
    items.push({ kind: candidate.kind, ref: candidate.ref, url: candidate.url, closed_at: candidate.closed_at, ...(candidate.jira_key ? { jira_key: candidate.jira_key } : {}), added_at: now });
  }
  writeState(dir, pendingFile, { version: 1, items });
  return items;
}

export function removePending(dir: string, refs: string[]): PendingItem[] {
  const items = readPending(dir).filter(item => !refs.some(ref => sameRef(ref, item.ref)));
  writeState(dir, pendingFile, { version: 1, items });
  return items;
}

function knowledgeIndex(dirs: string[]): { known: Set<string>; ids: Set<string> } {
  if (!dirs.length) return { known: new Set(), ids: new Set() };
  const index = knownIssues(dirs);
  return { known: new Set(Object.keys(index.issues)), ids: new Set(index.ids) };
}

const staleReasons: ReadonlySet<Reason> = new Set(['not-merged', 'reverted', 'is-revert', 'not-completed', 'covered-by-pr', 'already-known', 'secret', 'invalid']);

export interface Revalidation {
  /** Still eligible: may be proposed. */
  valid: string[];
  /** Taken off the pending list, with the reason (reverted, closed differently, already learned, ...). */
  removed: Skipped[];
  /** Not in the data that was read, so nothing can be said: not proposed until a read that has them. */
  unverified: string[];
}

/**
 * Checks the pending items of a repository against fresh data (`{ prs, issues }` from `gh`) and takes off the list the ones
 * that are no longer eligible: a merged PR that a newer PR reverted (even when the original is not in the data), an issue that
 * is no longer closed as completed, an item the knowledge already cites or that now carries a secret. Items the data does not
 * show stay on the list as `unverified`: the caller must not propose them.
 */
export function revalidate(input: unknown, options: { owner: string; repository: string; state: string; known?: Set<string>; ids?: Set<string> }): Revalidation {
  const { owner, repository } = options;
  const selection = select(input, { owner, repository, known: options.known, ids: options.ids });
  const { numbers: revertedNumbers } = revertedBy(isObject(input) && Array.isArray(input.prs) ? input.prs.filter(isObject) : []);
  const reasons = new Map(selection.skipped.map(item => [item.ref, item.reason]));
  const eligible = new Set(selection.candidates.map(candidate => candidate.ref));
  const result: Revalidation = { valid: [], removed: [], unverified: [] };
  for (const item of readPending(options.state)) {
    const match = /^(?:([A-Za-z0-9][A-Za-z0-9-]*)\/)?([A-Za-z0-9_][A-Za-z0-9._-]*)#(\d+)$/.exec(item.ref);
    if (!match || match[2]!.toLowerCase() !== repository.toLowerCase() || (match[1] && match[1].toLowerCase() !== owner.toLowerCase())) continue;
    const ref = `${owner}/${repository}#${match[3]}`;
    const reason = reasons.get(ref);
    if (eligible.has(ref)) result.valid.push(item.ref);
    else if (reason && staleReasons.has(reason)) result.removed.push({ ref: item.ref, kind: item.kind, reason });
    else if (item.kind === 'pr' && revertedNumbers.has(Number(match[3]))) result.removed.push({ ref: item.ref, kind: item.kind, reason: 'reverted' });
    else result.unverified.push(item.ref);
  }
  if (result.removed.length) removePending(options.state, result.removed.map(item => item.ref));
  return result;
}

/** True when a list may have been cut: `gh ... --limit N` returned N items (or more), so older ones may be missing. */
const truncated = (list: unknown, limit: number): boolean => Array.isArray(list) && list.length >= limit;

/**
 * The automatic run: first drops from the pending list what is no longer eligible, then selects what closed since the
 * watermark, adds it to the pending list and moves the watermark. It never writes a learning (see `autoDisposition`).
 * The watermark only moves after the list was saved, so a failure leaves it where it was and the next run takes the same
 * items again. A list cut by `--limit` does not move the watermark of that kind: older items may be missing, and moving it
 * would lose them; the run needs a complete read (a bigger `--limit`).
 */
export function auto(input: unknown, options: Omit<Options, 'afterPr' | 'afterIssue' | 'pending' | 'until'> & { state: string; limit: number }): Selection & { disposition: typeof autoDisposition; pending: number; first_run: boolean; pruned: Skipped[]; truncated: Kind[] } {
  if (autoDisposition !== 'pending') throw new Error('Automatic mode only builds the pending list.');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error(usage);
  const key = `${options.owner}/${options.repository}`;
  const mark = readWatermark(options.state, key);
  const first = mark.pr === undefined && mark.issue === undefined;
  // Without a watermark the run would take the whole history: it needs an explicit starting date.
  if (first && options.since === undefined) throw new Error('First automatic run needs --since.');
  const { removed } = revalidate(input, { owner: options.owner, repository: options.repository, state: options.state, known: options.known, ids: options.ids });
  const selection = select(input, { ...options, afterPr: mark.pr, afterIssue: mark.issue, pending: new Set(readPending(options.state).map(item => item.ref)) });
  const items = addPending(options.state, selection.candidates);
  const cut: Kind[] = [];
  const lists = isObject(input) ? input : {};
  if (truncated(lists.prs, options.limit)) cut.push('pr');
  if (truncated(lists.issues, options.limit)) cut.push('issue');
  const next = { ...selection.watermark };
  for (const kind of cut) delete next[kind];
  if (next.pr || next.issue) writeWatermark(options.state, key, next);
  return { ...selection, watermark: next, disposition: autoDisposition, pending: items.length, first_run: first, pruned: removed, truncated: cut };
}

/** True when any string of the JSON (or the text) carries a secret: what the skill runs on the context it reads for a candidate. */
export function scan(input: string): { secret: boolean } {
  let value: unknown = input;
  try { value = JSON.parse(input); } catch { /* plain text */ }
  return { secret: hasSecretIn(value) || hasSecretIn(input) };
}

function readJson(input?: string): unknown {
  try { return JSON.parse(input ?? readFileSync(0, 'utf8')); } catch { throw new Error('Invalid JSON input.'); }
}

export function main(argv: string[], input?: string): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      repo: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, after: { type: 'string' }, label: { type: 'string', multiple: true },
      state: { type: 'string' }, knowledge: { type: 'string', multiple: true }, pr: { type: 'string' }, issue: { type: 'string' }, limit: { type: 'string' }, ref: { type: 'string', multiple: true },
    } });
  } catch { throw new Error(usage); }
  const { positionals: [command, sub, ...extra], values: v } = parsed;
  const out = (value: unknown) => ({ output: JSON.stringify(value), code: 0 });
  const allowed: Record<string, string[]> = {
    eligible: ['repo', 'since', 'until', 'after', 'label', 'state', 'knowledge', 'limit'],
    auto: ['repo', 'since', 'label', 'state', 'knowledge', 'limit'],
    revalidate: ['repo', 'state', 'knowledge'],
    scan: [],
    watermark: ['state', 'repo', 'pr', 'issue'],
    pending: ['state', 'ref'],
  };
  if (!command || !allowed[command] || extra.length || Object.keys(v).some(key => !allowed[command]!.includes(key))) throw new Error(usage);
  if ((command === 'eligible' || command === 'auto') && sub === undefined && v.repo) {
    const index = knowledgeIndex(v.knowledge ?? []);
    if (v.after !== undefined && !moment(v.after)) throw new Error(usage);
    if (command === 'auto') {
      if (!v.state) throw new Error(usage);
      if (!v.limit || !/^[1-9][0-9]*$/.test(v.limit)) throw new Error(usage);
      return out(auto(readJson(input), { ...splitRepo(v.repo), since: v.since, labels: v.label, known: index.known, ids: index.ids, state: v.state, limit: Number(v.limit) }));
    }
    const pending = v.state ? new Set(readPending(v.state).map(item => item.ref)) : undefined;
    if (v.limit !== undefined && !/^[1-9][0-9]*$/.test(v.limit)) throw new Error(usage);
    const data = readJson(input);
    const selection = select(data, { ...splitRepo(v.repo), since: v.since, until: v.until, afterPr: v.after, afterIssue: v.after, labels: v.label, known: index.known, ids: index.ids, pending });
    const lists = isObject(data) ? data : {};
    return out(v.limit === undefined ? selection : { ...selection, truncated: (['pr', 'issue'] as Kind[]).filter(kind => truncated(kind === 'pr' ? lists.prs : lists.issues, Number(v.limit))) });
  }
  if (command === 'revalidate' && v.repo && v.state) {
    const index = knowledgeIndex(v.knowledge ?? []);
    return out(revalidate(readJson(input), { ...splitRepo(v.repo), state: v.state, known: index.known, ids: index.ids }));
  }
  if (command === 'scan' && sub === undefined) {
    const result = scan(input ?? readFileSync(0, 'utf8'));
    return { output: JSON.stringify(result), code: result.secret ? 1 : 0 };
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
