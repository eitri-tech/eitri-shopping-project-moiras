import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    write('repo', 'node_modules/x/index.js', 'x');
    assert.equal(read(), first);

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
