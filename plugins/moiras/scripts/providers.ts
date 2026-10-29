/** Git providers that `moiras-learn --from-git` reads from (GitHub first, Bitbucket in the same normalized format).
 *
 * An adapter only reads: it turns one provider record (the JSON the user's `gh` or Bitbucket reader gave) into the
 * normalized `Pull` or `Issue` below. The selector in learn-git.ts decides with those records and never looks at the
 * provider's own fields. Adding a provider: one adapter here (URL shapes, state mapping, discussion, closing links), one
 * entry in `adapters`, and the normalized fields it can fill; see the section "Provedores" in AGENTS.md.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable and import siblings with the .ts extension.
 */

export const providers = ['github', 'bitbucket'] as const;
export type Provider = (typeof providers)[number];

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const child = (value: unknown, key: string): Json | undefined => (isObject(value) && isObject(value[key]) ? (value[key] as Json) : undefined);

/** Names of the labels of a record (GitHub gives objects with `name`; anything else is read as text). */
export const labelNames = (item: Json): string[] => (Array.isArray(item.labels) ? item.labels : []).map(label => (isObject(label) ? text(label.name) : text(label))).filter(Boolean);

/** A provider timestamp as UTC ISO 8601 ending in `Z` (`2026-10-10T12:00:00+00:00` becomes `2026-10-10T12:00:00Z`); undefined when it is not one. */
export const utcStamp = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return undefined;
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(time) ? undefined : new Date(time).toISOString().replace('.000Z', 'Z');
};

/** A comment or a review of a PR. Its text tells the reason of a closing and is scanned for secrets: it is never printed. */
export interface Discussion {
  kind: 'comment' | 'review';
  /** When it was written, as UTC ISO 8601 (see `utcStamp`; the selector checks it). */
  at?: string;
  /** Who wrote it: the GitHub login or the Bitbucket nickname; empty when the record does not say. */
  author: string;
  /** A bot (see `isBotLogin`): its text never gives the reason of a closing. */
  bot: boolean;
  text: string;
}

/** Logins of bots that comment without the `[bot]` suffix. */
export const knownBots = ['copilot', 'codex', 'chatgpt-codex-connector', 'github-actions'];

/** A bot by its login (a `[bot]` suffix or a known name) or by a flag the record gives (`flagged`). */
export const isBotLogin = (login: string, flagged = false): boolean => {
  const name = login.trim().toLowerCase();
  return flagged || name.endsWith('[bot]') || knownBots.includes(name);
};

/** A pull request (GitHub) or pull request (Bitbucket), in the format every provider is normalized to. */
export interface Pull {
  provider: Provider;
  number: number;
  /** The URL as the provider gives it: the selector checks that it is this owner and repository's PR. */
  url: string;
  /** `merged`: accepted. `closed`: closed without merge (declined). `superseded`: another change replaced it. `open`: still open. */
  state: 'merged' | 'closed' | 'superseded' | 'open';
  title: string;
  body: string;
  labels: string[];
  /** Name of the source branch, empty when the provider does not give it. */
  branch: string;
  /** When it was merged (merged PRs only). */
  mergedAt?: string;
  /** When it was closed, declined or superseded. */
  closedAt?: string;
  /** Issues of the same owner and repository that it closes; empty when the provider has no such link. */
  closes: number[];
  /** Comments and reviews the reader fetched (may be empty): the closing reason and the secret scan read them. */
  discussion: Discussion[];
  /** The provider's record as it came: scanned for secrets, never printed. */
  raw: Json;
}

/** An issue closed in the tracker of the provider (GitHub only for now). */
export interface Issue {
  provider: Provider;
  number: number;
  url: string;
  /** `completed` only when closed as completed (not planned and duplicates do not count). */
  status: 'completed' | 'not-completed';
  closedAt?: string;
  title: string;
  body: string;
  labels: string[];
  raw: Json;
}

export interface Adapter {
  readonly provider: Provider;
  /** The URL of pull request `number` of `owner/repository`, as the provider names it. */
  pullUrl(owner: string, repository: string, number: number): string;
  /** The URL of issue `number` of `owner/repository`; absent when the provider has no issue tracker in the reader. */
  issueUrl?(owner: string, repository: string, number: number): string;
  /** Normalizes one record of the provider's pull request list; undefined when it is not a record at all. */
  pull(raw: unknown, owner: string, repository: string): Pull | undefined;
  /** Normalizes one record of the provider's closed issue list; absent when the provider has no issues here. */
  issue?(raw: unknown, owner: string, repository: string): Issue | undefined;
}

/** Issues of the same owner and repository that a GitHub PR closes (`closingIssuesReferences`); another repository is dropped. */
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

/** Comments or reviews of a record: `when` is the key of the timestamp, `body` reads the text. */
const discussion = (list: unknown, kind: Discussion['kind'], when: string, body: (item: Json) => string, who: (item: Json) => Pick<Discussion, 'author' | 'bot'>): Discussion[] =>
  (Array.isArray(list) ? list : []).filter(isObject).map(item => {
    const at = utcStamp(item[when]);
    return { kind, ...(at ? { at } : {}), ...who(item), text: body(item) };
  });

