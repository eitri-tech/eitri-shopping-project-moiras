import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRemote, cloneRepository, cloneTimeout, globMatch, listLimit, localRepositories, main, matchRepositories, planClone, validPattern } from './github.ts';
import { spawnSync as realSpawn } from 'node:child_process';
import type { spawnSync } from 'node:child_process';

const git = (args: string[]) => {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const result = realSpawn('git', args, { env, stdio: 'pipe' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed`);
};
const checkout = (dir: string, name: string, origins: string[] = []) => {
  mkdirSync(join(dir, name), { recursive: true });
  git(['init', '-q', join(dir, name)]);
  origins.forEach((origin, index) => git(['-C', join(dir, name), 'config', index ? '--add' : '--replace-all', 'remote.origin.url', origin]));
};

const repo = (name: string, isArchived = false, url = `https://github.com/acme/${name}`) => ({ name, url, isArchived, description: 'Acme' });

it('matches a single segment case-insensitively, sorts, and filters unsafe entries', () => {
  const result = matchRepositories('acme/acme-shop-*', [repo('acme-shop-z'), repo('acme-shop-a'), repo('ACME-shop-b'), repo('acme-shop-old', true), repo('../acme-shop-x'), repo('acme-shop-secret', false, 'https://user:pass@github.com/acme/acme-shop-secret'), repo('acme-shop-x/y')]);
  assert.deepEqual(result, { owner: 'acme', repositories: [repo('ACME-shop-b'), repo('acme-shop-a'), repo('acme-shop-z')].map(r => ({ name: r.name, url: r.url, archived: false })), truncated: false, other_owner: 0 });
  assert.equal(matchRepositories('acme/acme-shop-*', [repo('acme-shop-old', true)], true).repositories.length, 1);
});

it('escapes dots and supports question marks and truncation', () => {
  assert.deepEqual(matchRepositories('acme/shop.?', [repo('shop.a'), repo('shopXa'), repo('shop.ab')]).repositories.map(r => r.name), ['shop.a']);
  assert.equal(matchRepositories('acme/shop*', Array.from({ length: listLimit }, () => repo('other'))).truncated, true);
  assert.equal(matchRepositories('acme/shop*', Array.from({ length: 999 }, () => repo('other'))).truncated, false);
});

it('rejects invalid arguments and malformed inputs', () => {
  for (const pattern of ['*', 'acme', 'acme/*', 'acme/**', 'acme/*?', 'acme/?*', 'ac*/shop', 'acme/../shop', 'acme/a[b]']) assert.throws(() => matchRepositories(pattern, []), /Usage:/);
  assert.throws(() => matchRepositories('acme/shop*', {}));
  for (const argv of [[], ['match'], ['clone'], ['plan-clone'], ['match', '--pattern', 'acme/shop*', '--dir', 'repos'], ['clone', '--unknown']]) assert.throws(() => main(argv, '[]'), /Usage:/);
  assert.equal(JSON.parse(main(['match', '--pattern', 'acme/shop*'], '[]').output).owner, 'acme');
});

it('plans existing repositories, conflicts, free targets, and symlink ancestors using lstat', t => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  checkout(dir, 'shop-repo', ['git@github.com:Acme/shop-repo.git']);
  checkout(dir, 'shop-other', ['https://github.com/other/shop-other']);
  checkout(dir, 'shop-multi', ['https://github.com/other/shop-multi', 'https://github.com/acme/shop-multi']);
  checkout(dir, 'shop-bare');
  mkdirSync(join(dir, 'shop-folder'));
  writeFileSync(join(dir, 'shop-file'), 'x');
  symlinkSync(join(dir, 'missing'), join(dir, 'shop-link'));
  const input = matchRepositories('acme/shop-*', ['shop-repo', 'shop-other', 'shop-multi', 'shop-bare', 'shop-folder', 'shop-file', 'shop-link', 'shop-free'].map(name => repo(name)));
  const plan = planClone(dir, input).repositories;
  assert.deepEqual(plan.map(r => [r.name, r.action, r.reason]), [
    ['shop-bare', 'conflict', 'origin-unreadable'], ['shop-file', 'conflict', 'not-a-checkout'], ['shop-folder', 'conflict', 'not-a-checkout'],
    ['shop-free', 'clone', undefined], ['shop-link', 'conflict', 'symlink'], ['shop-multi', 'conflict', 'origin-mismatch'],
    ['shop-other', 'conflict', 'origin-mismatch'], ['shop-repo', 'exists', undefined]]);
  // Without the owner that `match` reports, nothing can be confirmed: refuse instead of degrading.
  for (const input of [{ repositories: [{ name: 'shop-repo' }] }, { owner: '-acme', repositories: [{ name: 'shop-repo' }] }, { owner: 7, repositories: [] }]) assert.throws(() => planClone(dir, input), /owner/);
  // The owner comes from `match`, not from an entry's url: a forged url for another owner changes nothing.
  assert.deepEqual(planClone(dir, { owner: 'acme', repositories: [{ name: 'shop-other', url: 'https://github.com/other/shop-other' }] }).repositories.map(r => r.reason), ['origin-mismatch']);
  // A `.git` file (worktree or submodule pointer) is not a plain clone.
  mkdirSync(join(dir, 'shop-gitfile'));
  writeFileSync(join(dir, 'shop-gitfile', '.git'), 'gitdir: /elsewhere\n');
  assert.equal(planClone(dir, { owner: 'acme', repositories: [{ name: 'shop-gitfile' }] }).repositories[0].reason, 'not-a-checkout');
  // An empty `.git` folder must not make Git discover the enclosing repository.
  checkout(dir, 'outer', ['https://github.com/acme/shop-y']);
  mkdirSync(join(dir, 'outer', 'shop-y', '.git'), { recursive: true });
  assert.equal(planClone(join(dir, 'outer'), { owner: 'acme', repositories: [{ name: 'shop-y' }] }).repositories[0].reason, 'origin-unreadable');
  symlinkSync(dir, join(dir, 'parent'));
  assert.equal(planClone(join(dir, 'parent'), { owner: 'acme', repositories: [{ name: 'shop-free' }] }).repositories[0].action, 'conflict');
  assert.throws(() => cloneRepository(dir, 'shop-link', 'https://github.com/acme/shop-link', 'acme'));
  assert.throws(() => cloneRepository(join(dir, 'parent'), 'shop-free', 'https://github.com/acme/shop-free', 'acme'));
  assert.throws(() => cloneRepository(dir, 'shop-folder', 'https://github.com/acme/shop-folder', 'acme'));
});

it('runs clone with an argument array and suppresses git failure details', t => {
  process.env.GIT_WORK_TREE = '/elsewhere';
  process.env.GIT_DIR = '/elsewhere/.git';
  t.after(() => { delete process.env.GIT_WORK_TREE; delete process.env.GIT_DIR; });
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = ((command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '--template=', '--no-recurse-submodules', '--depth', '2', '--', 'https://github.com/acme/acme-shop-checkout.git', args.at(-1)]);
    assert.ok(args.at(-1)!.startsWith(join(dir, '.acme-shop-checkout-')), 'clones into a staging folder next to the target');
    assert.equal(options?.env?.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options?.env?.GIT_ALLOW_PROTOCOL, 'https');
    assert.equal(options?.timeout, cloneTimeout);
    assert.equal(options?.env?.GIT_WORK_TREE, undefined);
    assert.equal(options?.env?.GIT_DIR, undefined);
    return { status: 0 };
  }) as typeof spawnSync;
  assert.deepEqual(JSON.parse(cloneRepository(dir, 'acme-shop-checkout', 'https://github.com/acme/acme-shop-checkout.git', 'ACME', '2', run).output), { cloned: true, path: join(dir, 'acme-shop-checkout') });
  const failed = (() => ({ status: 128, stderr: 'sensitive details' })) as unknown as typeof spawnSync;
  assert.deepEqual(cloneRepository(dir, 'shop', 'https://github.com/acme/shop', 'acme', undefined, failed), { output: '{"cloned":false,"status":128}', code: 1 });
});

