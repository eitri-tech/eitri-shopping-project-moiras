/** Selection for `moiras-learn --from-git` (any provider) and, through learn-github.ts, for `--from-github` and the automatic run.
 * Usage: node learn-git.ts eligible --provider <github|bitbucket> --repo <owner/name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... [--limit <n>] < provider.json
 *
 * The provider JSON is what the user's reader gave (`gh pr list` / `gh issue list` for GitHub, the PR list of the Bitbucket API
 * for Bitbucket) under `pulls` (or `prs`, or `values`), and `issues` for GitHub. providers.ts turns each record into the
 * normalized Pull or Issue; this file decides with those records only.
 *
 * Decisions: a merged PR that was not reverted is a solution (`outcome: resolved`). A PR closed without merge, or superseded,
 * is a rejected approach (`outcome: rejected`) only with an explicit reason in the PR itself: a comment or a review written
 * in the week before its closing, or another PR that says it replaces it at the start of a line ("Replaces #n"). Without one it
 * stays out (`not-merged` or `no-reason`). The selector never reads text to show it: it prints references, reasons and dates.
 *
 * It never calls a provider and never writes a learning: the only files it writes are the watermark and the pending list
 * under `--state` (run state, outside any knowledge).
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable and import siblings with the .ts extension.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hasSecret, isCalendarDate, issues as knownIssues, patterns, validReferenceUrl } from './knowledge.ts';
import { adapterFor, isObject, type Adapter, type Discussion, type Issue, type Json, type Provider, type Pull } from './providers.ts';

export const usage = 'Usage: node learn-git.ts eligible --provider <github|bitbucket> --repo <owner/name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... [--limit <n>]';

export type Kind = 'pr' | 'issue';
/** `resolved`: a solution (merged PR, or issue closed as completed). `rejected`: an approach that did not go in, with its reason in the PR. */
export type Outcome = 'resolved' | 'rejected';
export type Reason = 'not-merged' | 'no-reason' | 'reverted' | 'is-revert' | 'not-completed' | 'outside-period' | 'label-mismatch' | 'already-known' | 'already-pending' | 'covered-by-pr' | 'secret' | 'invalid';

export interface Candidate {
  provider: Provider;
  kind: Kind;
  outcome: Outcome;
  /** `<owner>/<repository>#<number>`: the `issue` of a solution when there is no Jira key. */
  ref: string;
  url: string;
  /** `mergedAt` of a merged PR, `closedAt` of a rejected PR or of an issue. */
  closed_at: string;
  /** Jira key found in the title or in the branch name of a PR. */
  jira_key?: string;
  /** Issues of the same owner and repository that the PR closes (`Closes #n`); a reference to another repository is dropped. */
  closes?: string[];
  /** Rejected PRs only: where the reason is. `comment` or `review` (the PR itself), or `superseded` (another PR replaces it). */
  reason_kind?: 'comment' | 'review' | 'superseded';
  /** Rejected PRs with a comment or a review: when it was written (the text is read by the skill, never printed). */
  reason_at?: string;
  /** Rejected PRs superseded by another PR: the reference of the replacing PR. */
  superseded_by?: string;
  /** Suggested file name (and id) of the record, free of the ids in use. */
  suggested_id: string;
}

export interface Skipped { ref: string; kind: Kind; reason: Reason }

export interface Selection {
  provider: Provider;
  owner: string;
  repository: string;
  candidates: Candidate[];
  skipped: Skipped[];
  /** Newest timestamp seen per kind (inside the window): what the watermark moves to once the candidates are safe in the pending list. */
  watermark: { pr?: string; issue?: string };
}

export interface Input {
  pulls: Pull[];
  issues?: Issue[];
}

export interface Options {
  provider?: Provider;
  /** Owner of the repository (GitHub user or organization, Bitbucket workspace): the URL of a PR or issue must belong to `owner/repository`. */
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
const slugPattern = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_][A-Za-z0-9._-]*)$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const jiraKeyIn = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]*-\d+(?![A-Za-z0-9])/;
const secretPattern = patterns.find(entry => entry.rule === 'secret')!.test;
/** A comment or review counts as the closing reason when it was written this many days before the PR was closed (or a minute after). */
const closingWindowDays = 7;

