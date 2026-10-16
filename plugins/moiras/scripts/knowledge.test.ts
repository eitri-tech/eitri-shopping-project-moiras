import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { check, main, parseDoc, plan, sourcesHash } from './knowledge.ts';

const script = join(import.meta.dirname, 'knowledge.ts');
const sha = `sha256:${'a'.repeat(64)}`;

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-knowledge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (root: string, path: string, text: string) => {
    const file = join(dir, root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  return { dir, local: join(dir, 'local'), shared: join(dir, 'shared'), write };
}

const solution = (result: string, observation = '', extra = '') => `---
id: PROJ-1-1
type: solution
issue: PROJ-1
created_at: 2026-10-01
chosen_by: Fulano
repositories: [acme-shop-checkout]
category: bug
confidence: 70
result: ${result}
---

# Reaproveitar o orderFormId

**Solução:** reaproveitar o orderFormId.${extra}

**Observação:** ${observation}
`;

const criterion = (id: string, replaces = '') => `---
id: ${id}
type: criterion
created_at: 2026-10-02
approved_by: Beltrana
applies_to: category
replaces: [${replaces}]
---

# Regra ${id}
`;

const glossary = (indexedAt: string) => `---
id: acme-shop-checkout
type: repository
url: https://github.com/acme/acme-shop-checkout
platform: vtex
indexed_at: ${indexedAt}
sources_hash: ${sha}
---

# acme-shop-checkout
`;

const patternHead = (id: string) =>
  ['---', `id: ${id}`, 'type: pattern', 'created_at: 2026-10-03', 'repositories: [acme-shop-checkout]', 'issues: [PROJ-1]', '---'];
const patternDoc = (id: string, body: string) => `${patternHead(id).join('\n')}\n\n${body}\n`;

const rules = (dir: string) => check(dir).findings.map(f => `${f.path}:${f.rule}`).sort();

describe('parseDoc', () => {
  it('reads scalars, inline lists, quotes and the body line', () => {
    const doc = parseDoc('---\nid: a\nreplaces: [x, y]\nempty: []\nname: "Acme"\n---\n\n# Title\n');
    assert.deepEqual(doc?.fields, { id: 'a', replaces: ['x', 'y'], empty: [], name: 'Acme' });
    assert.equal(doc?.bodyLine, 7);
    assert.equal(parseDoc('# no frontmatter'), null);
    assert.equal(parseDoc('---\nid: a\n'), null);
  });
});

describe('check', () => {
  it('accepts valid records of every type and ignores .gitkeep', t => {
    const { local, write } = workspace(t);
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06'));
    write('local', 'glossary/.gitkeep', '');
    write('local', 'criteria/regra-a.md', criterion('regra-a'));
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('resolved'));
    write('local', 'learnings/patterns/p.md', patternDoc('p', '# P'));
    write('local', 'learnings/decisions/d.md', '---\nid: d\ntype: decision\ncreated_at: 2026-10-04\nsource: [PROJ-1-1]\n---\n\n# D\n');
    assert.deepEqual(check(local), { checked: 5, findings: [] });
  });

  it('flags frontmatter problems by rule without echoing the content', t => {
    const { local, write } = workspace(t);
    write('local', 'criteria/sem-front.md', '# sem frontmatter\n');
    write('local', 'criteria/errado.md', '---\nid: outro\ntype: decision\ncreated_at: ontem\n---\n');
    write('local', 'criteria/sem-aprovador.md', '---\nid: sem-aprovador\ntype: criterion\ncreated_at: 2026-10-02\n---\n');
    write('local', 'criteria/modelo.md', '---\nid: modelo\ntype: criterion\ncreated_at: AAAA-MM-DD\napproved_by: <pessoa>\n---\n');
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('pending | resolved | not-resolved'));
    write('local', 'learnings/solutions/PROJ-2-1.md', solution('done').replace('PROJ-1-1', 'PROJ-2-1'));
    write('local', 'glossary/vazio.md', '---\nid: vazio\ntype: repository\nindexed_at: 2026-10-06\nsources_hash: abc\n---\n\nTODO\n');
    assert.deepEqual(rules(local), [
      'criteria/errado.md:approved-by-missing',
      'criteria/errado.md:date-invalid',
      'criteria/errado.md:field-missing',
      'criteria/errado.md:id-mismatch',
      'criteria/errado.md:type-mismatch',
      'criteria/modelo.md:date-invalid',
      'criteria/modelo.md:field-missing',
      'criteria/modelo.md:placeholder',
      'criteria/sem-aprovador.md:approved-by-missing',
      'criteria/sem-aprovador.md:field-missing',
      'criteria/sem-front.md:frontmatter-missing',
      'glossary/vazio.md:sources-hash-invalid',
      'glossary/vazio.md:todo-content',
      'learnings/solutions/PROJ-1-1.md:placeholder',
      'learnings/solutions/PROJ-1-1.md:result-invalid',
      'learnings/solutions/PROJ-2-1.md:result-invalid',
    ]);
    assert.ok(!JSON.stringify(check(local)).includes('sem frontmatter'));
  });

  it('reports secrets and personal paths by line, never the match', t => {
    const { local, write } = workspace(t);
    const token = ['ghp', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    write('local', 'learnings/patterns/p.md', [
      ...patternHead('p'), '',
      `Use ${token} para o deploy.`,
      'Veja `/home/fulano/work/app`, ~/workspace/acme e /srv/repos/acme.',
      'Veja views/home/Cart.tsx e a rota /home/products.',
      '',
    ].join('\n'));
    const { findings } = check(local);
    assert.deepEqual(findings.map(f => `${f.rule}@${f.line}`), ['secret@9', 'absolute-path@10']);
    assert.ok(!JSON.stringify(findings).includes(token));
  });

  it('rejects an absolute path in any frontmatter value, but not a relative one', t => {
    const { local, write } = workspace(t);
    const repo = (name: string, localPath: string) =>
      write('local', `glossary/${name}.md`, glossary('2026-10-06').replace('id: acme-shop-checkout', `id: ${name}`).replace('type: repository', `type: repository\nlocal_path: ${localPath}`));
    repo('absoluto', '/workspace/acme');
    repo('raiz', '/root/acme');
    repo('til', '~/acme');
    repo('windows', 'C:\\work\\acme');
    repo('relativo', '../acme-shop-checkout');
    assert.deepEqual(rules(local), [
      'glossary/absoluto.md:absolute-path',
      'glossary/raiz.md:absolute-path',
      'glossary/til.md:absolute-path',
      'glossary/windows.md:absolute-path',
    ]);
  });

  it('requires the fields of each record type', t => {
    const { local, write } = workspace(t);
    write('local', 'learnings/solutions/PROJ-9-1.md', '---\nid: PROJ-9-1\ntype: solution\ncreated_at: 2026-10-01\nresult: resolved\n---\n');
    write('local', 'learnings/solutions/PROJ-9-2.md', solution('resolved').replace('id: PROJ-1-1', 'id: PROJ-9-2').replace('confidence: 70', 'confidence: 170'));
    write('local', 'criteria/c.md', criterion('c').replace('applies_to: category', 'applies_to: tudo'));
    write('local', 'learnings/patterns/p.md', '---\nid: p\ntype: pattern\ncreated_at: 2026-10-03\n---\n');
    write('local', 'learnings/decisions/d.md', '---\nid: d\ntype: decision\ncreated_at: 2026-10-03\n---\n');
    assert.deepEqual([...new Set(rules(local))], [
      'criteria/c.md:applies-to-invalid',
      'learnings/decisions/d.md:field-missing',
      'learnings/patterns/p.md:field-missing',
      'learnings/solutions/PROJ-9-1.md:field-missing',
      'learnings/solutions/PROJ-9-2.md:confidence-invalid',
    ]);
    assert.equal(check(local).findings.filter(f => f.path.endsWith('PROJ-9-1.md')).length, 5);
  });

  it('rejects credentials in URLs and placeholders left in the body, but not code or autolinks', t => {
    const { local, write } = workspace(t);
    const pattern = (id: string, lines: string[]) =>
      write('local', `learnings/patterns/${id}.md`, [...patternHead(id), '', ...lines, ''].join('\n'));
    pattern('senha', ['Clone https://alice:hunter22@example.com/org/repo.git agora.']);
    pattern('token', ['Use https://abc123def@example.com/org/repo.git.']);
    pattern('ssh', ['Use ssh://git@example.com/org/repo.git e <https://example.com/doc>.']);
    pattern('modelo', ['**Problema:** <descrição>', '', '**Riscos:** <riscos>']);
    pattern('codigo', ['Use `Array<string>` e `<div>`.', '', '```tsx', 'const a: Array<string> = [];', '```', '`repo/src/a.ts@a1b2c3d`']);
    assert.deepEqual(check(local).findings.map(f => `${f.path}:${f.rule}@${f.line}`).sort(), [
      'learnings/patterns/modelo.md:placeholder@11',
      'learnings/patterns/modelo.md:placeholder@9',
      'learnings/patterns/senha.md:url-credentials@9',
      'learnings/patterns/token.md:url-credentials@9',
    ]);
  });

  it('allows one snippet of up to 20 lines with a reference and rejects the rest', t => {
    const { local, write } = workspace(t);
    const fence = (lines: number) => ['```ts', ...Array.from({ length: lines }, (_, n) => `const x${n} = ${n};`), '```'].join('\n');
    const record = (name: string, body: string) =>
      write('local', `learnings/patterns/${name}.md`, patternDoc(name, body));
    const reference = '`acme-shop-checkout/src/views/checkout/Cart.tsx@a1b2c3d`';
    record('ok', `${reference}\n\n${fence(20)}`);
    record('longo', `${reference}\n\n${fence(21)}`);
    record('sem-ref', fence(3));
    record('dois', `${reference}\n\n${fence(2)}\n\n${fence(2)}`);
    record('aberto', `${reference}\n\n\`\`\`ts\nconst a = 1;`);
    assert.deepEqual(rules(local), [
      'learnings/patterns/aberto.md:code-fence-unclosed',
      'learnings/patterns/dois.md:code-without-reference',
      'learnings/patterns/dois.md:multiple-snippets',
      'learnings/patterns/longo.md:code-too-long',
      'learnings/patterns/sem-ref.md:code-without-reference',
    ]);
  });

  it('limits the scan with --only', t => {
    const { local, write } = workspace(t);
    write('local', 'criteria/sem-front.md', 'x');
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06'));
    assert.equal(check(local, 'glossary').checked, 1);
    assert.deepEqual(check(local, 'glossary').findings, []);
    assert.equal(check(local, 'criteria').findings.length, 1);
  });
});

