import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hash as digestOf } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { hash, parseContent, record, query, main } from './memory.ts';

const script = join(import.meta.dirname, 'memory.ts');
const digest = (text: string) => `sha256:${digestOf('sha256', text)}`;
const quiet = (): void => {};

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'clotho.jsonl') };
}

// Runs the real CLI in a child process.
const cli = (args: string[], input = '', cwd?: string) =>
  spawnSync(process.execPath, [script, ...args], { input, cwd, encoding: 'utf8' });

describe('hash', () => {
  it('sorts nested keys, including numeric keys', () => {
    const first = hash(parseContent('{"z":[{"b":2,"a":1}],"2":2,"10":10}'));
    const second = hash(parseContent('{"10":10,"2":2,"z":[{"a":1,"b":2}]}'));
    assert.equal(first, second);
    assert.equal(first, digest('{"10":10,"2":2,"z":[{"a":1,"b":2}]}'));
  });

  it('hashes strings as-is, objects canonically, and normalizes raw text', () => {
    assert.equal(hash(parseContent(JSON.stringify(' {"b":2,"a":1}\n'))), digest(' {"b":2,"a":1}\n'));
    assert.equal(hash(parseContent('{ "b": 2, "a": 1 }')), digest('{"a":1,"b":2}'));
    assert.equal(hash(parseContent('hello\r\nworld\r\n\r\n')), digest('hello\nworld'));
    assert.equal(hash(parseContent('null')), digest('null'));
  });
});

