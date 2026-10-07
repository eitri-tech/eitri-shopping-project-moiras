import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hash as digestOf } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { hash, parseConteudo, registrar, consultar, main } from './memoria.ts';

const script = join(import.meta.dirname, 'memoria.ts');
const digest = (text: string) => `sha256:${digestOf('sha256', text)}`;
const quiet = (): void => {};

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-memoria-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'cloto.jsonl') };
}

// Runs the real CLI in a child process.
const cli = (args: string[], input = '', cwd?: string) =>
  spawnSync(process.execPath, [script, ...args], { input, cwd, encoding: 'utf8' });

describe('hash', () => {
  it('sorts nested keys, including numeric keys', () => {
    const first = hash(parseConteudo('{"z":[{"b":2,"a":1}],"2":2,"10":10}'));
    const second = hash(parseConteudo('{"10":10,"2":2,"z":[{"a":1,"b":2}]}'));
    assert.equal(first, second);
    assert.equal(first, digest('{"10":10,"2":2,"z":[{"a":1,"b":2}]}'));
  });

  it('hashes strings as-is, objects canonically, and normalizes raw text', () => {
    assert.equal(hash(parseConteudo(JSON.stringify(' {"b":2,"a":1}\n'))), digest(' {"b":2,"a":1}\n'));
    assert.equal(hash(parseConteudo('{ "b": 2, "a": 1 }')), digest('{"a":1,"b":2}'));
    assert.equal(hash(parseConteudo('hello\r\nworld\r\n\r\n')), digest('hello\nworld'));
    assert.equal(hash(parseConteudo('null')), digest('null'));
  });
});

describe('registrar', () => {
  it('reports novo, inalterado, alterado and drops raw content', t => {
    const { dir, file } = fixture(t);
    assert.equal(registrar('cloto', { chave: 'A', conteudo: { b: 2, a: 1 } }, { dir })[0].mudanca, 'novo');
    assert.equal(registrar('cloto', { chave: 'A', conteudo: { a: 1, b: 2 } }, { dir })[0].mudanca, 'inalterado');
    assert.equal(registrar('cloto', { chave: 'A', conteudo: 'changed' }, { dir })[0].mudanca, 'alterado');
    const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(Object.hasOwn(record, 'conteudo'), false);
      assert.ok(Number.isFinite(Date.parse(record.ts)));
    }
    assert.equal(records.at(-1).hash, digest('changed'));
  });

  it('compares batch duplicates against earlier entries and the stored file', t => {
    const { dir } = fixture(t);
    registrar('cloto', { chave: 'A', hash: 'old' }, { dir });
    const result = registrar('cloto', [
      { chave: 'A', hash: 'new' }, { chave: 'A', hash: 'new' },
      { chave: 'B', conteudo: null }, { chave: 'A', hash: 'old' },
    ], { dir });
    assert.deepEqual(result.map(record => record.mudanca), ['alterado', 'inalterado', 'novo', 'alterado']);
    assert.deepEqual(result.map(record => record.chave), ['A', 'A', 'B', 'A']);
  });

  it('writes nothing when any record in the batch is invalid', t => {
    const { dir, file } = fixture(t);
    assert.throws(() => registrar('cloto', [{ chave: 'A', conteudo: 'valid' }, { conteudo: 'invalid' }], { dir }));
    assert.equal(existsSync(file), false);
    registrar('cloto', { chave: 'A', conteudo: 'initial' }, { dir });
    const before = readFileSync(file, 'utf8');
    for (const input of [{ chave: 3, conteudo: '' }, { chave: 'B' }, null, [{ chave: 'B', hash: 'x' }, {}]]) {
      assert.throws(() => registrar('cloto', input, { dir }));
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  });

  it('tolerates malformed lines and an unterminated last line', t => {
    const { dir, file } = fixture(t);
    writeFileSync(file, 'broken\nnull\n{"chave":"A","hash":"old"}');
    const avisos: string[] = [];
    const avisar = (message: string): void => { avisos.push(message); };
    assert.equal(registrar('cloto', { chave: 'A', hash: 'old' }, { dir, avisar })[0].mudanca, 'inalterado');
    assert.equal(avisos.length, 2);
    assert.match(avisos[0], /Aviso/);
    assert.equal(consultar('cloto', { dir, avisar: quiet }).length, 1);
    assert.equal(readFileSync(file, 'utf8').split('\n').length, 5);
  });
});

describe('consultar', () => {
  it('selects the latest record per chave before filtering', t => {
    const { dir } = fixture(t);
    assert.deepEqual(consultar('cloto', { dir }), []);
    registrar('cloto', [
      { chave: 'A', hash: '1', ts: '2026-02-01T00:00:00Z' },
      { chave: 'B', hash: '2', ts: '2026-03-01T00:00:00Z' },
      { chave: 'A', hash: '3', ts: '2026-01-01T00:00:00Z' },
    ], { dir });
    assert.deepEqual(consultar('cloto', { dir }).map(record => record.hash), ['3', '2']);
    assert.deepEqual(consultar('cloto', { dir, chave: 'A' }).map(record => record.hash), ['3']);
    assert.deepEqual(consultar('cloto', { dir, desde: '2026-03-01T00:00:00Z' }).map(record => record.chave), ['B']);
    assert.deepEqual(consultar('cloto', { dir, chave: 'A', desde: '2026-02-01T00:00:00Z' }), []);
    assert.throws(() => consultar('cloto', { dir, desde: 'ontem' }), /Data inválida/);
  });
});

describe('CLI', () => {
  it('rejects invalid arguments with usage', () => {
    for (const args of [[], ['unknown'], ['registrar'], ['registrar', 'invalid'], ['hash', 'extra'],
      ['consultar', 'cloto', '--dir'], ['registrar', 'cloto', '--chave', 'A'], ['consultar', 'cloto', '--x', '1']]) {
      assert.throws(() => main(args, () => ''), /Uso:/, JSON.stringify(args));
    }
  });

  it('runs end to end in the default directory for every stage', t => {
    const { dir } = fixture(t);
    for (const stage of ['cloto', 'laquesis', 'atropos']) {
      const written = cli(['registrar', stage], '{"chave":"A","conteudo":true}', dir);
      assert.equal(written.status, 0, written.stderr);
      assert.ok(existsSync(join(dir, '.moiras', 'memoria', `${stage}.jsonl`)));
      const read = cli(['consultar', stage], '', dir);
      assert.equal(JSON.parse(read.stdout)[0].hash, digest('true'));
    }
  });

  it('exits 2 with usage on stderr', () => {
    const result = cli(['registrar', 'invalid']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Uso:/);
  });

  it('prints the hash of stdin', () => {
    assert.equal(cli(['hash'], '{"b":2,"a":1}').stdout.trim(), digest('{"a":1,"b":2}'));
  });
});