const moment = (value: unknown): string | undefined => (typeof value === 'string' && timestamp.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined);
const later = (a: string | undefined, b: string): string => (a === undefined || Date.parse(b) > Date.parse(a) ? b : a);

/** True when any string of the record (title, body, branch, labels, file paths, comments) carries a secret. */
export function hasSecretIn(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.split('\n').some(line => hasSecret(line) || secretPattern.test(line));
  if (depth > 6) return false;
  if (Array.isArray(value)) return value.some(item => hasSecretIn(item, depth + 1));
  if (isObject(value)) return Object.values(value).some(item => hasSecretIn(item, depth + 1));
  return false;
}

/** The URL must be this owner and repository's PR or issue on the provider, so a record never points anywhere else. */
function ownUrl(adapter: Adapter, kind: Kind, owner: string, repository: string, number: number, url: string): boolean {
  const expected = kind === 'pr' ? adapter.pullUrl(owner, repository, number) : adapter.issueUrl?.(owner, repository, number);
  return expected !== undefined && validReferenceUrl(url) && url.toLowerCase() === expected.toLowerCase();
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
// "Replaces #n" / "Supersedes #n" / "Substitui o #n" at the start of a line of the title or the body: a PR that says it replaces another.
const supersedeLine = /^(?:this (?:pr |pull request )?)?(?:supersedes|replaces|substitui|substituí|substituir)\s+(?:(?:o|a|the)\s+)?(?:pr\s+|pull request\s+)?#(\d{1,9})(?!\d)/gimu;

const startsWithRevert = (pr: Pull): boolean => revertTitle.test(pr.title.trim());

/** Numbers of the PRs that this PR says it reverts (in its title and body). */
function revertsOf(pr: Pull): number[] {
  const title = pr.title.trim();
  return [...`${title}\n${pr.body}`.matchAll(startsWithRevert(pr) ? revertNamedInTitle : revertNamed)].map(match => Number(match[1]));
}

/** A revert PR: a title that starts like one, or a text that says it reverts a PR ("This reverts #n", "Reverte o #n"). */
const isRevert = (pr: Pull): boolean => startsWithRevert(pr) || revertsOf(pr).length > 0;

/** PRs that revert PRs: by quoted title (`Revert "<title>"`) and by number. Only a merged revert counts: an open or closed one reverted nothing. */
export function revertedBy(pulls: Pull[]): { titles: Set<string>; numbers: Set<number> } {
  const titles = new Set<string>(), numbers = new Set<number>();
  for (const pr of pulls) {
    if (pr.state !== 'merged' || !moment(pr.mergedAt)) continue;
    const byTitle = revertQuoted.exec(pr.title.trim());
    if (byTitle) titles.add(byTitle[1]!.trim().toLowerCase());
    for (const number of revertsOf(pr)) numbers.add(number);
  }
  return { titles, numbers };
}

/** Number of the PR that each PR number is replaced by (the first PR that says so). */
function supersessions(pulls: Pull[]): Map<number, number> {
  const replaced = new Map<number, number>();
  for (const pr of pulls) {
    for (const match of `${pr.title.trim()}\n${pr.body}`.matchAll(supersedeLine)) {
      const number = Number(match[1]);
      if (number !== pr.number && !replaced.has(number)) replaced.set(number, pr.number);
    }
  }
  return replaced;
}

/** The explicit reason of a PR closed without merge: another PR that replaces it, or a comment or review of the week before the closing. */
function motiveOf(pr: Pull, replaced: Map<number, number>): { kind: 'comment' | 'review' | 'superseded'; at?: string; by?: number } | undefined {
  const by = replaced.get(pr.number);
  if (by !== undefined) return { kind: 'superseded', by };
  const closed = moment(pr.closedAt);
  if (!closed) return undefined;
  const end = Date.parse(closed), start = end - closingWindowDays * 86_400_000;
  let found: { item: Discussion; at: string } | undefined;
  for (const item of pr.discussion) {
    const at = moment(item.at);
    if (!at || !item.text.trim()) continue;
    const time = Date.parse(at);
    if (time < start || time > end + 60_000) continue;
    if (!found || time > Date.parse(found.at)) found = { item, at };
  }
  return found ? { kind: found.item.kind, at: found.at } : undefined;
}

/** `<name>#<n>` of a ref, with or without the `<owner>/` in front (the format of the first version had no owner). */
const tail = (ref: string): string => ref.slice(ref.indexOf('/') + 1);
const hasRef = (refs: Set<string>, ref: string): boolean => {
  // Owner and repository names are case-insensitive on GitHub, so the comparison is too (Jira keys are upper case on both sides).
  const lower = new Set([...refs].map(item => item.toLowerCase()));
  return lower.has(ref.toLowerCase()) || lower.has(tail(ref).toLowerCase());
};
const sameRef = (a: string, b: string): boolean => a === b || (a.includes('/') !== b.includes('/') && tail(a) === tail(b));

type Verdict = { skip?: Reason; late?: boolean; outcome: Outcome; extra?: Partial<Candidate> };

/**
 * Decides, for each PR and each issue, whether it may become a learning. Merged PRs that were not reverted are solutions; PRs
 * closed without merge with an explicit reason are rejected approaches; issues only when closed as completed. The period, label,
 * watermark, knowledge and pending list narrow the rest. Nothing in the result is text from the PR or the issue.
 */
export function selectItems(input: Input, options: Options): Selection {
  const provider = options.provider ?? 'github';
  const adapter = adapterFor(provider);
  const { owner, repository } = options;
  if (!ownerName.test(owner) || !safeName.test(repository)) throw new Error(usage);
  for (const date of [options.since, options.until]) if (date !== undefined && !isCalendarDate(date)) throw new Error(usage);
  const since = options.since === undefined ? undefined : Date.parse(`${options.since}T00:00:00Z`);
  const until = options.until === undefined ? undefined : Date.parse(`${options.until}T00:00:00Z`) + 86_400_000;
  const wanted = (options.labels ?? []).map(label => label.toLowerCase());
  const known = options.known ?? new Set<string>();
  const used = new Set(options.ids ?? []);
  const pending = options.pending ?? new Set<string>();
  const result: Selection = { provider, owner, repository, candidates: [], skipped: [], watermark: {} };
  const pulls = input.pulls;

  const { titles: revertTitles, numbers: revertNumbers } = revertedBy(pulls);
  const reverted = (pr: Pull): boolean => revertNumbers.has(pr.number) || revertTitles.has(pr.title.trim().toLowerCase());
  const replaced = supersessions(pulls);
  const closedBy = new Map<number, { good: boolean }>();
  for (const pr of pulls) {
    if (pr.state !== 'merged' || !moment(pr.mergedAt) || isRevert(pr)) continue;
    for (const number of pr.closes) closedBy.set(number, { good: (closedBy.get(number)?.good ?? false) || !reverted(pr) });
  }

  const pullVerdict = (pr: Pull): Verdict => {
    if (pr.state === 'merged') {
      if (!moment(pr.mergedAt)) return { skip: 'not-merged', outcome: 'resolved' };
      if (isRevert(pr)) return { skip: 'is-revert', outcome: 'resolved' };
      return reverted(pr) ? { skip: 'reverted', outcome: 'resolved' } : { outcome: 'resolved' };
    }
    if (pr.state === 'open') return { skip: 'not-merged', outcome: 'rejected' };
    if (isRevert(pr)) return { skip: 'is-revert', outcome: 'rejected' };
    const motive = motiveOf(pr, replaced);
    if (!motive) return { skip: pr.state === 'superseded' ? 'no-reason' : 'not-merged', outcome: 'rejected' };
    return {
      outcome: 'rejected',
      extra: {
        reason_kind: motive.kind,
        ...(motive.at ? { reason_at: motive.at } : {}),
        ...(motive.by !== undefined ? { superseded_by: `${owner}/${repository}#${motive.by}` } : {}),
      },
    };
  };

  const consider = (kind: Kind, record: { number: number; url: string; stamp?: string; labels: string[]; raw: Json; jira?: string; closes?: string[]; after?: string }, verdict: Verdict) => {
    const number = record.number;
    const valid = Number.isInteger(number) && number > 0;
    const ref = valid ? `${owner}/${repository}#${number}` : `${owner}/${repository}#?`;
    const skip = (reason: Reason) => { result.skipped.push({ ref, kind, reason }); };
    const url = valid && ownUrl(adapter, kind, owner, repository, number, record.url) ? record.url : undefined;
    if (!url) return skip(kind === 'pr' ? verdict.skip ?? 'invalid' : 'invalid');
    if (verdict.skip) return skip(verdict.skip);
    const when = moment(record.stamp);
    if (!when) return skip('invalid');
    const time = Date.parse(when);
    if ((since !== undefined && time < since) || (until !== undefined && time >= until)) return skip('outside-period');
    // The watermark only looks at what is new: an item before it was already seen by an earlier run.
    if (record.after !== undefined && time <= Date.parse(record.after)) return skip('outside-period');
    result.watermark[kind] = later(result.watermark[kind], when);
    if (wanted.length && !record.labels.some(label => wanted.includes(label.toLowerCase()))) return skip('label-mismatch');
    if (hasSecretIn(record.raw)) return skip('secret');
    if (verdict.late) return skip('covered-by-pr');
    const keys = [ref, ...(record.jira ? [record.jira] : [])];
    if (keys.some(key => hasRef(known, key))) return skip('already-known');
    if (hasRef(pending, ref)) return skip('already-pending');
    let suggested = `${repository.toLowerCase()}-${kind}-${number}`;
    for (let n = 2; used.has(suggested); n++) suggested = `${repository.toLowerCase()}-${kind}-${number}-${n}`;
    used.add(suggested);
    result.candidates.push({
      provider, kind, outcome: verdict.outcome, ref, url, closed_at: when,
      ...(record.jira ? { jira_key: record.jira } : {}),
      ...(record.closes?.length ? { closes: record.closes } : {}),
      ...verdict.extra,
      suggested_id: suggested,
    });
  };

  for (const pr of pulls) {
    const verdict = pullVerdict(pr);
    consider('pr', {
      number: pr.number, url: pr.url, labels: pr.labels, raw: pr.raw, after: options.afterPr,
      stamp: verdict.outcome === 'rejected' ? pr.closedAt : pr.mergedAt,
      jira: jiraKeyIn.exec(pr.title)?.[0] ?? jiraKeyIn.exec(pr.branch)?.[0],
      closes: pr.closes.map(number => `${owner}/${repository}#${number}`),
    }, verdict);
  }
  for (const issue of input.issues ?? []) {
    const closing = closedBy.get(issue.number);
    // Closed as "not planned" or as a duplicate is not a solution; only COMPLETED counts. A PR that closes it wins over the issue.
    const verdict: Verdict = issue.status !== 'completed' ? { skip: 'not-completed', outcome: 'resolved' }
      : closing ? (closing.good ? { late: true, outcome: 'resolved' } : { skip: 'reverted', outcome: 'resolved' })
        : { outcome: 'resolved' };
    consider('issue', { number: issue.number, url: issue.url, stamp: issue.closedAt, labels: issue.labels, raw: issue.raw, after: options.afterIssue }, verdict);
  }
  return result;
}

/* Run state: the watermark and the pending list. They are not knowledge and never leave the machine. */

export interface Watermark { pr?: string; issue?: string }
export interface PendingItem { provider?: Provider; kind: Kind; ref: string; url: string; closed_at: string; outcome?: Outcome; jira_key?: string; added_at: string }

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

/** The watermark is kept per `owner/repository` (the GitHub key is the bare name, so the first version still reads). */
export function readWatermark(dir: string, repository: string): Watermark {
  const all = readState<{ repositories?: Record<string, Watermark> }>(dir, watermarkFile, {});
  const entry = Object.hasOwn(all.repositories ?? {}, repository) ? all.repositories![repository] : undefined;
  return { ...(moment(entry?.pr) ? { pr: entry!.pr } : {}), ...(moment(entry?.issue) ? { issue: entry!.issue } : {}) };
}

/** The watermark only moves forward: an older value never replaces a newer one. */
export function writeWatermark(dir: string, repository: string, next: Watermark): Watermark {
  if (!slugPattern.test(repository) || [next.pr, next.issue].some(value => value !== undefined && !moment(value))) throw new Error(usage);
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
    if (items.some(item => sameRef(item.ref, candidate.ref) && (item.provider ?? 'github') === candidate.provider)) continue;
    items.push({
      ...(candidate.provider !== 'github' ? { provider: candidate.provider } : {}),
      kind: candidate.kind,
      ref: candidate.ref,
      url: candidate.url,
      closed_at: candidate.closed_at,
      ...(candidate.outcome === 'rejected' ? { outcome: 'rejected' as const } : {}),
      ...(candidate.jira_key ? { jira_key: candidate.jira_key } : {}),
      added_at: now,
    });
  }
  writeState(dir, pendingFile, { version: 1, items });
  return items;
}

