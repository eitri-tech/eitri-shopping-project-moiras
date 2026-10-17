import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnored, parseIgnore } from './gitignore.ts';
import type { IgnoreLayer } from './gitignore.ts';

const layer = (text: string, dir = ''): IgnoreLayer => ({ dir, rules: parseIgnore(text) });
const ignored = (text: string, path: string, isDirectory = false, dir = '') => isIgnored([layer(text, dir)], path, isDirectory);

describe('parseIgnore', () => {
  it('skips blank lines, comments and patterns that are only a slash', () => {
    assert.deepEqual(parseIgnore('\n# comment\n   \r\n/\n!\n'), []);
  });

  it('matches a name at any depth unless the pattern holds a slash', () => {
    assert.equal(ignored('secret.txt', 'secret.txt'), true);
    assert.equal(ignored('secret.txt', 'a/b/secret.txt'), true);
    assert.equal(ignored('secret.txt', 'a/notsecret.txt'), false);
    assert.equal(ignored('a/b.txt', 'a/b.txt'), true);
    assert.equal(ignored('a/b.txt', 'x/a/b.txt'), false);
    assert.equal(ignored('/b.txt', 'b.txt'), true);
    assert.equal(ignored('/b.txt', 'a/b.txt'), false);
  });

  it('applies a trailing slash to folders only', () => {
    assert.equal(ignored('build/', 'build', true), true);
    assert.equal(ignored('build/', 'src/build', true), true);
    assert.equal(ignored('build/', 'build', false), false);
  });

  it('handles *, ? and character classes without crossing slashes', () => {
    assert.equal(ignored('*.log', 'a/b/x.log'), true);
    assert.equal(ignored('x?.log', 'xy.log'), true);
    assert.equal(ignored('x?.log', 'x/.log'), false);
    assert.equal(ignored('a/*.log', 'a/b/x.log'), false);
    assert.equal(ignored('f[0-9].txt', 'f7.txt'), true);
    assert.equal(ignored('f[!0-9].txt', 'f7.txt'), false);
    assert.equal(ignored('f[!0-9].txt', 'fa.txt'), true);
    assert.equal(ignored('f[]a].txt', 'f].txt'), true);
    assert.equal(ignored('f[].txt', 'f].txt'), false);
    assert.equal(ignored('f[abc', 'f[abc'), true);
  });

  it('handles ** as a whole segment', () => {
    assert.equal(ignored('**/logs', 'logs', true), true);
    assert.equal(ignored('**/logs', 'a/b/logs', true), true);
    assert.equal(ignored('logs/**', 'logs/a/b.txt'), true);
    assert.equal(ignored('logs/**', 'logs', true), false);
    assert.equal(ignored('a/**/z', 'a/z'), true);
    assert.equal(ignored('a/**/z', 'a/b/c/z'), true);
    assert.equal(ignored('a/**/z', 'b/a/z'), false);
    assert.equal(ignored('a**b', 'axxb'), true);
    assert.equal(ignored('a**b', 'a/b'), false);
  });

  it('lets the last matching rule win, including negation', () => {
    assert.equal(ignored('*.log\n!keep.log', 'keep.log'), false);
    assert.equal(ignored('*.log\n!keep.log', 'drop.log'), true);
    assert.equal(ignored('!keep.log\n*.log', 'keep.log'), true);
  });

  it('reads escapes, trailing spaces and CRLF', () => {
    assert.equal(ignored('\\#notes', '#notes'), true);
    assert.equal(ignored('\\!bang', '!bang'), true);
    assert.equal(ignored('name  ', 'name'), true);
    assert.equal(ignored('name\\ ', 'name '), true);
    assert.equal(ignored('name\\ ', 'name'), false);
    assert.equal(ignored('a.txt\r\nb.txt\r\n', 'b.txt'), true);
    assert.equal(ignored('a\\*b', 'a*b'), true);
    assert.equal(ignored('a\\*b', 'axb'), false);
  });

  it('escapes regular expression characters in names', () => {
    assert.equal(ignored('a+b(1).txt', 'a+b(1).txt'), true);
    assert.equal(ignored('a+b(1).txt', 'aab1.txt'), false);
    assert.equal(ignored('a.b', 'axb'), false);
  });

  it('skips lines that are too long and survives a hostile pattern', () => {
    assert.deepEqual(parseIgnore(`${'a'.repeat(2000)}\n`), []);
    const started = Date.now();
    ignored(`${'**/'.repeat(30)}x`, `${'a/'.repeat(200)}y`);
    assert.ok(Date.now() - started < 1000);
  });
});

describe('isIgnored', () => {
  it('scopes a .gitignore to its own folder', () => {
    const layers = [layer('/local.txt\n*.tmp', 'pkg')];
    assert.equal(isIgnored(layers, 'pkg/local.txt', false), true);
    assert.equal(isIgnored(layers, 'local.txt', false), false);
    assert.equal(isIgnored(layers, 'pkg/deep/x.tmp', false), true);
    assert.equal(isIgnored(layers, 'other/x.tmp', false), false);
    assert.equal(isIgnored(layers, 'pkgx/x.tmp', false), false);
  });

  it('lets a deeper .gitignore re-include what a shallower one excluded', () => {
    const layers = [layer('*.gen.ts'), layer('!api.gen.ts', 'src')];
    assert.equal(isIgnored(layers, 'src/api.gen.ts', false), false);
    assert.equal(isIgnored(layers, 'src/other.gen.ts', false), true);
    assert.equal(isIgnored(layers, 'lib/api.gen.ts', false), true);
  });
});
