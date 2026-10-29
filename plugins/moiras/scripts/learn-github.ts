/** Selection for `moiras-learn --from-github` and for the automatic run inside `moiras-sync`.
 * Usage: node learn-github.ts eligible --repo <owner/name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... < gh.json
 *        node learn-github.ts auto --repo <owner/name> --state <dir> --limit <n> [--since <date>] [--label <name>]... [--knowledge <dir>]... < gh.json
 *        node learn-github.ts revalidate --repo <owner/name> --state <dir> [--knowledge <dir>]... < gh.json
 *        node learn-github.ts scan < context.txt   (exit 1 when it carries a secret)
 *        node learn-github.ts watermark get --state <dir> --repo <owner/name> | set --state <dir> --repo <owner/name> [--pr <ts>] [--issue <ts>]
 *        node learn-github.ts pending list --state <dir> | remove --state <dir> --ref <name#n>...
 *
 * Reads the JSON of `gh pr list` and `gh issue list` from stdin ({ prs, issues }) and decides which items may become learnings.
 * The GitHub records are normalized by providers.ts and decided by learn-git.ts (the generic selector, shared with `--from-git`);
 * this file keeps the GitHub entry points, the automatic run and the revalidation. It never calls GitHub and never writes to a
 * knowledge: the only files it writes are the watermark and the pending list under `--state` (run state, outside any knowledge).
 * It prints references, reasons and timestamps, never the text of a PR or an issue.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable and import siblings with the .ts extension.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addPending, hasSecretIn, knowledgeIndex, pendingKeys, readPending, readWatermark, removePending, revertedBy, selectItems, writeWatermark, type Input, type Kind, type Options as GitOptions, type Reason, type Selection, type Skipped } from './learn-git.ts';
import { adapters, isObject, type Issue, type Pull } from './providers.ts';

export { addPending, readPending, readWatermark, removePending, writeWatermark } from './learn-git.ts';
export type { Candidate, Kind, Reason, Selection, Skipped } from './learn-git.ts';

export const usage = 'Usage: node learn-github.ts eligible --repo <owner/name> [--since <date>] [--until <date>] [--after <ts>] [--label <name>]... [--state <dir>] [--knowledge <dir>]... | auto --repo <owner/name> --state <dir> --limit <n> [--since <date>] [--label <name>]... [--knowledge <dir>]... | revalidate --repo <owner/name> --state <dir> [--knowledge <dir>]... | scan | watermark get|set --state <dir> --repo <owner/name> [--pr <ts>] [--issue <ts>] | pending list|remove --state <dir> [--ref <owner/name#n>]...';

/**
 * DECISION POINT (issue #68): what the automatic run does with what it finds. Today it only builds a pending list
 * that the user approves later (moiras-learn writes only after the "sim" to the exact list, see AGENTS.md). Writing
 * learnings straight from the automatic run would be a different value here, a matching branch in `auto`, and an
 * exception in AGENTS.md and in the moiras-learn skill. Nothing else depends on this choice.
 */
export const autoDisposition = 'pending' as const;

export type Options = Omit<GitOptions, 'provider'>;

const maxItems = 5000;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const validTimestamp = (value: string): boolean => timestamp.test(value) && !Number.isNaN(Date.parse(value));

/** The `{ prs, issues }` of `gh`, normalized as GitHub records. */
function githubInput(input: unknown, owner: string, repository: string): Input {
  if (!isObject(input)) throw new Error('Expected { prs, issues }.');
  const prs = input.prs === undefined ? [] : input.prs;
  const issues = input.issues === undefined ? [] : input.issues;
  if (!Array.isArray(prs) || !Array.isArray(issues) || prs.length + issues.length > maxItems) throw new Error('Expected { prs, issues }.');
  const adapter = adapters.github;
  return {
    pulls: prs.map(raw => adapter.pull(raw, owner, repository)).filter((pr): pr is Pull => pr !== undefined),
    issues: issues.map(raw => adapter.issue!(raw, owner, repository)).filter((issue): issue is Issue => issue !== undefined),
  };
}

/**
 * Decides, for each merged PR and each closed issue, whether it may become a learning. Only merged PRs that were not
 * reverted and issues closed as completed pass; the period, label, watermark, knowledge and pending list narrow the rest.
 * Nothing in the result is text from the PR or the issue.
 */
export function select(input: unknown, options: Options): Selection {
  return selectItems(githubInput(input, options.owner, options.repository), { ...options, provider: 'github' });
}

const staleReasons: ReadonlySet<Reason> = new Set(['not-merged', 'no-reason', 'reverted', 'is-revert', 'not-completed', 'covered-by-pr', 'already-known', 'secret', 'invalid']);

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
  const { numbers: revertedNumbers } = revertedBy(githubInput(input, owner, repository).pulls);
  const reasons = new Map(selection.skipped.map(item => [item.ref, item.reason]));
  const eligible = new Set(selection.candidates.map(candidate => candidate.ref));
  const result: Revalidation = { valid: [], removed: [], unverified: [] };
  for (const item of readPending(options.state)) {
    // The GitHub read says nothing about another provider's items (their refs look the same): they are left alone.
    if ((item.provider ?? 'github') !== 'github') continue;
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
  const selection = select(input, { ...options, afterPr: mark.pr, afterIssue: mark.issue, pending: pendingKeys(options.state) });
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
    if (v.after !== undefined && !validTimestamp(v.after)) throw new Error(usage);
    if (command === 'auto') {
      if (!v.state) throw new Error(usage);
      if (!v.limit || !/^[1-9][0-9]*$/.test(v.limit)) throw new Error(usage);
      const [owner, repository] = splitRepo(v.repo);
      return out(auto(readJson(input), { owner, repository, since: v.since, labels: v.label, known: index.known, ids: index.ids, state: v.state, limit: Number(v.limit) }));
    }
    const pending = v.state ? pendingKeys(v.state) : undefined;
    if (v.limit !== undefined && !/^[1-9][0-9]*$/.test(v.limit)) throw new Error(usage);
    const data = readJson(input);
    const [owner, repository] = splitRepo(v.repo);
    const selection = select(data, { owner, repository, since: v.since, until: v.until, afterPr: v.after, afterIssue: v.after, labels: v.label, known: index.known, ids: index.ids, pending });
    const lists = isObject(data) ? data : {};
    return out(v.limit === undefined ? selection : { ...selection, truncated: (['pr', 'issue'] as Kind[]).filter(kind => truncated(kind === 'pr' ? lists.prs : lists.issues, Number(v.limit))) });
  }
  if (command === 'revalidate' && v.repo && v.state) {
    const index = knowledgeIndex(v.knowledge ?? []);
    const [owner, repository] = splitRepo(v.repo);
    return out(revalidate(readJson(input), { owner, repository, state: v.state, known: index.known, ids: index.ids }));
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

const slug = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_][A-Za-z0-9._-]*)$/;
function splitRepo(value: string): [string, string] {
  const match = slug.exec(value);
  if (!match) throw new Error(usage);
  return [match[1]!, match[2]!];
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
