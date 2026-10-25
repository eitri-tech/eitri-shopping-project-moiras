/** Helpers locais para filtrar repositórios GitHub e planejar clones.
 * Usage: node github.ts match --pattern <owner/glob> [--include-archived] < repos.json
 *        node github.ts plan-clone --dir <dir> [--base <dir>] < matches.json
 *        node github.ts local --dir <dir> --pattern <owner/glob> [--base <dir>]
 *        node github.ts clone --dir <dir> [--base <dir>] --repo <name> --owner <owner> --url <https-url> [--depth <n>]
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { validPattern } from './knowledge.ts';

export const usage = 'Usage: node github.ts match --pattern <owner/glob> [--include-archived] | plan-clone --dir <dir> [--base <dir>] | local --dir <dir> --pattern <owner/glob> [--base <dir>] | clone --dir <dir> [--base <dir>] --repo <name> --owner <owner> --url <https-url> [--depth <n>]';
// Same file-name rules as knowledge.ts.
const safeName = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
type Repository = { name: string; url: string; archived: boolean };
type Matches = { owner: string; repositories: Repository[]; truncated: boolean; other_owner: number };

export { validPattern };

/** Upper bound for one `git clone` (ms). */
export const cloneTimeout = 600_000;

const ownerName = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function patternParts(pattern: string): string[] {
  if (!validPattern(pattern)) throw new Error(usage);
  return pattern.split('/');
}

/** Default number the skill passes to `gh repo list --limit`; a list this long may have been cut. `match --limit` compares against the number actually used. */
export const listLimit = 4000;

/** Glob (`*` any run, `?` one character, case-insensitive) in O(pattern x name) time; no RegExp, so a pattern full of `*` cannot backtrack exponentially. */
export function globMatch(glob: string, name: string): boolean {
  const pattern = glob.toLowerCase(), text = name.toLowerCase();
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) { p++; t++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function cleanUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !value.includes('@');
  } catch { return false; }
}

export function matchRepositories(pattern: string, input: unknown, includeArchived = false, limit = listLimit): Matches {
  const [owner, glob] = patternParts(pattern);
  if (!Array.isArray(input)) throw new Error('Expected a repository list.');
  const repositories: Repository[] = [];
  let otherOwner = 0;
  for (const item of input) {
    if (!item || typeof item.name !== 'string' || !safeName.test(item.name) || !globMatch(glob, item.name) || !cleanUrl(item.url) || typeof item.isArchived !== 'boolean') continue;
    if (item.isArchived && !includeArchived) continue;
    if (canonicalRemote(item.url) !== `https://github.com/${owner}/${item.name}`.toLowerCase()) { otherOwner++; continue; } // the url must be this owner's repository (a transferred repo shows up here)
    repositories.push({ name: item.name, url: item.url, archived: item.isArchived });
  }
  repositories.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { owner, repositories, truncated: input.length >= limit, other_owner: otherOwner };
}

// Trust ancestors above the clone folder (platform symlinks such as /tmp); refuse a link on the folder or on the repository itself.
function hasSymlink(path: string): boolean {
  const target = resolve(path);
  return [target, dirname(target)].some(current => lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink());
}