describe('plan', () => {
  it('adds new records and skips the ones already shared', t => {
    const { local, shared, write } = workspace(t);
    write('local', 'criteria/novo.md', criterion('novo'));
    write('local', 'criteria/igual.md', criterion('igual'));
    write('shared', 'criteria/igual.md', criterion('igual'));
    write('shared', 'criteria/so-compartilhado.md', criterion('so-compartilhado'));
    assert.deepEqual(plan(local, shared), {
      items: [
        { path: 'criteria/igual.md', action: 'skip', reason: 'unchanged' },
        { path: 'criteria/novo.md', action: 'add', reason: 'new' },
      ],
      remove: [],
    });
  });

  it('lets a solution change only its result and observation', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'learnings/solutions/PROJ-1-1.md', solution('pending'));
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('resolved', 'Funcionou em produção.'));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'learnings/solutions/PROJ-1-1.md', action: 'update', reason: 'result-or-observation' },
    ]);
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('resolved', '', ' Texto reescrito.'));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'learnings/solutions/PROJ-1-1.md', action: 'conflict', reason: 'append-only' },
    ]);
  });

  it('never lets a stale local copy overwrite a shared outcome or its observation', t => {
    const { local, shared, write } = workspace(t);
    const path = 'learnings/solutions/PROJ-1-1.md';
    const planned = () => plan(local, shared).items[0];

    write('shared', path, solution('resolved', 'Funcionou em produção.'));
    write('local', path, solution('pending'));
    assert.deepEqual(planned(), { path, action: 'conflict', reason: 'shared-has-final-result' });

    write('local', path, solution('resolved', 'Outra observação.'));
    assert.deepEqual(planned(), { path, action: 'conflict', reason: 'shared-observation-not-kept' });

    write('local', path, solution('not-resolved', 'Funcionou em produção.\nAuditoria 2026-10-20, Fulano: reaberto.'));
    assert.deepEqual(planned(), { path, action: 'conflict', reason: 'shared-has-final-result' });

    write('local', path, solution('resolved', 'Funcionou em produção.\nAuditoria 2026-10-20, Fulano: confirmado.'));
    assert.deepEqual(planned(), { path, action: 'update', reason: 'result-or-observation' });

    write('shared', path, solution('pending'));
    write('local', path, solution('pending', 'Em teste.'));
    assert.equal(planned()?.action, 'update');
  });

  it('reports a changed pattern as a conflict instead of rewriting it', t => {
    const { local, shared, write } = workspace(t);
    const pattern = (title: string) => patternDoc('p', `# ${title}`);
    write('shared', 'learnings/patterns/p.md', pattern('Antigo'));
    write('local', 'learnings/patterns/p.md', pattern('Novo'));
    assert.equal(plan(local, shared).items[0]?.action, 'conflict');
  });

  it('updates the glossary only when the local index is newer', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'glossary/acme-shop-checkout.md', glossary('2026-10-06'));
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-20'));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'glossary/acme-shop-checkout.md', action: 'update', reason: 'newer-index' },
    ]);
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-09-01'));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'glossary/acme-shop-checkout.md', action: 'skip', reason: 'shared-is-newer' },
    ]);
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06').replace('platform: vtex', 'platform: wake'));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'glossary/acme-shop-checkout.md', action: 'conflict', reason: 'same-date-different-index' },
    ]);
  });

  it('removes only the shared criteria that a local criterion replaces', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'criteria/a.md', criterion('a'));
    write('shared', 'criteria/b.md', criterion('b'));
    write('local', 'criteria/c.md', criterion('c', 'a, b, fantasma'));
    assert.deepEqual(plan(local, shared), {
      items: [{ path: 'criteria/c.md', action: 'add', reason: 'new' }],
      remove: [
        { path: 'criteria/a.md', replacedBy: 'criteria/c.md' },
        { path: 'criteria/b.md', replacedBy: 'criteria/c.md' },
      ],
    });
  });
});