/** Author of a GitHub comment or review: its login, and the bot flag the record gives (`is_bot`, `isBot` or type `Bot`). */
const githubWho = (item: Json): Pick<Discussion, 'author' | 'bot'> => {
  const who = child(item, 'author');
  const login = text(who?.login);
  const flagged = who?.is_bot === true || who?.isBot === true || who?.__typename === 'Bot' || who?.type === 'Bot';
  return { author: login, bot: isBotLogin(login, flagged) };
};

/** Author of a Bitbucket comment: its nickname, and a bot when the user is of type `Bot`. */
const bitbucketWho = (item: Json): Pick<Discussion, 'author' | 'bot'> => {
  const who = child(item, 'user');
  const login = text(who?.nickname) || text(who?.username);
  return { author: login, bot: isBotLogin(login, who?.type === 'Bot') };
};

const github: Adapter = {
  provider: 'github',
  pullUrl: (owner, repository, number) => `https://github.com/${owner}/${repository}/pull/${number}`,
  issueUrl: (owner, repository, number) => `https://github.com/${owner}/${repository}/issues/${number}`,
  pull(raw, owner, repository) {
    if (!isObject(raw)) return undefined;
    const state = text(raw.state).toUpperCase();
    return {
      provider: 'github',
      number: Number(raw.number),
      url: text(raw.url),
      state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
      title: text(raw.title),
      body: text(raw.body),
      labels: labelNames(raw),
      branch: text(raw.headRefName),
      ...(typeof raw.mergedAt === 'string' ? { mergedAt: raw.mergedAt } : {}),
      ...(typeof raw.closedAt === 'string' ? { closedAt: raw.closedAt } : {}),
      closes: closingNumbers(raw, owner, repository),
      discussion: [
        ...discussion(raw.comments, 'comment', 'createdAt', item => text(item.body), githubWho),
        ...discussion(raw.reviews, 'review', 'submittedAt', item => text(item.body), githubWho),
      ],
      raw,
    };
  },
  issue(raw) {
    if (!isObject(raw)) return undefined;
    const closed = text(raw.state).toUpperCase() === 'CLOSED' && text(raw.stateReason).toUpperCase() === 'COMPLETED';
    return {
      provider: 'github',
      number: Number(raw.number),
      url: text(raw.url),
      status: closed ? 'completed' : 'not-completed',
      ...(typeof raw.closedAt === 'string' ? { closedAt: raw.closedAt } : {}),
      title: text(raw.title),
      body: text(raw.body),
      labels: labelNames(raw),
      raw,
    };
  },
};

/**
 * Bitbucket Cloud pull requests (`GET /2.0/repositories/<workspace>/<repo>/pullrequests`, state MERGED, DECLINED and SUPERSEDED).
 * Mapping: MERGED -> merged, DECLINED -> closed, SUPERSEDED -> superseded, OPEN -> open. The PR object carries no closing date:
 * `updated_on` is used for it, which is the last change, not the moment of the closing (the selector then checks the period
 * against it). Comments come from `comments`, as the reader fetched them (`content.raw`, `created_on`). Bitbucket has no
 * labels and no link to issues in the PR, so `closes` is empty. Not verified against a live account: see AGENTS.md.
 */
const bitbucket: Adapter = {
  provider: 'bitbucket',
  pullUrl: (workspace, repository, number) => `https://bitbucket.org/${workspace}/${repository}/pull-requests/${number}`,
  pull(raw, workspace, repository) {
    if (!isObject(raw)) return undefined;
    const state = text(raw.state).toUpperCase();
    const updated = utcStamp(raw.updated_on);
    const mapped = state === 'MERGED' ? 'merged' : state === 'DECLINED' ? 'closed' : state === 'SUPERSEDED' ? 'superseded' : 'open';
    return {
      provider: 'bitbucket',
      number: Number(raw.id),
      url: text(child(child(raw, 'links'), 'html')?.href),
      state: mapped,
      title: text(raw.title),
      body: text(raw.description),
      labels: [],
      branch: text(child(child(raw, 'source'), 'branch')?.name),
      ...(mapped === 'merged' && updated ? { mergedAt: updated } : {}),
      ...(mapped !== 'merged' && mapped !== 'open' && updated ? { closedAt: updated } : {}),
      closes: [],
      discussion: discussion(raw.comments, 'comment', 'created_on', item => text(child(item, 'content')?.raw), bitbucketWho),
      raw,
    };
  },
};

export const adapters: Record<Provider, Adapter> = { github, bitbucket };

/** The adapter of a provider name; anything else is refused (the names come from the command line). */
export function adapterFor(name: string): Adapter {
  if (!(providers as readonly string[]).includes(name)) throw new Error(`Unknown provider: ${providers.join(', ')}.`);
  return adapters[name as Provider];
}