/** `https://github.com/Owner/Repo` for any GitHub remote spelling (https, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`), lower case, no credentials; undefined for anything else. */
export function canonicalRemote(value: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_][A-Za-z0-9._-]*?)(?:\.git)?\/?$/i.exec(value.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

/** Every `remote.origin.url` of the checkout, canonicalized: `unreadable` when Git cannot read them (or takes too long), `undefined` entries for values that are not GitHub remotes. Only the checkout's own `.git/config` counts (not global or system config, nor `GIT_CONFIG_*` variables), includes are not followed and discovery stops at the clone folder. */
function originsOf(path: string, run: typeof spawnSync): (string | undefined)[] | 'unreadable' {
  const result = run('git', ['-C', path, 'config', '--local', '--no-includes', '--get-all', 'remote.origin.url'], { env: { ...cloneEnv(), GIT_CEILING_DIRECTORIES: dirname(path) }, encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return 'unreadable';
  const values = result.stdout.split('\n').filter(Boolean);
  return values.length ? values.map(canonicalRemote) : 'unreadable';
}

type Planned = { name: string; path: string; action: 'exists' | 'conflict' | 'clone'; reason?: string };

/** `exists` only for a real Git checkout whose every `origin` URL is the expected repository; another owner, a missing expected URL or an unreadable origin is a `conflict`. */
function classify(path: string, name: string, expected: string | undefined, run: typeof spawnSync): Planned {
  if (hasSymlink(path)) return { name, path, action: 'conflict', reason: 'symlink' };
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return { name, path, action: 'clone' };
  const git = entry.isDirectory() ? lstatSync(join(path, '.git'), { throwIfNoEntry: false }) : undefined;
  if (!git || !git.isDirectory()) return { name, path, action: 'conflict', reason: 'not-a-checkout' };
  if (expected === undefined) return { name, path, action: 'conflict', reason: 'origin-unknown' };
  const origins = originsOf(path, run);
  if (origins === 'unreadable') return { name, path, action: 'conflict', reason: 'origin-unreadable' };
  if (origins.some(origin => origin !== expected)) return { name, path, action: 'conflict', reason: 'origin-mismatch' };
  return { name, path, action: 'exists' };
}

export function planClone(dir: string, input: unknown, run: typeof spawnSync = spawnSync) {
  if (!input || typeof input !== 'object' || !('repositories' in input) || !Array.isArray(input.repositories)) throw new Error('Expected matches.');
  // The owner comes from `match`, never from an entry's url; without it nothing can be confirmed.
  if (!('owner' in input) || typeof input.owner !== 'string' || !ownerName.test(input.owner)) throw new Error('Matches need an owner.');
  const owner = input.owner;
  return { repositories: input.repositories.map((repo: Repository) => {
    if (!repo || typeof repo.name !== 'string' || !safeName.test(repo.name)) throw new Error('Invalid repository name.');
    return classify(join(resolve(dir), repo.name), repo.name, canonicalRemote(`https://github.com/${owner}/${repo.name}`), run);
  }) };
}

/** Clones already in `dir` whose name matches the glob, independent of what `gh` listed (it can fail or be cut). Same checks as `plan-clone`, with the origin expected under the pattern's owner. */
export function localRepositories(dir: string, pattern: string, run: typeof spawnSync = spawnSync) {
  const [owner, glob] = patternParts(pattern);
  const base = resolve(dir);
  if (lstatSync(base, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Clone folder refused.');
  const names = lstatSync(base, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(base).filter(name => safeName.test(name) && globMatch(glob, name)).sort() : [];
  return { owner, repositories: names.map(name => classify(join(base, name), name, canonicalRemote(`https://github.com/${owner}/${name}`), run)).filter(entry => entry.action !== 'clone') };
}

// Variables that move the Git directory, work tree or index away from the clone target.
const locationVariables = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];

function cloneEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (locationVariables.includes(name.toUpperCase())) delete env[name];
  return env;
}

export function cloneRepository(dir: string, name: string, url: string, owner: string, depth?: string, run: typeof spawnSync = spawnSync) {
  if (!safeName.test(name) || !ownerName.test(owner) || !cleanUrl(url) || (depth !== undefined && (!/^[1-9][0-9]*$/.test(depth) || !Number.isSafeInteger(Number(depth))))) throw new Error(usage);
  // Only this owner's repository on github.com, spelled as `https://github.com/<owner>/<name>[.git]`.
  const suffix = url.slice(url.lastIndexOf('/') + 1);
  if (!url.startsWith('https://github.com/') || canonicalRemote(url) !== `https://github.com/${owner}/${name}`.toLowerCase() || ![name, `${name}.git`].includes(suffix)) throw new Error(usage);
  const path = join(resolve(dir), name);
  if (hasSymlink(path) || lstatSync(path, { throwIfNoEntry: false })) throw new Error('Clone target refused.');
  // https only (a user `insteadOf` cannot swap in ssh, file or ext), no hooks, no fsmonitor, no submodules, bounded time.
  const args = ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    'clone', '--template=', '--no-recurse-submodules', ...(depth ? ['--depth', depth] : []), '--', url, path];
  const result = run('git', args, { env: { ...cloneEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https' }, stdio: 'pipe', timeout: cloneTimeout });
  if (result.status === 0) return { output: JSON.stringify({ cloned: true, path }), code: 0 };
  // A killed clone can leave a partial folder; the plugin never deletes it, so the user must remove it before trying again.
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errorCode === 'ETIMEDOUT';
  // Only the system error code and the signal name say why Git did not run or was killed (no message, so no URL or path can leak).
  const reason = {
    ...(typeof errorCode === 'string' && !timedOut && /^[A-Z][A-Z0-9_]*$/.test(errorCode) ? { error_code: errorCode } : {}),
    ...(typeof result.signal === 'string' && /^SIG[A-Z0-9]+$/.test(result.signal) ? { signal: result.signal } : {}),
  };
  return { output: JSON.stringify({ cloned: false, status: result.status, ...reason, ...(timedOut ? { timed_out: true, partial_path: path } : {}) }), code: 1 };
}

function readJson(input?: string): unknown {
  try { return JSON.parse(input ?? readFileSync(0, 'utf8')); } catch { throw new Error('Invalid JSON input.'); }
}

// A file-system failure (not a directory, no permission) on the clone folder; the message stays fixed because the path is the user's.
function folderRead<T>(read: () => T): T {
  try { return read(); } catch (error) {
    if (typeof (error as NodeJS.ErrnoException)?.code === 'string') throw new Error('Clone folder unreadable.');
    throw error;
  }
}

export function main(argv: string[], input?: string): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { pattern: { type: 'string' }, 'include-archived': { type: 'boolean' }, limit: { type: 'string' }, dir: { type: 'string' }, repo: { type: 'string' }, owner: { type: 'string' }, base: { type: 'string' }, url: { type: 'string' }, depth: { type: 'string' } } });
  } catch { throw new Error(usage); }
  const { positionals, values: v } = parsed;
  const command = positionals[0];
  const dir = v.dir === undefined ? undefined : resolve(v.base ?? '.', v.dir); // `--base` is the folder of the `.moiras/`: relative paths in the configuration start there
  const allowed = command === 'match' ? ['pattern', 'include-archived', 'limit'] : command === 'plan-clone' ? ['dir', 'base'] : command === 'local' ? ['dir', 'pattern', 'base'] : command === 'clone' ? ['dir', 'base', 'repo', 'owner', 'url', 'depth'] : [];
  if (positionals.length !== 1 || Object.keys(v).some(key => !allowed.includes(key))) throw new Error(usage);
  if (command === 'clone' && v.dir && v.repo && v.owner && v.url) return cloneRepository(dir!, v.repo, v.url, v.owner, v.depth);
  if (command === 'match' && v.pattern) {
    patternParts(v.pattern);
    if (v.limit !== undefined && (!/^[1-9][0-9]*$/.test(v.limit) || !Number.isSafeInteger(Number(v.limit)))) throw new Error(usage);
    return { output: JSON.stringify(matchRepositories(v.pattern, readJson(input), v['include-archived'], v.limit === undefined ? listLimit : Number(v.limit))), code: 0 };
  }
  if (command === 'local' && v.dir && v.pattern) return { output: JSON.stringify(folderRead(() => localRepositories(dir!, v.pattern))), code: 0 };
  if (command === 'plan-clone' && v.dir) return { output: JSON.stringify(folderRead(() => planClone(dir!, readJson(input)))), code: 0 };
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${result.output}\n`);
    process.exitCode = result.code;
  } catch (error) {
    // Every message thrown here is a fixed string: none carries a URL or a value from the input.
    process.stderr.write(`${error instanceof Error && error.message !== usage && /^[A-Z][A-Za-z ]+\.$/.test(error.message) ? error.message : usage}\n`);
    process.exitCode = 2;
  }
}
