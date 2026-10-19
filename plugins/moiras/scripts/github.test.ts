import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRemote, cloneRepository, globMatch, listLimit, localRepositories, main, matchRepositories, planClone } from './github.ts';
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
  assert.deepEqual(result, { owner: 'acme', repositories: [repo('ACME-shop-b'), repo('acme-shop-a'), repo('acme-shop-z')].map(r => ({ name: r.name, url: r.url, archived: false })), truncated: false });
  assert.equal(matchRepositories('acme/acme-shop-*', [repo('acme-shop-old', true)], true).repositories.length, 1);
});

it('escapes dots and supports question marks and truncation', () => {
  assert.deepEqual(matchRepositories('acme/shop.?', [repo('shop.a'), repo('shopXa'), repo('shop.ab')]).repositories.map(r => r.name), ['shop.a']);
  assert.equal(matchRepositories('acme/shop*', Array.from({ length: listLimit }, () => repo('other'))).truncated, true);
  assert.equal(matchRepositories('acme/shop*', Array.from({ length: 999 }, () => repo('other'))).truncated, false);
});

it('rejects invalid arguments and malformed inputs', () => {
  for (const pattern of ['*', 'acme', 'acme/*', 'ac*/shop', 'acme/../shop', 'acme/a[b]']) assert.throws(() => matchRepositories(pattern, []), /Usage:/);
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
  // An entry without a usable GitHub url cannot confirm the origin: never `exists`.
  assert.deepEqual(planClone(dir, { repositories: [{ name: 'shop-other' }, { name: 'shop-repo', url: 'https://gitlab.com/acme/shop-repo' }] }).repositories.map(r => r.reason), ['origin-unknown', 'origin-unknown']);
  // An empty `.git` folder must not make Git discover the enclosing repository.
  checkout(dir, 'outer', ['https://github.com/acme/shop-y']);
  mkdirSync(join(dir, 'outer', 'shop-y', '.git'), { recursive: true });
  assert.equal(planClone(join(dir, 'outer'), { repositories: [{ name: 'shop-y', url: 'https://github.com/acme/shop-y' }] }).repositories[0].reason, 'origin-unreadable');
  symlinkSync(dir, join(dir, 'parent'));
  assert.equal(planClone(join(dir, 'parent'), { repositories: [{ name: 'shop-free' }] }).repositories[0].action, 'conflict');
  assert.throws(() => cloneRepository(dir, 'shop-link', 'https://github.com/acme/shop-link'));
  assert.throws(() => cloneRepository(join(dir, 'parent'), 'shop-free', 'https://github.com/acme/shop-free'));
  assert.throws(() => cloneRepository(dir, 'shop-folder', 'https://github.com/acme/shop-folder'));
});

it('runs clone with an argument array and suppresses git failure details', t => {
  process.env.GIT_WORK_TREE = '/elsewhere';
  process.env.GIT_DIR = '/elsewhere/.git';
  t.after(() => { delete process.env.GIT_WORK_TREE; delete process.env.GIT_DIR; });
  const dir = mkdtempSync(join(tmpdir(), 'moiras-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = ((command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, 'clone', '--template=', '--depth', '2', '--', 'https://github.com/acme/acme-shop-checkout.git', join(dir, 'acme-shop-checkout')]);
    assert.equal(options?.env?.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options?.env?.GIT_WORK_TREE, undefined);
    assert.equal(options?.env?.GIT_DIR, undefined);
    return { status: 0 };
  }) as typeof spawnSync;
  assert.deepEqual(JSON.parse(cloneRepository(dir, 'acme-shop-checkout', 'https://github.com/acme/acme-shop-checkout.git', '2', run).output), { cloned: true, path: join(dir, 'acme-shop-checkout') });
  const failed = (() => ({ status: 128, stderr: 'sensitive details' })) as unknown as typeof spawnSync;
  assert.deepEqual(cloneRepository(dir, 'shop', 'https://github.com/acme/shop', undefined, failed), { output: '{"cloned":false,"status":128}', code: 1 });
});

it('rejects unsafe names, URLs and depths before invoking git', () => {
  const never = (() => { assert.fail('git must not run'); }) as typeof spawnSync;
  for (const url of ['http://github.com/acme/shop', 'https://github.com.evil/acme/shop', 'https://user:pass@github.com/acme/shop', 'https://github.com/acme/other', 'https://github.com/acme/shop?x', 'https://github.com/acme/shop/']) assert.throws(() => cloneRepository('repos', 'shop', url, undefined, never));
  for (const name of ['../shop', '-shop', '.', 'a/b']) assert.throws(() => cloneRepository('repos', name, 'https://github.com/acme/shop', undefined, never));
  for (const depth of ['0', '-1', '1.5', '1e2', '9007199254740992']) assert.throws(() => cloneRepository('repos', 'shop', 'https://github.com/acme/shop', depth, never));
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