describe('record', () => {
  it('reports new, unchanged, changed and drops raw content', t => {
    const { dir, file } = fixture(t);
    assert.equal(record('clotho', { key: 'A', content: { b: 2, a: 1 } }, { dir })[0].change, 'new');
    assert.equal(record('clotho', { key: 'A', content: { a: 1, b: 2 } }, { dir })[0].change, 'unchanged');
    assert.equal(record('clotho', { key: 'A', content: 'changed' }, { dir })[0].change, 'changed');
    const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(Object.hasOwn(record, 'content'), false);
      assert.ok(Number.isFinite(Date.parse(record.ts)));
    }
    assert.equal(records.at(-1).hash, digest('changed'));
  });

  it('compares batch duplicates against earlier entries and the stored file', t => {
    const { dir } = fixture(t);
    record('clotho', { key: 'A', hash: digest('old') }, { dir });
    const result = record('clotho', [
      { key: 'A', hash: digest('new') }, { key: 'A', hash: digest('new') },
      { key: 'B', content: null }, { key: 'A', hash: digest('old') },
    ], { dir });
    assert.deepEqual(result.map(record => record.change), ['changed', 'unchanged', 'new', 'changed']);
    assert.deepEqual(result.map(record => record.key), ['A', 'A', 'B', 'A']);
  });

  it('writes nothing when any record in the batch is invalid', t => {
    const { dir, file } = fixture(t);
    assert.throws(() => record('clotho', [{ key: 'A', content: 'valid' }, { content: 'invalid' }], { dir }));
    assert.equal(existsSync(file), false);
    record('clotho', { key: 'A', content: 'initial' }, { dir });
    const before = readFileSync(file, 'utf8');
    for (const input of [{ key: 3, content: '' }, { key: 'B' }, null, [{ key: 'B', hash: 'x' }, {}]]) {
      assert.throws(() => record('clotho', input, { dir }));
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  });

  it('rejects unknown and cross-stage fields before appending any batch entry', t => {
    const { dir, file } = fixture(t);
    record('clotho', { key: 'A', content: 'initial' }, { dir });
    const before = readFileSync(file, 'utf8');
    for (const field of ['text', 'description', 'conteudo', 'com_quem', 'solutions']) {
      assert.throws(() => record('clotho', [
        { key: 'B', content: 'valid' }, { key: 'C', content: 'raw', [field]: 'raw' },
      ], { dir }), /Unknown clotho field/);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
    assert.throws(() => record('lachesis', { key: 'A', content: '', source: 'jira' }, { dir }), /Unknown lachesis/);
    assert.throws(() => record('atropos', { key: 'A', content: '', category: 'bug' }, { dir }), /Unknown atropos/);
    assert.throws(() => record('clotho', { key: 'A', content: '', with_whom: { text: 'raw' } }, { dir }), /Invalid metadata/);
    assert.throws(() => record('lachesis', { key: 'A', content: '', repositories: [{ text: 'raw' }] }, { dir }), /Invalid metadata/);
    assert.throws(() => record('atropos', { key: 'A', content: '', solutions: [{ title: '', description: 'raw' }] }, { dir }), /Invalid metadata/);
  });

  it('accepts only the documented interaction key shape', t => {
    const { dir } = fixture(t);
    const id = 'slack:C0123456789:1696341120.000100:reaction';
    assert.doesNotThrow(() => record('clotho', { key: `interaction:${id}`, content: 'reaction' }, { dir }));
    for (const typo of ['interactions:<id>', 'Interaction:<id>', 'INTERACTION:<id>']) {
      assert.throws(() => record('clotho', { key: typo, content: 'reaction' }, { dir }), /interaction:<id>/);
    }
    assert.throws(() => record('clotho', { key: 'interaction:   ', content: 'reaction' }, { dir }), /interaction:<id>/);
    assert.doesNotThrow(() => record('lachesis', { key: 'interactions', content: 'not-clotho' }, { dir }));
    for (const typo of ['interactions:<id>', 'Interaction:<id>', 'interaction:   ']) {
      assert.throws(() => query('clotho', { key: typo, dir }), /interaction:<id>/);
    }
    assert.deepEqual(query('clotho', { key: `interaction:${id}`, dir }).map(entry => entry.key), [`interaction:${id}`]);
    assert.doesNotThrow(() => query('lachesis', { key: 'interactions', dir }));
  });

  it('keeps atropos records internally coherent', t => {
    const { dir } = fixture(t);
    const base = { key: 'A', content: '', mode: 'interactive', action: 'ready-for-dev', solutions: [{ title: 'Reuse orderFormId', confidence: 70 }] };
    for (const action of ['duplicate', 'blocked', 'ready-for-dev', 'needs-info', 'close']) {
      assert.doesNotThrow(() => record('atropos', { ...base, action }, { dir }));
    }
    for (const invalid of ['merge', 'close-it', '', 7]) {
      assert.throws(() => record('atropos', { key: 'B', content: '', action: invalid }, { dir }), /Invalid metadata: action/);
      assert.throws(() => record('atropos', { key: 'B', content: '', mode: invalid }, { dir }), /Invalid metadata: mode/);
    }
    assert.doesNotThrow(() => record('atropos', { ...base, choice: 1 }, { dir }));
    assert.doesNotThrow(() => record('atropos', { ...base, solutions: [] }, { dir }));
    assert.doesNotThrow(() => record('atropos', { key: 'C', content: '', solutions: [] }, { dir }));
    for (const choice of [0, 2, -1, 1.5]) {
      assert.throws(() => record('atropos', { ...base, choice }, { dir }), /Invalid metadata: choice/);
      assert.throws(() => record('atropos', { ...base, solutions: [] , choice }, { dir }), /Invalid metadata: choice/);
      assert.throws(() => record('atropos', { key: 'C', content: '', choice }, { dir }), /Invalid metadata: choice/);
    }
    const three = { ...base, solutions: [{ title: 'A', confidence: 60 }, { title: 'B', confidence: 30 }, { title: 'C', confidence: 10 }] };
    for (const choice of [1.5, 2.25, Number.NaN]) {
      assert.throws(() => record('atropos', { ...three, choice }, { dir }), /Invalid metadata: choice/);
    }
    assert.doesNotThrow(() => record('atropos', { ...three, choice: 3 }, { dir }));
    assert.doesNotThrow(() => record('atropos', { ...base, choice: 1, id: 'PROJ-123-1' }, { dir }));
    assert.throws(() => record('atropos', { ...base, choice: 'none', id: 'PROJ-123-1' }, { dir }), /Invalid metadata: id/);
    assert.throws(() => record('atropos', { ...base, choice: null, id: 'PROJ-123-1' }, { dir }), /Invalid metadata: id/);
    assert.throws(() => record('atropos', { key: 'D', content: '', id: 'PROJ-123-1' }, { dir }), /Invalid metadata: id/);
    for (const badSolutions of [[{}], [{ title: 'A' }], [{ confidence: 70 }], [{ title: 1, confidence: 70 }], [{ title: 'A', confidence: 70.5 }], [{ title: 'A', confidence: 101 }], [{ title: 'A', confidence: -1 }]]) {
      assert.throws(() => record('atropos', { key: 'E', content: '', solutions: badSolutions }, { dir }), /Invalid metadata: solutions/);
    }
    for (const origin of ['platform', 'app', 'unknown']) {
      assert.doesNotThrow(() => record('lachesis', { key: 'L', content: '', origin, confidence: 0.5 }, { dir }));
    }
    for (const badOrigin of ['backend', '', 1]) {
      assert.throws(() => record('lachesis', { key: 'L', content: '', origin: badOrigin }, { dir }), /Invalid metadata: origin/);
    }
    for (const badConfidence of [-0.1, 1.1, 70, Number.NaN]) {
      assert.throws(() => record('lachesis', { key: 'L', content: '', confidence: badConfidence }, { dir }), /Invalid metadata: confidence/);
    }
    assert.throws(() => record('clotho', { key: 'C', content: '', with_whom: { reporter: 42 } }, { dir }), /Invalid metadata: with_whom/);
    assert.throws(() => record('clotho', { key: 'C', content: '', ts: 'not-a-date' }, { dir }), /Invalid metadata: ts/);
    for (const ts of [
      '2026-02-30T10:00:00Z', '2026-10-19', '10/19/2026', '2026-10-19T10:00:00',
      '2026-13-01T00:00:00Z', '2026-10-19T24:00:00Z', '2023-02-29T00:00:00Z',
      '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-10-19T10:60:00Z',
      '2026-10-19T10:00:60Z', '2026-10-19T10:00:00+24:00', '2026-10-19T10:00:00-03:60',
      '2026-10-19T10:00:00Z\n',
    ]) {
      assert.throws(() => record('clotho', { key: 'C', content: '', ts }, { dir }), { message: 'Invalid metadata: ts' });
    }
    for (const ts of [
      '2026-10-19T10:00:00Z', '2026-10-19T10:00:00.123Z', '2024-02-29T23:59:59-03:00',
      '2026-10-19T10:00Z', '2026-10-19T10:00+23:59', '2000-02-29T00:00:00Z',
    ]) {
      assert.doesNotThrow(() => record('clotho', { key: ts, content: '', ts }, { dir }));
      assert.equal(query('clotho', { dir, key: ts, since: ts })[0].ts, ts);
    }
  });

  it('validates supplied hashes and rejects ambiguous content/hash input atomically', t => {
    const { dir, file } = fixture(t);
    for (const invalid of ['old', '', 'sha256:' + 'a'.repeat(63), 'sha256:' + 'g'.repeat(64), null, 7, {}]) {
      assert.throws(() => record('clotho', [
        { key: 'A', content: true }, { key: 'B', hash: invalid },
      ], { dir }), /Hash must/);
      assert.equal(existsSync(file), false);
    }
    assert.throws(() => record('clotho', { key: 'A', content: '', hash: digest('') }, { dir }), /not both/);
    const upper = 'sha256:' + 'A'.repeat(64);
    assert.equal(record('clotho', { key: 'A', hash: upper }, { dir })[0].hash, upper);
  });

  it('accepts documented metadata for every stage without storing content', t => {
    const { dir } = fixture(t);
    const entries = {
      clotho: { source: 'jira', with_whom: { reporter: 'Fulano' }, updated_at: '2026-10-01' },
      lachesis: { category: 'bug', component: 'checkout', repositories: ['acme-shop-checkout'],
        origin: 'app', complex: false, confidence: 0.78, duplicates: ['PROJ-187'] },
      atropos: { mode: 'interactive', action: 'ready-for-dev',
        solutions: [{ title: 'Revisar estado', confidence: 70 }], choice: null },
    } as const;
    for (const stage of ['clotho', 'lachesis', 'atropos'] as const) {
      record(stage, { key: 'PROJ-123', run_id: 'run-1', content: { text: 'raw' }, ...entries[stage] }, { dir });
      const stored = query(stage, { dir })[0];
      assert.equal(stored.hash, hash({ text: 'raw' }));
      assert.equal(Object.hasOwn(stored, 'content'), false);
      for (const [field, value] of Object.entries(entries[stage])) assert.deepEqual(stored[field], value);
    }
  });

  it('warns and ignores Portuguese-key legacy records without rewriting or deleting them', t => {
    const { dir, file } = fixture(t);
    const legacy = JSON.stringify({ chave: 'A', com_quem: { autor: 'Fulano' }, hash: digest('old') });
    const mixed = JSON.stringify({ chave: 'B', key: 'B', hash: digest('old') });
    const original = legacy + '\n' + mixed;
    writeFileSync(file, original);
    const warnings: string[] = [];
    const warn = (message: string): void => { warnings.push(message); };
    assert.deepEqual(query('clotho', { dir, warn }), []);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(message => message.includes('legacy Portuguese-key record')));
    assert.ok(warnings[0].includes(file + ':1'));
    assert.ok(warnings[1].includes(file + ':2'));
    assert.equal(record('clotho', { key: 'A', hash: digest('old') }, { dir, warn })[0].change, 'new');
    assert.ok(readFileSync(file, 'utf8').startsWith(original + '\n'));
    assert.equal(query('clotho', { dir, warn: quiet }).length, 1);
  });

  it('tolerates malformed lines and an unterminated last line', t => {
    const { dir, file } = fixture(t);
    writeFileSync(file, 'broken\nnull\n' + JSON.stringify({ key: 'A', hash: digest('old') }));
    const warnings: string[] = [];
    const warn = (message: string): void => { warnings.push(message); };
    assert.equal(record('clotho', { key: 'A', hash: digest('old') }, { dir, warn })[0].change, 'unchanged');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /Warning/);
    assert.equal(query('clotho', { dir, warn: quiet }).length, 1);
    assert.equal(readFileSync(file, 'utf8').split('\n').length, 5);
  });
});

