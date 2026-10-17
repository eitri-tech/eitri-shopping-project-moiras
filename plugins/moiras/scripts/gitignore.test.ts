import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnored, layerOf, parseIgnore } from './gitignore.ts';
import type { IgnoreLayer } from './gitignore.ts';

const layer = (text: string, dir = ''): IgnoreLayer => layerOf(dir, text);
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
    assert.equal(ignored('f[abc', 'f[abc'), false, 'an unclosed class is a pattern Git rejects: it never matches');
    assert.equal(ignored('[[:digit:]].txt', '7.txt'), true);
    assert.equal(ignored('[[:digit:]].txt', 'a.txt'), false);
    assert.equal(ignored('[![:upper:]]x', 'ax'), true);
    assert.equal(ignored('[[:nope:]]', 'a'), false);
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

  it('matches bytes like Git and counts the backslashes before trailing spaces', () => {
    assert.equal(ignored('?', 'é'), false);
    assert.equal(ignored('??', 'é'), true);
    assert.equal(ignored('caf*', 'café'), true);
    assert.equal(ignored('foo\\\\ ', 'foo\\'), true, 'two backslashes escape each other, so the space is trailing');
    assert.equal(ignored('foo\\', 'foo\\'), false, 'a lone trailing backslash is rejected');
    assert.equal(ignored('a//b', 'a/b'), false);
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

  it('excludes nothing from a file that is too big, instead of keeping a truncated part of it', () => {
    assert.deepEqual(parseIgnore(`*\n!keep\n${'a'.repeat(2000)}\n`), []);
    const many = `*\n${Array.from({ length: 2500 }, (_, index) => `x${index}`).join('\n')}\n!keep\n`;
    assert.deepEqual(parseIgnore(many), []);
    assert.equal(ignored(many, 'keep'), false);
    assert.deepEqual(parseIgnore(`${Array.from({ length: 150 }, () => 'a'.repeat(100)).join('\n')}\n`).length, 150);
  });

  it('survives a hostile pattern', () => {
    const started = Date.now();
    ignored(`${'**/'.repeat(30)}x`, `${'a/'.repeat(200)}y`);
    const wide = `${Array.from({ length: 150 }, () => `${'*a'.repeat(40)}b`).join('\n')}\n`;
    for (let index = 0; index < 50; index += 1) ignored(wide, 'a'.repeat(255));
    assert.ok(Date.now() - started < 2000);
  });
});

describe('byte order mark', () => {
  it('is dropped before the first rule, as Git does', () => {
    assert.equal(ignored('\uFEFFsecret.txt\nother.txt', 'secret.txt'), true);
    assert.equal(ignored('\uFEFF# comment\nother.txt', 'other.txt'), true);
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