it('reports the cause of failures with fixed messages and no details from the input', t => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => main(['match', '--pattern', 'acme/a*'], '{bad'), /^Error: Invalid JSON input\.$/);
  assert.throws(() => main(['plan-clone', '--dir', dir], '{bad'), /^Error: Invalid JSON input\.$/);
  const file = join(dir, 'plain-file');
  writeFileSync(file, '');
  assert.throws(() => main(['plan-clone', '--dir', file], JSON.stringify({ owner: 'acme', repositories: [{ name: 'shop', url: 'https://github.com/acme/shop', archived: false }] })), /^Error: Clone folder unreadable\.$/);
  const noGit = (() => ({ status: null, error: Object.assign(new Error('spawnSync git ENOENT /secret/path'), { code: 'ENOENT' }) })) as unknown as typeof spawnSync;
  assert.deepEqual(cloneRepository(dir, 'shop', 'https://github.com/acme/shop', 'acme', undefined, noGit), { output: '{"cloned":false,"status":null,"error_code":"ENOENT"}', code: 1 });
  const killed = (() => ({ status: null, signal: 'SIGKILL' })) as unknown as typeof spawnSync;
  assert.deepEqual(cloneRepository(dir, 'shop', 'https://github.com/acme/shop', 'acme', undefined, killed), { output: '{"cloned":false,"status":null,"signal":"SIGKILL"}', code: 1 });
});