describe('sourcesHash', () => {
  it('follows file content and directory names, ignores what is missing or vendored', t => {
    const { dir, write } = workspace(t);
    write('repo', 'README.md', '# acme');
    write('repo', 'src/views/cart/index.tsx', 'a');
    const read = () => sourcesHash(join(dir, 'repo'), ['README.md', 'package.json', 'src/views']);
    const first = read();
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(read(), first);

    write('repo', 'src/views/cart/index.tsx', 'b');
    assert.equal(read(), first, 'content inside a directory is not part of the hash');
    const all = sourcesHash(join(dir, 'repo'), ['.']);
    for (const name of ['node_modules', '.git', 'dist', 'build', '.next', '.direnv']) {
      write('repo', `${name}/x/index.js`, 'x');
      assert.equal(sourcesHash(join(dir, 'repo'), ['.']), all, name);
      assert.equal(sourcesHash(join(dir, 'repo'), [name]), sourcesHash(join(dir, 'repo'), ['missing']), name);
    }

    write('repo', 'src/views/home/index.tsx', 'a');
    assert.notEqual(read(), first, 'a new file name changes the hash');
    const second = read();
    write('repo', 'README.md', '# acme 2');
    assert.notEqual(read(), second, 'file content changes the hash');
    write('repo', 'package.json', '{}');
    assert.notEqual(read(), second);
  });
});

