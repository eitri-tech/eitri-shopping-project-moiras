import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('./memoria.mjs', import.meta.url));
const source = readFileSync(script, 'utf8').replace(/^import .*;$/gm, '');
// Execute the actual CLI with isolated process and stdin adapters.
function run(args, input = '', cwd) {
  let stdout = '';
  let stderr = '';
  const cliProcess = {
    argv: ['node', script, ...args], exitCode: 0,
    stdout: { write: value => { stdout += value; } },
    stderr: { write: value => { stderr += value; } },
  };
  const location = file => cwd ? resolve(cwd, file) : file;
  runInNewContext(source, {
    createHash, process: cliProcess,
    readFileSync: (file, encoding) => file === 0 ? input : readFileSync(location(file), encoding),
    mkdirSync: (file, options) => mkdirSync(location(file), options),
    appendFileSync: (file, content) => appendFileSync(location(file), content),
    join,
  });
  return { status: cliProcess.exitCode, stdout, stderr };
}
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-memoria-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir, file: join(dir, 'cloto.jsonl'),
    register: input => run(['registrar', 'cloto', '--dir', dir], JSON.stringify(input)),
    consult: (...args) => run(['consultar', 'cloto', '--dir', dir, ...args]),
  };
}
function output(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('hash sorts nested keys, including numeric keys', () => {
  const first = run(['hash'], '{"z":[{"b":2,"a":1}],"2":2,"10":10}');
  const second = run(['hash'], '{"10":10,"2":2,"z":[{"a":1,"b":2}]}');
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.trim(), digest('{"10":10,"2":2,"z":[{"a":1,"b":2}]}'));
});

test('hash strings as-is, objects canonically, and normalize raw text', () => {
  assert.equal(run(['hash'], JSON.stringify(' {"b":2,"a":1}\n')).stdout.trim(), digest(' {"b":2,"a":1}\n'));
  assert.equal(run(['hash'], '{ "b": 2, "a": 1 }').stdout.trim(), digest('{"a":1,"b":2}'));
  assert.equal(run(['hash'], 'hello\r\nworld\r\n\r\n').stdout.trim(), digest('hello\nworld'));
  assert.equal(run(['hash'], 'null').stdout.trim(), digest('null'));
});

test('registrar novo, inalterado, alterado and remove raw content', t => {
  const f = fixture(t);
  assert.equal(output(f.register({ chave: 'A', conteudo: { b: 2, a: 1 } }))[0].mudanca, 'novo');
  assert.equal(output(f.register({ chave: 'A', conteudo: { a: 1, b: 2 } }))[0].mudanca, 'inalterado');
  assert.equal(output(f.register({ chave: 'A', conteudo: 'changed' }))[0].mudanca, 'alterado');
  const records = readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(Object.hasOwn(record, 'conteudo'), false);
    assert.ok(Number.isFinite(Date.parse(record.ts)));
  }
  assert.equal(records[2].hash, digest('changed'));
});

test('batch duplicates compare against earlier batch entries and last stored entry', t => {
  const f = fixture(t);
  output(f.register({ chave: 'A', hash: 'old' }));
  const result = output(f.register([
    { chave: 'A', hash: 'new' }, { chave: 'A', hash: 'new' },
    { chave: 'B', conteudo: null }, { chave: 'A', hash: 'old' },
  ]));
  assert.deepEqual(result.map(record => record.mudanca), ['alterado', 'inalterado', 'novo', 'alterado']);
  assert.deepEqual(result.map(record => record.chave), ['A', 'A', 'B', 'A']);
});

test('invalid batches write nothing', t => {
  const f = fixture(t);
  assert.equal(f.register([{ chave: 'A', conteudo: 'valid' }, { conteudo: 'invalid' }]).status, 2);
  assert.equal(existsSync(f.file), false);
  output(f.register({ chave: 'A', conteudo: 'initial' }));
  const before = readFileSync(f.file, 'utf8');
  for (const input of [{ chave: 3, conteudo: '' }, { chave: 'B' }, null, [{ chave: 'B', hash: 'x' }, {}]]) {
    const result = f.register(input);
    assert.equal(result.status, 2);
    assert.ok(result.stderr);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
});

test('consultar selects latest records before filtering by chave and date', t => {
  const f = fixture(t);
  assert.deepEqual(output(f.consult()), []);
  output(f.register([
    { chave: 'A', hash: '1', ts: '2026-02-01T00:00:00Z' },
    { chave: 'B', hash: '2', ts: '2026-03-01T00:00:00Z' },
    { chave: 'A', hash: '3', ts: '2026-01-01T00:00:00Z' },
  ]));
  assert.deepEqual(output(f.consult()).map(record => record.hash), ['3', '2']);
  assert.deepEqual(output(f.consult('--chave', 'A')).map(record => record.hash), ['3']);
  assert.deepEqual(output(f.consult('--desde', '2026-03-01T00:00:00Z')).map(record => record.chave), ['B']);
  assert.deepEqual(output(f.consult('--chave', 'A', '--desde', '2026-02-01T00:00:00Z')), []);
});

test('malformed existing lines warn and tolerate unterminated final line', t => {
  const f = fixture(t);
  writeFileSync(f.file, 'broken\nnull\n{"chave":"A","hash":"old"}');
  const result = f.register({ chave: 'A', hash: 'old' });
  assert.equal(output(result)[0].mudanca, 'inalterado');
  assert.match(result.stderr, /Aviso/);
  const queried = f.consult();
  assert.equal(output(queried).length, 1);
  assert.match(queried.stderr, /Aviso/);
  assert.equal(readFileSync(f.file, 'utf8').split('\n').length, 5);
});

test('invalid CLI arguments print usage and exit 2', () => {
  for (const args of [[], ['unknown'], ['registrar'], ['registrar', 'invalid'], ['hash', 'extra'],
    ['consultar', 'cloto', '--dir'], ['registrar', 'cloto', '--chave', 'A']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Uso:/);
  }
});

test('default directory resolves from cwd and all stages are supported', t => {
  const { dir } = fixture(t);
  for (const stage of ['cloto', 'laquesis', 'atropos']) {
    output(run(['registrar', stage], '{"chave":"A","conteudo":true}', dir));
    assert.ok(existsSync(join(dir, '.moiras', 'memoria', `${stage}.jsonl`)));
    assert.equal(output(run(['consultar', stage], '', dir))[0].hash, digest('true'));
  }
});