it('clones into a staging folder and renames it, refusing a target or folder swapped for a link meanwhile', t => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const elsewhere = mkdtempSync(join(tmpdir(), 'moiras-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const ok = ((_command, args) => { writeFileSync(join(args.at(-1) as string, 'README'), 'x'); return { status: 0 }; }) as typeof spawnSync;
  assert.equal(JSON.parse(cloneRepository(dir, 'shop', 'https://github.com/acme/shop', 'acme', undefined, ok).output).cloned, true);
  assert.deepEqual(readdirSync(dir), ['shop'], 'no staging folder is left behind');
  // The target appears (as a link) while Git runs: the checkout stays in staging and nothing is written through the link.
  const raced = ((_command, args) => { symlinkSync(elsewhere, join(dir, 'raced')); return ok('git', args, {}); }) as typeof spawnSync;
  assert.throws(() => cloneRepository(dir, 'raced', 'https://github.com/acme/raced', 'acme', undefined, raced), /Clone target refused\./);
  assert.deepEqual(readdirSync(elsewhere), []);
  // A failed clone that wrote nothing leaves no staging folder; one that wrote something (or was refused after cloning) keeps it.
  const failedEmpty = (() => ({ status: 128 })) as unknown as typeof spawnSync;
  cloneRepository(dir, 'empty', 'https://github.com/acme/empty', 'acme', undefined, failedEmpty);
  const failedPartial = ((_command, args) => { writeFileSync(join(args.at(-1) as string, 'half'), 'x'); return { status: 128 }; }) as typeof spawnSync;
  cloneRepository(dir, 'partial', 'https://github.com/acme/partial', 'acme', undefined, failedPartial);
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('.')).map(name => name.replace(/-[A-Za-z0-9]+$/, '')), ['.partial', '.raced']);
});

it('rejects unsafe names, URLs and depths before invoking git', () => {
  const never = (() => { assert.fail('git must not run'); }) as typeof spawnSync;
  for (const url of ['http://github.com/acme/shop', 'https://github.com.evil/acme/shop', 'https://user:pass@github.com/acme/shop', 'https://github.com/acme/other', 'https://github.com/acme/shop?x', 'https://github.com/acme/shop/']) assert.throws(() => cloneRepository('repos', 'shop', url, 'acme', undefined, never));
  for (const name of ['../shop', '-shop', '.', 'a/b']) assert.throws(() => cloneRepository('repos', name, 'https://github.com/acme/shop', 'acme', undefined, never));
  for (const owner of ['other', '-acme', '', 'acme/x']) assert.throws(() => cloneRepository('repos', 'shop', 'https://github.com/acme/shop', owner, undefined, never));
  for (const depth of ['0', '-1', '1.5', '1e2', '9007199254740992']) assert.throws(() => cloneRepository('repos', 'shop', 'https://github.com/acme/shop', 'acme', depth, never));
});

it('matches globs in linear time and with the usual wildcard rules', () => {
  assert.equal(globMatch('shop-*', 'Shop-Checkout'), true);
  assert.equal(globMatch('*-checkout', 'acme-shop-checkout'), true);
  assert.equal(globMatch('a?c', 'abc'), true);
  assert.equal(globMatch('a?c', 'ac'), false);
  assert.equal(globMatch('a*b*c', 'axxbxxd'), false);
  assert.equal(globMatch('shop.*', 'shopx1'), false);
  const started = Date.now();
  assert.equal(globMatch(`${'a*'.repeat(25)}b`, 'a'.repeat(100)), false);
  assert.ok(Date.now() - started < 1000);
});

it('canonicalizes GitHub remotes and refuses other hosts', () => {
  for (const value of ['https://github.com/Acme/Shop.git', 'git@github.com:acme/shop', 'ssh://git@github.com/acme/shop.git', 'https://user:token@github.com/acme/shop/']) assert.equal(canonicalRemote(value), 'https://github.com/acme/shop');
  for (const value of ['https://gitlab.com/acme/shop', 'https://github.com/acme', 'file:///tmp/shop', '']) assert.equal(canonicalRemote(value), undefined);
});