describe('cli', () => {
  it('prints JSON and exits 1 when a record breaks a rule', t => {
    const { local, write } = workspace(t);
    write('local', 'criteria/sem-front.md', 'x');
    const run = spawnSync(process.execPath, [script, 'check', local], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.deepEqual(JSON.parse(run.stdout).findings, [{ path: 'criteria/sem-front.md', rule: 'frontmatter-missing', severity: 'error' }]);
  });

  it('exits 0 for a clean knowledge and 2 for bad usage', t => {
    const { local, write } = workspace(t);
    write('local', 'criteria/regra-a.md', criterion('regra-a'));
    assert.equal(spawnSync(process.execPath, [script, 'check', local], { encoding: 'utf8' }).status, 0);
    const bad = spawnSync(process.execPath, [script, 'plan', '--local', local], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Usage:/);
    assert.throws(() => main(['check', local, '--only', 'x']), /Invalid --only/);
    assert.throws(() => main(['hash', 'README.md']), /Usage:/);
  });
});


describe('security regressions', () => {
  it('detects assignments, query secrets, identities and conversation references without leaking values', t => {
    const { local, write } = workspace(t);
    const cases = [
      'DATABASE_URL=postgres://db.internal/app', 'SESSION_ID=abcdefgh12345678',
      ...['APP_SECRET', 'AUTH_TOKEN', 'PASSWORD', 'PASSWD', 'API_KEY', 'PRIVATE_KEY', 'CREDENTIAL'].map(key => `${key}=abc123`),
      ...['access_token', 'token', 'key', 'password', 'secret', 'api_key'].map(key => `https://example.com/?${key}=abc123`),
      'SERVICE_URL=https://user:pass@host', 'fulano@example.com',
      'https://acme.slack.com/archives/C123/p123',
    ];
    cases.forEach((body, index) => write('local', `learnings/patterns/p${index}.md`, patternDoc(`p${index}`, body)));
    const result = check(local);
    for (let index = 0; index < cases.length; index++) assert.ok(result.findings.some(f => f.path.endsWith(`/p${index}.md`)), cases[index]);
    assert.ok(!JSON.stringify(result).includes('abc123'));
    write('local', 'criteria/c.md', criterion('c').replace('Beltrana', 'Fulano Silva'));
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('pending').replace('chosen_by: Fulano', 'chosen_by: fulano@example.com'));
    assert.equal(check(local).findings.filter(f => f.rule === 'pseudonym-required').length, 2);
  });

  it('does not classify fictional secret placeholders or pseudonyms as secrets', t => {
    const { local, write } = workspace(t);
    write('local', 'criteria/c.md', criterion('c').replace('Beltrana', 'reviewer-acme-1'));
    write('local', 'learnings/patterns/p.md', patternDoc('p', 'TOKEN=<token>\nPASSWORD=xxxx\nhttps://example.com/?api_key=xxxx\nhttps://<token>@example.com\nhttps://xxxx:xxxx@example.com'));
    assert.equal(check(local).findings.filter(f => ['secret', 'url-credentials'].includes(f.rule)).length, 0);
    assert.equal(check(local).findings.filter(f => f.rule === 'pseudonym-required').length, 0);
  });

  it('counts tilde fences, indented blocks and aggregate code, and requires complete references', t => {
    const { local, write } = workspace(t);
    const ref = '`acme-shop-checkout/src/cart.ts@abcdef0`';
    const put = (id: string, body: string) => write('local', `learnings/patterns/${id}.md`, patternDoc(id, body));
    put('tilde', `${ref}\n~~~ts\n${'a\n'.repeat(21)}~~~`);
    put('spaces', `${ref}\n${'    a\n'.repeat(21)}`);
    put('tabs', `${ref}\n${'\ta\n'.repeat(21)}`);
    put('incomplete', 'x@abcdef0\n```ts\na\n```');
    put('total', Array.from({ length: 4 }, () => `${ref}\n~~~ts\n${'a\n'.repeat(16)}~~~`).join('\n'));
    const result = check(local).findings;
    for (const id of ['tilde', 'spaces', 'tabs']) assert.ok(result.some(f => f.path.endsWith(`/${id}.md`) && f.rule === 'code-too-long'));
    assert.ok(result.some(f => f.path.endsWith('/incomplete.md') && f.rule === 'code-without-reference'));
    assert.ok(result.some(f => f.path.endsWith('/total.md') && f.rule === 'code-total-too-long'));
  });

  it('skips symlinks including cycles, binary and oversized files in hash and plan; check reports them', t => {
    const { dir, local, shared, write } = workspace(t);
    write('local', 'criteria/good.md', criterion('good'));
    write('shared', 'criteria/good.md', criterion('good'));
    const initial = sourcesHash(local, ['.']);
    symlinkSync(join(local, 'criteria/good.md'), join(local, 'criteria/link.md'));
    symlinkSync(local, join(local, 'cycle'));
    symlinkSync(local, join(local, 'criteria/cycle.md'));
    write('local', 'criteria/huge.md', 'a'.repeat(1024 * 1024 + 1));
    write('local', 'criteria/binary.md', '\0binary');
    assert.equal(sourcesHash(local, ['.']), initial);
    assert.equal(plan(local, shared).items.length, 1);
    const result = check(local).findings;
    assert.equal(result.filter(f => f.rule === 'symlink').length, 2);
    assert.ok(result.some(f => f.rule === 'file-too-large'));
    assert.ok(result.some(f => f.rule === 'binary-file'));
    assert.throws(() => sourcesHash(local, ['../shared']), /escapes base/);
    assert.equal(sourcesHash(local, ['cycle']), sourcesHash(local, ['missing']));
    symlinkSync(join(local, 'criteria'), join(dir, 'linked'));
    assert.ok(check(join(dir, 'linked')).findings.every(f => f.rule === 'symlink' || f.rule === 'missing'));
    const deep = Array.from({ length: 34 }, () => 'd').join('/');
    write('local', `${deep}/a.txt`, 'a');
    assert.equal(sourcesHash(local, [deep]), sourcesHash(local, ['missing']));
  });

  it('bounds regex scanning of long lines', t => {
    const { local, write } = workspace(t);
    write('local', 'learnings/patterns/p.md', patternDoc('p', 'a'.repeat(100000) + '@abcdef0'));
    assert.ok(check(local).findings.some(f => f.rule === 'line-too-long'));
  });

  it('resolves shared source replacements and plain ids, never traversal', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'criteria/a.md', criterion('a'));
    write('shared', 'criteria/b.md', criterion('b'));
    write('local', 'criteria/c.md', criterion('c', 'a, knowledge:acme/criteria/b.md, knowledge:acme/criteria/../a.md'));
    assert.deepEqual(plan(local, shared, 'acme').remove, [
      { path: 'criteria/a.md', replacedBy: 'criteria/c.md' },
      { path: 'criteria/b.md', replacedBy: 'criteria/c.md' },
    ]);
  });

  it('leaves qualified replacements unresolved for another or unnamed knowledge', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'criteria/a.md', criterion('a'));
    write('local', 'criteria/c.md', criterion('c', 'knowledge:group-a/criteria/a.md'));
    assert.deepEqual(plan(local, shared, 'group-b').remove, []);
    assert.deepEqual(plan(local, shared).remove, []);
  });

  it('accepts any configured knowledge name in qualified replacements', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'criteria/a.md', criterion('a'));
    write('local', 'criteria/c.md', criterion('c', 'knowledge:group.acme/criteria/a.md'));
    assert.deepEqual(plan(local, shared, 'group.acme').remove, [{ path: 'criteria/a.md', replacedBy: 'criteria/c.md' }]);
  });

  it('flags an e-mail inside a URL but not URL userinfo or scp-style git remotes', t => {
    const { local, write } = workspace(t);
    write('local', 'learnings/patterns/p.md', patternDoc('p', 'Convite https://example.test/invite?email=real.person@example.com'));
    assert.ok(check(local).findings.some(f => f.rule === 'personal-data'));
    write('local', 'learnings/patterns/p.md', patternDoc('p', 'Use git@github.com:org/repo.git e ssh://git@example.com/org/repo.git.'));
    assert.ok(!check(local).findings.some(f => f.rule === 'personal-data'));
  });

  it('canonicalizes optional metadata and preserves the hash without metadata', t => {
    const { dir, write } = workspace(t);
    write('repo', 'a.txt', 'acme');
    const base = join(dir, 'repo');
    const plain = sourcesHash(base, ['a.txt']);
    // Pin the pre-metadata algorithm, including the explicit-file prefix.
    const { createHash } = process.getBuiltinModule('node:crypto');
    const contentHash = createHash('sha256').update('acme').digest('hex');
    assert.equal(plain, `sha256:${createHash('sha256').update(`file:a.txt:${contentHash}`).digest('hex')}`);
    assert.equal(main(['hash', '--base', base, 'a.txt']).output, plain);
    const meta = { owner: 'Fulano', agency: 'Acme', platform: 'vtex', url: 'https://example.com' };
    const first = sourcesHash(base, ['a.txt'], meta);
    assert.notEqual(first, plain);
    assert.equal(main(['hash', '--base', base, '--meta', JSON.stringify(meta), 'a.txt']).output, first);
    assert.equal(sourcesHash(base, ['a.txt'], { url: meta.url, platform: meta.platform, agency: meta.agency, owner: meta.owner }), first);
    for (const key of Object.keys(meta)) assert.notEqual(sourcesHash(base, ['a.txt'], { ...meta, [key]: 'changed' }), first);
    assert.equal(sourcesHash(base, ['a.txt'], { a: { z: 1, b: 2 } }), sourcesHash(base, ['a.txt'], { a: { b: 2, z: 1 } }));
    assert.throws(() => main(['hash', '--base', base, '--meta', '{', 'a.txt']));
  });
});