describe('query', () => {
  it('selects the latest record per key before filtering', t => {
    const { dir } = fixture(t);
    assert.deepEqual(query('clotho', { dir }), []);
    record('clotho', [
      { key: 'A', hash: digest('1'), ts: '2026-02-01T00:00:00Z' },
      { key: 'B', hash: digest('2'), ts: '2026-03-01T00:00:00Z' },
      { key: 'A', hash: digest('3'), ts: '2026-01-01T00:00:00Z' },
    ], { dir });
    assert.deepEqual(query('clotho', { dir }).map(record => record.hash), [digest('3'), digest('2')]);
    assert.deepEqual(query('clotho', { dir, key: 'A' }).map(record => record.hash), [digest('3')]);
    assert.deepEqual(query('clotho', { dir, since: '2026-03-01T00:00:00Z' }).map(record => record.key), ['B']);
    assert.deepEqual(query('clotho', { dir, key: 'A', since: '2026-02-01T00:00:00Z' }), []);
    assert.throws(() => query('clotho', { dir, since: 'yesterday' }), /Invalid date/);
  });
});

describe('symlinks in memory paths', () => {
  it('refuses broken symlinks instead of treating them as empty or creating their target', t => {
    const { dir, file } = fixture(t);
    symlinkSync('missing.jsonl', file);
    assert.throws(() => query('clotho', { dir }), /symlink refused/);
    assert.throws(() => record('clotho', [{ key: 'A', hash: digest('1') }], { dir }), /symlink refused/);
    assert.equal(existsSync(join(dir, 'missing.jsonl')), false, 'the target behind the link is not created');
  });

  for (const target of ['missing/', 'clotho.jsonl', 'plain/child']) {
    it(`rejects query and record through ${target}`, t => {
      const { dir, file } = fixture(t);
      writeFileSync(join(dir, 'plain'), 'x');
      symlinkSync(target, file);
      assert.throws(() => query('clotho', { dir }), /symlink refused/);
      assert.throws(() => record('clotho', [{ key: 'A', hash: digest('1') }], { dir }), /symlink refused/);
      assert.equal(existsSync(join(dir, 'missing')), false);
      assert.equal(readFileSync(join(dir, 'plain'), 'utf8'), 'x');
    });
  }

  it('refuses a valid symlink on the memory file or its parent directory', t => {
    const { dir, file } = fixture(t);
    const outside = join(dir, 'outside.jsonl');
    const existing = `${JSON.stringify({ key: 'EXTERNAL', hash: digest('secret'), ts: '2026-01-01T00:00:00Z' })}\n`;
    writeFileSync(outside, existing);
    symlinkSync(outside, file);
    assert.throws(() => query('clotho', { dir }), /symlink refused/);
    assert.throws(() => record('clotho', [{ key: 'A', hash: digest('1') }], { dir }), /symlink refused/);
    assert.equal(readFileSync(outside, 'utf8'), existing, 'external target is untouched');

    const linkedDir = join(dir, 'linked-memory');
    symlinkSync(dir, linkedDir);
    assert.throws(() => query('lachesis', { dir: linkedDir }), /symlink refused/);
    assert.throws(() => record('lachesis', [{ key: 'A', hash: digest('1') }], { dir: linkedDir }), /symlink refused/);
    assert.equal(existsSync(join(dir, 'lachesis.jsonl')), false);
  });
});

describe('CLI', () => {
  it('rejects invalid arguments with usage', () => {
    for (const args of [[], ['unknown'], ['record'], ['record', 'invalid'], ['hash', 'extra'],
      ['query', 'clotho', '--dir'], ['record', 'clotho', '--key', 'A'], ['query', 'clotho', '--x', '1']]) {
      assert.throws(() => main(args, () => ''), /Usage:/, JSON.stringify(args));
    }
  });

  it('runs end to end in the default directory for every stage', t => {
    const { dir } = fixture(t);
    for (const stage of ['clotho', 'lachesis', 'atropos']) {
      const written = cli(['record', stage], '{"key":"A","content":true}', dir);
      assert.equal(written.status, 0, written.stderr);
      assert.ok(existsSync(join(dir, '.moiras', 'memory', `${stage}.jsonl`)));
      const read = cli(['query', stage], '', dir);
      assert.equal(JSON.parse(read.stdout)[0].hash, digest('true'));
    }
  });

  it('exits 2 with usage on stderr', () => {
    const result = cli(['record', 'invalid']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  });

  it('prints the hash of stdin', () => {
    assert.equal(cli(['hash'], '{"b":2,"a":1}').stdout.trim(), digest('{"a":1,"b":2}'));
  });
});