it('lists local clones by glob without the gh list, reporting mismatches as conflicts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  checkout(dir, 'shop-a', ['https://github.com/acme/shop-a']);
  checkout(dir, 'shop-b', ['https://github.com/other/shop-b']);
  checkout(dir, 'tool-c', ['https://github.com/acme/tool-c']);
  assert.deepEqual(localRepositories(dir, 'acme/shop-*').repositories.map(r => [r.name, r.action, r.reason]), [['shop-a', 'exists', undefined], ['shop-b', 'conflict', 'origin-mismatch']]);
  assert.deepEqual(localRepositories(join(dir, 'missing'), 'acme/shop-*').repositories, []);
  assert.deepEqual(JSON.parse(main(['local', '--dir', dir, '--pattern', 'acme/tool-*']).output).repositories.map((r: { name: string }) => r.name), ['tool-c']);
});

it('reads only the checkout config and refuses a symlinked clone folder in local', t => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  checkout(dir, 'shop-env', ['https://github.com/other/shop-env']);
  const saved = { ...process.env };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url';
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/shop-env';
  t.after(() => { for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[key]; Object.assign(process.env, saved); });
  assert.deepEqual(localRepositories(dir, 'acme/shop-*').repositories.map(r => [r.name, r.reason]), [['shop-env', 'origin-mismatch']]);
  symlinkSync(dir, join(dir, 'link'));
  assert.throws(() => localRepositories(join(dir, 'link'), 'acme/shop-*'), /Clone folder refused/);
});

it('drops listed repositories whose url is not the pattern owner\'s', () => {
  const result = matchRepositories('acme/shop-*', [repo('shop-a'), repo('shop-b', false, 'https://github.com/other/shop-b'), repo('shop-c', false, 'https://gitlab.com/acme/shop-c'), repo('shop-d', false, 'https://github.com/acme/other-name')]);
  assert.deepEqual(result.repositories.map(r => r.name), ['shop-a']);
});

it('validates patterns: no leading hyphen, no bare wildcard, no escapes', () => {
  for (const pattern of ['acme/shop-*', 'Acme/a?c', 'a-b/x.y*', 'acme/shop', 'acme/*-api', 'acme/*2']) assert.equal(validPattern(pattern), true);
  for (const pattern of ['-x/foo', 'acme/*', 'acme/**', 'acme/*?', 'acme/?*', 'acme/???', 'acme/*-*', 'acme/.*', '*/foo', 'acme', 'acme/a..b', 'acme/a/b', 'acme/@x']) assert.equal(validPattern(pattern), false);
});

it('keeps the skill command in sync with the list limit', () => {
  const skill = readFileSync(new URL('../skills/moiras-index/SKILL.md', import.meta.url), 'utf8');
  assert.ok(skill.includes(`--limit ${listLimit}`));
  assert.ok(skill.includes(`limite de ${listLimit}`));
});

it('counts repositories of another owner, reports a clone timeout and resolves --dir against --base', t => {
  assert.equal(matchRepositories('acme/shop-*', [repo('shop-a'), repo('shop-b', false, 'https://github.com/newowner/shop-b')]).other_owner, 1);
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const timedOut = (() => ({ status: null, error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) })) as unknown as typeof spawnSync;
  const timedOutResult = JSON.parse(cloneRepository(dir, 'shop', 'https://github.com/acme/shop', 'acme', undefined, timedOut).output);
  assert.match(timedOutResult.partial_path, new RegExp(`^${join(dir, '.shop-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const { partial_path: _partial, ...timedOutRest } = timedOutResult;
  assert.deepEqual(timedOutRest, { cloned: false, status: null, timed_out: true });
  assert.equal(existsSync(join(dir, 'shop')), false);
  // A relative --dir starts at --base (the folder of the .moiras), not at the current directory.
  mkdirSync(join(dir, 'repos'));
  const result = JSON.parse(main(['plan-clone', '--dir', 'repos', '--base', dir], JSON.stringify({ owner: 'acme', repositories: [{ name: 'shop' }] })).output);
  assert.equal(result.repositories[0].path, join(dir, 'repos', 'shop'));
});

it('treats a symlinked or file .git as not a checkout, also for local', t => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'shop-a'));
  symlinkSync(dir, join(dir, 'shop-a', '.git'));
  mkdirSync(join(dir, 'shop-b'));
  writeFileSync(join(dir, 'shop-b', '.git'), 'gitdir: /elsewhere\n');
  assert.deepEqual(localRepositories(dir, 'acme/shop-*').repositories.map(r => [r.name, r.reason]), [['shop-a', 'not-a-checkout'], ['shop-b', 'not-a-checkout']]);
});
