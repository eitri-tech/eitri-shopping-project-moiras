/** Helpers locais para filtrar repositórios GitHub e planejar clones.
 * Usage: node github.ts match --pattern <owner/glob> [--include-archived] < repos.json
 *        node github.ts plan-clone --dir <dir> < matches.json
 *        node github.ts local --dir <dir> --pattern <owner/glob>
 *        node github.ts clone --dir <dir> --repo <name> --url <https-url> [--depth <n>]
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const usage = 'Usage: node github.ts match --pattern <owner/glob> [--include-archived] | plan-clone --dir <dir> | local --dir <dir> --pattern <owner/glob> | clone --dir <dir> --repo <name> --url <https-url> [--depth <n>]';
// Same file-name rules as knowledge.ts.
const safeName = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
type Repository = { name: string; url: string; archived: boolean };
type Matches = { owner: string; repositories: Repository[]; truncated: boolean };

function patternParts(pattern: string): string[] {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._*?-]+$/.test(pattern) || pattern.includes('..') || pattern.split('/')[1] === '*') throw new Error(usage);
  return pattern.split('/');
}

/** Number the skill passes to `gh repo list --limit`; a list this long may have been cut. */
export const listLimit = 4000;

/** Linear-time glob (`*` any run, `?` one character, case-insensitive); no RegExp, so a pattern full of `*` cannot backtrack. */
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

export function matchRepositories(pattern: string, input: unknown, includeArchived = false): Matches {
  const [owner, glob] = patternParts(pattern);
  if (!Array.isArray(input)) throw new Error('Expected a repository list.');
  const repositories: Repository[] = [];
  for (const item of input) {
    if (!item || typeof item.name !== 'string' || !safeName.test(item.name) || !globMatch(glob, item.name) || !cleanUrl(item.url) || typeof item.isArchived !== 'boolean') continue;
    if (item.isArchived && !includeArchived) continue;
    repositories.push({ name: item.name, url: item.url, archived: item.isArchived });
  }
  repositories.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { owner, repositories, truncated: input.length >= listLimit };
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

function originOf(path: string, run: typeof spawnSync): string | undefined {
  const result = run('git', ['-C', path, 'config', '--get', 'remote.origin.url'], { env: cloneEnv(), encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0 && typeof result.stdout === 'string' ? canonicalRemote(result.stdout) : undefined;
}

type Planned = { name: string; path: string; action: 'exists' | 'conflict' | 'clone'; reason?: string };

/** `exists` only for a real Git checkout whose `origin` is the expected repository; a same-named checkout of another owner is a `conflict`. */
function classify(path: string, name: string, expected: string | undefined, run: typeof spawnSync): Planned {
  if (hasSymlink(path)) return { name, path, action: 'conflict', reason: 'symlink' };
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return { name, path, action: 'clone' };
  const git = entry.isDirectory() ? lstatSync(join(path, '.git'), { throwIfNoEntry: false }) : undefined;
  if (!git || git.isSymbolicLink() || !(git.isDirectory() || git.isFile())) return { name, path, action: 'conflict', reason: 'not-a-checkout' };
  if (expected !== undefined && originOf(path, run) !== expected) return { name, path, action: 'conflict', reason: 'origin-mismatch' };
  return { name, path, action: 'exists' };
}

export function planClone(dir: string, input: unknown, run: typeof spawnSync = spawnSync) {
  if (!input || typeof input !== 'object' || !('repositories' in input) || !Array.isArray(input.repositories)) throw new Error('Expected matches.');
  return { repositories: input.repositories.map((repo: Repository) => {
    if (!repo || typeof repo.name !== 'string' || !safeName.test(repo.name)) throw new Error('Invalid repository name.');
    return classify(join(resolve(dir), repo.name), repo.name, canonicalRemote(String(repo.url ?? '')), run);
  }) };
}

/** Clones already in `dir` whose name matches the glob, independent of what `gh` listed (it can fail or be cut). Same checks as `plan-clone`, with the origin expected under the pattern's owner. */
export function localRepositories(dir: string, pattern: string, run: typeof spawnSync = spawnSync) {
  const [owner, glob] = patternParts(pattern);
  const base = resolve(dir);
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

export function cloneRepository(dir: string, name: string, url: string, depth?: string, run: typeof spawnSync = spawnSync) {
  if (!safeName.test(name) || !cleanUrl(url) || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(url.replace(/\.git$/, '')) || (depth !== undefined && (!/^[1-9][0-9]*$/.test(depth) || !Number.isSafeInteger(Number(depth))))) throw new Error(usage);
  const remoteName = url.slice(url.lastIndexOf('/') + 1);
  if (remoteName !== name && remoteName !== `${name}.git`) throw new Error(usage);
  const path = join(resolve(dir), name);
  if (hasSymlink(path) || lstatSync(path, { throwIfNoEntry: false })) throw new Error('Clone target refused.');
  const result = run('git', ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, 'clone', '--template=', ...(depth ? ['--depth', depth] : []), '--', url, path], { env: { ...cloneEnv(), GIT_TERMINAL_PROMPT: '0' }, stdio: 'pipe' });
  return result.status === 0 ? { output: JSON.stringify({ cloned: true, path }), code: 0 } : { output: JSON.stringify({ cloned: false, status: result.status }), code: 1 };
}

export function main(argv: string[], input?: string): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { pattern: { type: 'string' }, 'include-archived': { type: 'boolean' }, dir: { type: 'string' }, repo: { type: 'string' }, url: { type: 'string' }, depth: { type: 'string' } } });
  } catch { throw new Error(usage); }
  const { positionals, values: v } = parsed;
  const command = positionals[0];
  const allowed = command === 'match' ? ['pattern', 'include-archived'] : command === 'plan-clone' ? ['dir'] : command === 'local' ? ['dir', 'pattern'] : command === 'clone' ? ['dir', 'repo', 'url', 'depth'] : [];
  if (positionals.length !== 1 || Object.keys(v).some(key => !allowed.includes(key))) throw new Error(usage);
  if (command === 'clone' && v.dir && v.repo && v.url) return cloneRepository(v.dir, v.repo, v.url, v.depth);
  if (command === 'match' && v.pattern) {
    patternParts(v.pattern);
    return { output: JSON.stringify(matchRepositories(v.pattern, JSON.parse(input ?? readFileSync(0, 'utf8')), v['include-archived'])), code: 0 };
  }
  if (command === 'local' && v.dir && v.pattern) return { output: JSON.stringify(localRepositories(v.dir, v.pattern)), code: 0 };
  if (command === 'plan-clone' && v.dir) return { output: JSON.stringify(planClone(v.dir, JSON.parse(input ?? readFileSync(0, 'utf8')))), code: 0 };
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