export function removePending(dir: string, refs: string[]): PendingItem[] {
  const items = readPending(dir).filter(item => !refs.some(ref => sameRef(ref, item.ref)));
  writeState(dir, pendingFile, { version: 1, items });
  return items;
}

/** Issue keys and ids that the knowledges already cite or use (`knowledge.ts issues`). */
export function knowledgeIndex(dirs: string[]): { known: Set<string>; ids: Set<string> } {
  if (!dirs.length) return { known: new Set(), ids: new Set() };
  const index = knownIssues(dirs);
  return { known: new Set(Object.keys(index.issues)), ids: new Set(index.ids) };
}

function readJson(input?: string): unknown {
  try { return JSON.parse(input ?? readFileSync(0, 'utf8')); } catch { throw new Error('Invalid JSON input.'); }
}

export function main(argv: string[], input?: string): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      provider: { type: 'string' }, repo: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, after: { type: 'string' },
      label: { type: 'string', multiple: true }, state: { type: 'string' }, knowledge: { type: 'string', multiple: true }, limit: { type: 'string' },
    } });
  } catch { throw new Error(usage); }
  const { positionals: [command, ...extra], values: v } = parsed;
  if (command !== 'eligible' || extra.length || !v.repo) throw new Error(usage);
  const name = v.provider ?? 'github';
  const adapter = adapterFor(name);
  const slug = slugPattern.exec(v.repo);
  if (!slug) throw new Error(usage);
  const [owner, repository] = [slug[1]!, slug[2]!];
  if (v.after !== undefined && !moment(v.after)) throw new Error(usage);
  if (v.limit !== undefined && !/^[1-9][0-9]*$/.test(v.limit)) throw new Error(usage);
  const index = knowledgeIndex(v.knowledge ?? []);
  const pending = v.state ? new Set(readPending(v.state).map(item => item.ref)) : undefined;
  const data = readJson(input);
  const lists: Json = isObject(data) ? data : {};
  const rawPulls = Array.isArray(data) ? data : [lists.pulls, lists.prs, lists.values].find((list): list is unknown[] => Array.isArray(list));
  if (!rawPulls) throw new Error(usage);
  if (lists.issues !== undefined && (!Array.isArray(lists.issues) || !adapter.issue)) throw new Error(usage);
  const rawIssues = Array.isArray(lists.issues) ? lists.issues : [];
  const pulls = rawPulls.map(raw => adapter.pull(raw, owner, repository)).filter((pr): pr is Pull => pr !== undefined);
  const issues = rawIssues.map(raw => adapter.issue?.(raw, owner, repository)).filter((issue): issue is Issue => issue !== undefined);
  const selection = selectItems({ pulls, issues }, {
    provider: adapter.provider, owner, repository, since: v.since, until: v.until, afterPr: v.after, afterIssue: v.after,
    labels: v.label, known: index.known, ids: index.ids, pending,
  });
  if (v.limit === undefined) return { output: JSON.stringify(selection), code: 0 };
  const limit = Number(v.limit);
  // A list cut by --limit may be missing older items: it is reported, as learn-github does.
  const truncated = (['pr', 'issue'] as Kind[]).filter(kind => (kind === 'pr' ? rawPulls : rawIssues).length >= limit);
  return { output: JSON.stringify({ ...selection, truncated }), code: 0 };
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

