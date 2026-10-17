import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { check, issues, main, parseDoc, plan, sourcesHash } from './knowledge.ts';

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

describe('issues', () => {
  it('indexes learning mentions and ids in a stable order without bodies', t => {
    const { local, write } = workspace(t);
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('resolved'));
    write('local', 'learnings/solutions/a.md', solution('resolved').replace('id: PROJ-1-1', 'id: a'));
    write('local', 'learnings/patterns/z.md', patternDoc('z', 'Corpo privado').replace('issues: [PROJ-1]', 'issues: [PROJ-2, PROJ-1, PROJ-1]'));
    write('local', 'learnings/patterns/b.md', patternDoc('b', '# P'));
    write('local', 'learnings/decisions/decision.md', '---\ntype: decision\nissue: PROJ-3\nissues: [PROJ-3]\n---\nCorpo privado');
    write('local', 'criteria/ignored.md', criterion('ignored'));
    const expected = {
      issues: {
        'PROJ-1': { solutions: ['PROJ-1-1', 'a'], patterns: ['b', 'z'] },
        'PROJ-2': { solutions: [], patterns: ['z'] },
      },
      ids: ['PROJ-1-1', 'a', 'b', 'decision', 'z'],
    };
    assert.deepEqual(issues(local), expected);
    assert.deepEqual(main(['issues', local]), { output: JSON.stringify(expected), code: 0 });
  });

  it('returns empty collections for an empty directory and skips unreadable or unparsed records', t => {
    const { dir, local, write } = workspace(t);
    assert.deepEqual(issues(dir), { issues: {}, ids: [] });
    write('local', 'learnings/solutions/no-frontmatter.md', '# Invalid');
    write('local', 'learnings/solutions/unclosed.md', '---\nid: invalid');
    write('local', 'learnings/solutions/binary.md', '\0');
    write('local', 'learnings/solutions/large.md', 'x'.repeat(2 * 1024 * 1024));
    symlinkSync(dir, join(local, 'learnings/solutions/link.md'));
    assert.deepEqual(issues(local), { issues: {}, ids: ['binary', 'large', 'link', 'no-frontmatter', 'unclosed'] });
  });

  it('ignores records that fail check, reserves their names, accepts a scalar issues and merges knowledges', t => {
    const { local, shared, write } = workspace(t);
    write('local', 'learnings/solutions/PROJ-2-1.md', solution('resolved').replace('id: PROJ-1-1', 'id: PROJ-9-1').replace('issue: PROJ-1', 'issue: PROJ-2'));
    write('local', 'learnings/solutions/broken.md', '---\nid: broken\ntype: pattern\nissue: PROJ-4\n---\n');
    write('local', 'learnings/patterns/empty.md', `${patternHead('empty').join('\n')}\n`);
    write('local', 'learnings/patterns/todo.md', patternDoc('todo', 'TODO'));
    write('local', 'learnings/patterns/scalar.md', patternDoc('scalar', '# P').replace('issues: [PROJ-1]', 'issues: PROJ-5'));
    write('shared', 'learnings/patterns/team.md', patternDoc('team', '# P').replace('issues: [PROJ-1]', 'issues: [PROJ-6]'));
    assert.deepEqual(issues([local, shared]), {
      issues: { 'PROJ-5': { solutions: [], patterns: ['scalar'] }, 'PROJ-6': { solutions: [], patterns: ['team'] } },
      ids: ['PROJ-2-1', 'PROJ-9-1', 'broken', 'empty', 'scalar', 'team', 'todo'],
    });
  });

  it('fails instead of returning a partial index when a learnings folder cannot be read', t => {
    const { dir, local, write } = workspace(t);
    write('local', 'learnings/patterns/ok.md', patternDoc('ok', '# P'));
    symlinkSync(dir, join(local, 'learnings/solutions'));
    assert.throws(() => issues(local), /learnings\/solutions cannot be indexed \(symlink\)/);
    rmSync(join(local, 'learnings/solutions'));
    write('local', 'learnings/decisions', 'not a folder');
    assert.throws(() => issues(local), /learnings\/decisions cannot be indexed \(not-directory\)/);
  });

  it('uses the CLI success and usage error paths', t => {
    const { dir } = workspace(t);
    assert.deepEqual(main(['issues', dir]), { output: '{"issues":{},"ids":[]}', code: 0 });
    for (const args of [['issues'], ['issues', dir, '--only', 'learnings']]) {
      assert.throws(() => main(args), /Usage:/);
    }
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

  it('rejects replaces that is not a list', t => {
    const { local, write } = workspace(t);
    write('local', 'criteria/c.md', criterion('c').replace('replaces: []', 'replaces: a'));
    assert.deepEqual([...new Set(rules(local))], ['criteria/c.md:replaces-invalid']);
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

  it('applies the snippet rules to tilde fences and indented code blocks too', t => {
    const { local, write } = workspace(t);
    const record = (name: string, body: string) =>
      write('local', `learnings/patterns/${name}.md`, patternDoc(name, body));
    const reference = '`acme-shop-checkout/src/views/checkout/Cart.tsx@a1b2c3d`';
    const code = (lines: number, indent: string) => Array.from({ length: lines }, (_, n) => `${indent}const x${n} = ${n};`).join('\n');
    record('til-longo', `${reference}\n\n~~~ts\n${code(21, '')}\n~~~`);
    record('til-ok', `${reference}\n\n~~~ts\n${code(3, '')}\n~~~`);
    record('til-aberto', `${reference}\n\n~~~ts\nconst a = 1;`);
    record('quatro', `${reference}\n\n\`\`\`\`md\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\`\`\`\``);
    record('indent-longo', `Exemplo em ${reference}:\n\n${code(21, '    ')}`);
    record('indent-sem-ref', `Exemplo:\n\n${code(3, '\t')}`);
    record('indent-ok', `Exemplo em ${reference}:\n\n${code(3, '    ')}`);
    record('lista', `- item\n\n    continua o item da lista\n\n${code(1, '    ')}\n\ntexto`);
    const quote = (lines: string) => lines.split('\n').map(line => `> ${line}`).join('\n');
    record('citacao-longo', `${reference}\n\n${quote(`~~~ts\n${code(21, '')}\n~~~`)}`);
    record('citacao-sem-ref', quote(`\`\`\`ts\n${code(2, '')}\n\`\`\``));
    record('citacao-ok', `${reference}\n\n${quote(`\`\`\`ts\n${code(2, '')}\n\`\`\``)}\n\n> só uma citação, sem código`);
    record('lista-longo', `- passo\n\n  ${reference}\n\n  \`\`\`ts\n${code(21, '  ')}\n  \`\`\``);
    record('lista-indent', `- passo ${reference}\n\n${code(21, '      ')}`);
    record('quatro-espacos', `${reference}\n\n    \`\`\`ts\n${code(19, '    ')}\n    \`\`\``);
    record('tres-espacos', `${reference}\n\n   \`\`\`ts\n${code(3, '   ')}\n   \`\`\``);
    record('lista-continua', `- passo ${reference}\n\n    texto que continua o item\n\n    mais texto do mesmo item`);
    record('fecha-recuado', `${reference}\n\n\`\`\`ts\n${code(2, '')}\n    \`\`\`\n${code(21, '')}`);
    record('fecha-recuado-lista', `- passo ${reference}\n\n  \`\`\`ts\n${code(2, '  ')}\n      \`\`\`\n${code(21, '  ')}`);
    record('fecha-ok', `${reference}\n\n\`\`\`ts\n${code(2, '')}\n   \`\`\``);
    assert.deepEqual(rules(local), [
      'learnings/patterns/citacao-longo.md:code-too-long',
      'learnings/patterns/citacao-sem-ref.md:code-without-reference',
      'learnings/patterns/fecha-recuado-lista.md:code-fence-unclosed',
      'learnings/patterns/fecha-recuado.md:code-fence-unclosed',
      'learnings/patterns/indent-longo.md:code-too-long',
      'learnings/patterns/indent-sem-ref.md:code-without-reference',
      'learnings/patterns/lista-indent.md:code-too-long',
      'learnings/patterns/lista-longo.md:code-too-long',
      'learnings/patterns/quatro-espacos.md:code-too-long',
      'learnings/patterns/til-aberto.md:code-fence-unclosed',
      'learnings/patterns/til-longo.md:code-too-long',
    ]);
  });

  it('rejects dates that are not on the calendar', t => {
    const { local, write } = workspace(t);
    for (const [id, date] of [['maluco', '2026-99-99'], ['fev', '2026-02-30'], ['bissexto', '2028-02-29'], ['comum', '2027-02-29'], ['ok', '2026-10-16']] as const) {
      write('local', `learnings/patterns/${id}.md`, patternDoc(id, '# P').replace(/created_at: .*/, `created_at: ${date}`));
    }
    assert.deepEqual(rules(local), [
      'learnings/patterns/comum.md:date-invalid',
      'learnings/patterns/fev.md:date-invalid',
      'learnings/patterns/maluco.md:date-invalid',
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

  it('does not offer removals when the replacing criterion is a conflict', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'criteria/a.md', criterion('a'));
    write('shared', 'criteria/c.md', criterion('c').replace('category', 'origin'));
    write('local', 'criteria/c.md', criterion('c', 'a'));
    assert.deepEqual(plan(local, shared), {
      items: [{ path: 'criteria/c.md', action: 'conflict', reason: 'change-by-replaces' }],
      remove: [],
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

  it('leaves out what the .gitignore of the base and of every folder excludes', t => {
    const { dir, write } = workspace(t);
    const base = join(dir, 'repo');
    write('repo', '.gitignore', '*.log\n/coverage/\ntmp/\n');
    write('repo', 'src/index.ts', 'a');
    const hashOf = (...paths: string[]) => sourcesHash(base, paths);
    const before = hashOf('.');
    write('repo', 'debug.log', 'x');
    write('repo', 'src/deep/trace.log', 'x');
    write('repo', 'coverage/lcov.info', 'x');
    write('repo', 'src/tmp/cache.bin', 'x');
    assert.equal(hashOf('.'), before, 'ignored files and folders do not change the hash');
    write('repo', 'src/coverage/report.txt', 'x');
    assert.notEqual(hashOf('.'), before, 'an anchored pattern only covers the base folder');

    write('repo', 'src/.gitignore', 'generated/\n!keep.log\n');
    const nested = hashOf('src');
    write('repo', 'src/generated/api.ts', 'x');
    assert.equal(hashOf('src'), nested, 'a nested .gitignore excludes its own subtree');
    write('repo', 'src/keep.log', 'x');
    assert.notEqual(hashOf('src'), nested, 'a deeper rule can re-include a file');
    write('repo', 'src/.gitignore', 'generated/\n!keep.log\nskip.txt\n');
    const deep = hashOf('src/deep');
    write('repo', 'src/deep/more.log', 'x');
    write('repo', 'src/deep/skip.txt', 'x');
    assert.equal(hashOf('src/deep'), deep, 'a path named on its own still obeys the .gitignore of the folders between it and the base');
    write('repo', 'src/deep/other.txt', 'x');
    assert.notEqual(hashOf('src/deep'), deep);
  });

  it('reads an explicit file even when a .gitignore names it, and skips an unreadable .gitignore', t => {
    const { dir, write } = workspace(t);
    const base = join(dir, 'repo');
    write('repo', '.gitignore', 'secret.txt\n');
    write('repo', 'secret.txt', 'one');
    const first = sourcesHash(base, ['secret.txt']);
    write('repo', 'secret.txt', 'two');
    assert.notEqual(sourcesHash(base, ['secret.txt']), first, 'an explicit file is always read');
    write('repo', 'src/a.txt', 'x');
    write('repo', 'src/.gitignore', Buffer.from([0xff, 0xfe, 0x00]).toString('latin1'));
    const all = sourcesHash(base, ['src']);
    write('repo', 'src/b.txt', 'x');
    assert.notEqual(sourcesHash(base, ['src']), all, 'a binary .gitignore excludes nothing');
  });

  it('reads .gitignore files from the base down and never above it', t => {
    const { dir, write } = workspace(t);
    write('', '.gitignore', 'a.txt\n');
    write('repo', 'a.txt', 'x');
    write('repo', 'b.txt', 'x');
    const base = join(dir, 'repo');
    const first = sourcesHash(base, ['.']);
    write('', '.gitignore', 'a.txt\nb.txt\n');
    assert.equal(sourcesHash(base, ['.']), first, 'a .gitignore above the base does not apply');
    write('repo', '.gitignore', 'a.txt\n');
    assert.notEqual(sourcesHash(base, ['.']), first, 'the one in the base does');
  });

  it('does not enter an ignored folder', t => {
    const { dir, write } = workspace(t);
    const base = join(dir, 'repo');
    write('repo', '.gitignore', 'vendor/\n');
    write('repo', 'src/index.ts', 'a');
    write('repo', 'vendor/pkg/index.js', 'x');
    const before = sourcesHash(base, ['.']);
    chmodSync(join(base, 'vendor'), 0o000);
    try {
      assert.equal(sourcesHash(base, ['.']), before, 'an unreadable ignored folder is never opened');
    } finally {
      chmodSync(join(base, 'vendor'), 0o755);
    }
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
    put('spaces', `${ref}\n\n${'    a\n'.repeat(21)}`);
    put('tabs', `${ref}\n\n${'\ta\n'.repeat(21)}`);
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
