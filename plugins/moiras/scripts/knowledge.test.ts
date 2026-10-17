import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { check, issues, main, parseDoc, plan, provenance, sourcesHash } from './knowledge.ts';

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

const glossary = (indexedAt: string, sourcesHash = sha, provenance = '') => `---
id: acme-shop-checkout
type: repository
url: https://github.com/acme/acme-shop-checkout
platform: vtex
indexed_at: ${indexedAt}
${provenance}sources_hash: ${sourcesHash}
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
    record('sha256', `\`acme-shop-checkout/src/a.ts@${'a'.repeat(64)}\`\n\n${fence(2)}`);
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

  it('validates the optional provenance of a glossary record', t => {
    const { local, write } = workspace(t);
    const sha40 = 'a'.repeat(40);
    const withProvenance = (lines: string[]) => glossary('2026-10-06').replace('sources_hash:', `${lines.join('\n')}\nsources_hash:`);
    write('local', 'glossary/acme-shop-checkout.md', withProvenance([`indexed_commit: ${sha40}`, 'indexed_commit_date: 2026-10-05', 'indexed_dirty: false']));
    assert.deepEqual(check(local, 'glossary').findings, []);
    write('local', 'glossary/acme-shop-checkout.md', withProvenance([`indexed_commit: ${'A'.repeat(40)}`, 'indexed_commit_date: ontem', 'indexed_dirty: maybe']));
    assert.deepEqual(check(local, 'glossary').findings.map(finding => finding.rule).sort(), ['indexed-commit-date-invalid', 'indexed-commit-invalid', 'indexed-dirty-invalid']);
    write('local', 'glossary/acme-shop-checkout.md', withProvenance([`indexed_commit: ${sha40}`]));
    assert.deepEqual(check(local, 'glossary').findings.map(finding => finding.rule), ['provenance-incomplete']);
    write('local', 'glossary/acme-shop-checkout.md', withProvenance([`indexed_commit: ${sha40}`, 'indexed_commit_date: 2026-10-05']));
    assert.deepEqual(check(local, 'glossary').findings.map(finding => finding.rule), ['provenance-incomplete']);
    write('local', 'glossary/acme-shop-checkout.md', withProvenance(['indexed_dirty: false']));
    assert.deepEqual(check(local, 'glossary').findings.map(finding => finding.rule), ['provenance-incomplete']);
    write('local', 'glossary/acme-shop-checkout.md', withProvenance([`indexed_commit: ${sha40}`, 'indexed_commit_date: 2026-10-05', 'indexed_dirty: false', 'indexed_branch: main', 'indexed_tag: v1']));
    assert.deepEqual(check(local, 'glossary').findings.map(finding => finding.rule), ['indexed-ref-unsupported'], 'branch and tag names are not accepted');
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
    const other = `sha256:${'b'.repeat(64)}`;
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-20', other));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'glossary/acme-shop-checkout.md', action: 'update', reason: 'newer-index' },
    ]);
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-09-01', other));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'glossary/acme-shop-checkout.md', action: 'skip', reason: 'shared-is-newer' },
    ]);
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06', other));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'glossary/acme-shop-checkout.md', action: 'conflict', reason: 'same-date-different-index' },
    ]);
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06').replace('platform: vtex', 'platform: wake'));
    assert.deepEqual(plan(local, shared).items, [
      { path: 'glossary/acme-shop-checkout.md', action: 'skip', reason: 'unchanged' },
    ], 'same sources_hash: the rest of the record does not count');
  });

  it('ignores when and where a glossary record was indexed when the sources are the same', t => {
    const { local, shared, write } = workspace(t);
    const at = (commit: string, date: string, dirty = 'false') => `indexed_commit: ${commit.repeat(40)}\nindexed_commit_date: ${date}\nindexed_dirty: ${dirty}\n`;
    write('shared', 'glossary/acme-shop-checkout.md', glossary('2026-10-06', sha, at('a', '2026-10-01')));
    const unchanged = [{ path: 'glossary/acme-shop-checkout.md', action: 'skip', reason: 'unchanged' }];
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06', sha, at('b', '2026-09-01', 'true')));
    assert.deepEqual(plan(local, shared).items, unchanged, 'another commit on the same day');
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-20', sha, at('b', '2026-10-15')));
    assert.deepEqual(plan(local, shared).items, unchanged, 'a later index of the same sources');
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-20', sha));
    assert.deepEqual(plan(local, shared).items, unchanged, 'a record from before the provenance existed');
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06', `sha256:${'b'.repeat(64)}`, at('a', '2026-10-01')));
    assert.deepEqual(plan(local, shared).items, [{ path: 'glossary/acme-shop-checkout.md', action: 'conflict', reason: 'same-date-different-index' }], 'other sources on the same day');
  });

  it('compares glossary records by sources_hash alone', t => {
    const { local, shared, write } = workspace(t);
    const withLine = (line: string, hash = sha) => glossary('2026-10-06', hash).replace('platform: vtex', `platform: vtex\n${line}`);
    const unchanged = [{ path: 'glossary/acme-shop-checkout.md', action: 'skip', reason: 'unchanged' }];
    write('shared', 'glossary/acme-shop-checkout.md', withLine('keywords: [a, b]'));
    write('local', 'glossary/acme-shop-checkout.md', withLine('keywords: [b, a]\napps: [home]'));
    assert.deepEqual(plan(local, shared).items, unchanged, 'same sources_hash: other fields do not matter');
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-20').replace('# acme-shop-checkout', '# acme-shop-checkout\n\nOutro texto.'));
    assert.deepEqual(plan(local, shared).items, unchanged, 'nor does the body');
    write('shared', 'glossary/acme-shop-checkout.md', withLine('indexed_branch: main\nindexed_tag: v1').replace(/^indexed_at: .*\n/m, 'indexed_at: 2026-10-01\n'));
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06'));
    assert.deepEqual(plan(local, shared).items, unchanged, 'old branch and tag fields do not count');
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-20', `sha256:${'b'.repeat(64)}`));
    assert.equal(plan(local, shared).items[0]?.reason, 'newer-index', 'another sources_hash follows the date rule');
    write('shared', 'glossary/acme-shop-checkout.md', glossary('2026-10-01', ''));
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06', ''));
    assert.equal(plan(local, shared).items[0]?.reason, 'newer-index', 'an empty hash proves nothing');
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

describe('provenance', () => {
  const run = (cwd: string, ...args: string[]) => {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fulano', GIT_AUTHOR_EMAIL: 'fulano@example.test', GIT_COMMITTER_NAME: 'Fulano', GIT_COMMITTER_EMAIL: 'fulano@example.test', GIT_COMMITTER_DATE: '2026-10-05T23:30:00-03:00', GIT_AUTHOR_DATE: '2026-10-05T23:30:00-03:00' };
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const repository = (t: TestContext) => {
    const { dir, write } = workspace(t);
    write('repo', 'README.md', 'acme');
    const cwd = join(dir, 'repo');
    run(cwd, 'init', '-q', '-b', 'main');
    run(cwd, 'add', '.');
    run(cwd, 'commit', '-q', '-m', 'init');
    return cwd;
  };

  it('reports the commit, its UTC date and a clean tree', t => {
    const cwd = repository(t);
    assert.deepEqual(provenance(cwd), { git: true, indexed_commit: run(cwd, 'rev-parse', 'HEAD'), indexed_commit_date: '2026-10-06', indexed_dirty: false });
  });

  it('flags a dirty tree and never records branch or tag names', t => {
    const cwd = repository(t);
    run(cwd, 'tag', 'v1.0.0');
    run(cwd, 'checkout', '-q', '-b', 'feat/ana@example.com');
    assert.deepEqual(Object.keys(provenance(cwd)).sort(), ['git', 'indexed_commit', 'indexed_commit_date', 'indexed_dirty']);
    writeFileSync(join(cwd, 'new.txt'), 'x');
    assert.equal(provenance(cwd).indexed_dirty, true);
  });

  it('ignores variables that redirect Git, counts untracked files', t => {
    const cwd = repository(t);
    run(cwd, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(cwd, 'new.txt'), 'x');
    assert.equal(provenance(cwd).indexed_dirty, true);
    const before = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    t.after(() => { for (const [name, value] of [['GIT_DIR', before.dir], ['GIT_WORK_TREE', before.tree]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
    process.env.GIT_DIR = join(cwd, '.git');
    process.env.GIT_WORK_TREE = cwd;
    const { dir } = workspace(t);
    mkdirSync(join(dir, 'plain'));
    assert.deepEqual(provenance(join(dir, 'plain')), { git: false });
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
  });

  it('still reports a dirty tree when the status output overflows the buffer', t => {
    const cwd = repository(t);
    for (let index = 0; index < 20; index++) writeFileSync(join(cwd, `untracked-file-with-a-long-name-${index}.txt`), 'x');
    assert.equal(provenance(cwd, 100).indexed_dirty, true);
  });

  it('refuses provenance when the working tree status cannot be read', t => {
    const cwd = repository(t);
    writeFileSync(join(cwd, '.git', 'index'), 'not an index');
    assert.deepEqual(provenance(cwd), { git: false, reason: 'status-unreadable' });
  });

  it('does not run the clean filters of .gitattributes either', t => {
    const cwd = repository(t);
    const marker = join(cwd, '..', 'filter-ran');
    const script = join(cwd, '..', 'clean.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    writeFileSync(join(cwd, '.gitattributes'), '*.txt filter=probe\n');
    run(cwd, 'config', 'filter.probe.clean', script);
    run(cwd, 'config', 'filter.probe.process', script);
    writeFileSync(join(cwd, 'a.txt'), 'one');
    run(cwd, 'add', '.');
    run(cwd, 'commit', '-q', '-m', 'with filter');
    rmSync(marker, { force: true });
    writeFileSync(join(cwd, 'a.txt'), 'two');
    writeFileSync(join(cwd, 'a.txt'), 'one');
    assert.equal(provenance(cwd).git, true);
    assert.equal(existsSync(marker), false);
  });

  it('does not enter submodules, so their filters never run', t => {
    const { dir, write } = workspace(t);
    write('sub', 'a.txt', 'one');
    const sub = join(dir, 'sub');
    run(sub, 'init', '-q', '-b', 'main');
    writeFileSync(join(sub, '.gitattributes'), '*.txt filter=probe\n');
    run(sub, 'add', '.');
    run(sub, 'commit', '-q', '-m', 'sub');
    write('sup', 'README.md', 'acme');
    const sup = join(dir, 'sup');
    run(sup, 'init', '-q', '-b', 'main');
    run(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub');
    run(sup, 'add', '.');
    run(sup, 'commit', '-q', '-m', 'sup');
    const marker = join(dir, 'filter-ran');
    const script = join(dir, 'clean.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    run(join(sup, 'libs', 'sub'), 'config', 'filter.probe.clean', script);
    writeFileSync(join(sup, 'libs', 'sub', 'a.txt'), 'two');
    assert.equal(provenance(sup).indexed_dirty, false);
    assert.equal(existsSync(marker), false);
  });

  it('counts hidden index entries as dirty but not sparse-excluded files', t => {
    const cwd = repository(t);
    writeFileSync(join(cwd, 'b.txt'), 'b');
    writeFileSync(join(cwd, 'c.txt'), 'c');
    run(cwd, 'add', '.');
    run(cwd, 'commit', '-q', '-m', 'more');
    assert.equal(provenance(cwd).indexed_dirty, false);
    run(cwd, 'update-index', '--skip-worktree', 'c.txt');
    rmSync(join(cwd, 'c.txt'));
    assert.equal(provenance(cwd).indexed_dirty, false);
    writeFileSync(join(cwd, 'c.txt'), 'edited');
    assert.equal(provenance(cwd).indexed_dirty, true);
    run(cwd, 'update-index', '--no-skip-worktree', 'c.txt');
    run(cwd, 'checkout', '--', 'c.txt');
    assert.equal(provenance(cwd).indexed_dirty, false);
    run(cwd, 'update-index', '--assume-unchanged', 'b.txt');
    writeFileSync(join(cwd, 'b.txt'), 'edited');
    assert.equal(provenance(cwd).indexed_dirty, true);
  });

  it('counts a staged submodule update as dirty without entering the submodule', t => {
    const { dir, write } = workspace(t);
    write('sub', 'a.txt', 'one');
    const sub = join(dir, 'sub');
    run(sub, 'init', '-q', '-b', 'main');
    run(sub, 'add', '.');
    run(sub, 'commit', '-q', '-m', 'sub');
    write('sup', 'README.md', 'acme');
    const sup = join(dir, 'sup');
    run(sup, 'init', '-q', '-b', 'main');
    run(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub');
    run(sup, 'add', '.');
    run(sup, 'commit', '-q', '-m', 'sup');
    assert.equal(provenance(sup).indexed_dirty, false);
    const inner = join(sup, 'libs', 'sub');
    writeFileSync(join(inner, 'a.txt'), 'two');
    run(inner, 'commit', '-q', '-am', 'advance');
    run(sup, 'add', 'libs/sub');
    assert.equal(provenance(sup).indexed_dirty, true);
  });

  it('does not run a configured fsmonitor and refuses a folder inside another repository', t => {
    const cwd = repository(t);
    const marker = join(cwd, '..', 'fsmonitor-ran');
    const hook = join(cwd, '..', 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    run(cwd, 'config', 'core.fsmonitor', hook);
    assert.equal(provenance(cwd).git, true);
    assert.equal(existsSync(marker), false);
    mkdirSync(join(cwd, 'src'));
    assert.deepEqual(provenance(join(cwd, 'src')), { git: false });
  });

  it('describes HEAD itself when a replacement ref points at another commit', t => {
    const cwd = repository(t);
    const head = run(cwd, 'rev-parse', 'HEAD');
    const tree = run(cwd, 'rev-parse', 'HEAD^{tree}');
    const other = spawnSync('git', ['-C', cwd, 'commit-tree', tree, '-m', 'other'], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fulano', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fulano', GIT_COMMITTER_EMAIL: 'f@example.test', GIT_COMMITTER_DATE: '2026-01-02T12:00:00+00:00', GIT_AUTHOR_DATE: '2026-01-02T12:00:00+00:00' } }).stdout.trim();
    run(cwd, 'replace', head, other);
    const result = provenance(cwd);
    assert.deepEqual([result.indexed_commit, result.indexed_commit_date], [head, '2026-10-06']);
  });

  it('does not run the signature verifier a repository configures', t => {
    const cwd = repository(t);
    const marker = join(cwd, '..', 'verifier-ran');
    const verifier = join(cwd, '..', 'verifier.sh');
    writeFileSync(verifier, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const tree = run(cwd, 'rev-parse', 'HEAD^{tree}');
    const parent = run(cwd, 'rev-parse', 'HEAD');
    const raw = `tree ${tree}\nparent ${parent}\nauthor Fulano <f@example.test> 1790000000 +0000\ncommitter Fulano <f@example.test> 1790000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
    const made = spawnSync('git', ['-C', cwd, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { input: raw, encoding: 'utf8' }).stdout.trim();
    run(cwd, 'update-ref', 'HEAD', made);
    run(cwd, 'config', 'log.showSignature', 'true');
    run(cwd, 'config', 'gpg.program', verifier);
    assert.equal(provenance(cwd).git, true);
    assert.equal(existsSync(marker), false);
    spawnSync('git', ['-C', cwd, 'log', '-1'], { encoding: 'utf8' });
    assert.equal(existsSync(marker), true, 'the setup does make Git call the verifier');
  });

  it('reports git: false without a repository or a commit and prints through the CLI', t => {
    const { dir, write } = workspace(t);
    write('plain', 'a.txt', 'x');
    assert.deepEqual(provenance(join(dir, 'plain')), { git: false });
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    run(empty, 'init', '-q');
    assert.deepEqual(provenance(empty), { git: false });
    assert.deepEqual(JSON.parse(main(['provenance', join(dir, 'plain')]).output), { git: false });
    assert.throws(() => main(['provenance']), /Usage/);
  });
});
