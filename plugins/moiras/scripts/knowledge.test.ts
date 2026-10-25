import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { check, hasSecret, issues, main, parseDoc, plan, provenance, sourcesHash } from './knowledge.ts';

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
    const doc = parseDoc('---\nid: a\nreplaces: [x, "y", \'z\']\nempty: []\nname: "Acme"\n---\n\n# Title\n');
    assert.deepEqual(doc?.fields, { id: 'a', replaces: ['x', 'y', 'z'], empty: [], name: 'Acme' });
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

  it('rejects replaces that is not a list or holds an invalid reference', t => {
    const { local, write } = workspace(t);
    write('local', 'criteria/c.md', criterion('c').replace('replaces: []', 'replaces: a'));
    write('local', 'criteria/bad.md', criterion('bad', '../secret, knowledge:acme/glossary/x.md'));
    write('local', 'criteria/ok.md', criterion('ok', '"regra-a", \'knowledge:acme/criteria/b.md\''));
    assert.deepEqual([...new Set(rules(local))], ['criteria/bad.md:replaces-invalid', 'criteria/c.md:replaces-invalid']);
  });

  it('requires the fields and contract values of each record type', t => {
    const { local, write } = workspace(t);
    write('local', 'learnings/solutions/PROJ-9-1.md', '---\nid: PROJ-9-1\ntype: solution\ncreated_at: 2026-10-01\nresult: resolved\n---\n');
    write('local', 'learnings/solutions/PROJ-9-2.md', solution('resolved').replace('id: PROJ-1-1', 'id: PROJ-9-2').replace('confidence: 70', 'confidence: 170'));
    write('local', 'learnings/solutions/PROJ-9-3.md', solution('resolved').replace('id: PROJ-1-1', 'id: PROJ-9-3').replace('issue: PROJ-1', 'issue: proj-1'));
    write('local', 'criteria/c.md', criterion('c').replace('applies_to: category', 'applies_to: tudo'));
    write('local', 'learnings/patterns/p.md', '---\nid: p\ntype: pattern\ncreated_at: 2026-10-03\n---\n');
    write('local', 'learnings/patterns/p-bad.md', patternDoc('p-bad', '# P').replace('issues: [PROJ-1]', 'issues: [PROJ-1, bad_key]'));
    write('local', 'learnings/decisions/d.md', '---\nid: d\ntype: decision\ncreated_at: 2026-10-03\n---\n');
    write('local', 'glossary/bad-repo.md', glossary('2026-10-06').replace('id: acme-shop-checkout', 'id: bad-repo').replace('platform: vtex', 'platform: magento\nkeywords: [k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11]'));
    assert.deepEqual([...new Set(rules(local))], [
      'criteria/c.md:applies-to-invalid',
      'glossary/bad-repo.md:keywords-too-many',
      'glossary/bad-repo.md:platform-invalid',
      'learnings/decisions/d.md:field-missing',
      'learnings/patterns/p-bad.md:issues-invalid',
      'learnings/patterns/p.md:field-missing',
      'learnings/solutions/PROJ-9-1.md:field-missing',
      'learnings/solutions/PROJ-9-2.md:confidence-invalid',
      'learnings/solutions/PROJ-9-3.md:issue-invalid',
    ]);
    assert.equal(check(local).findings.filter(f => f.path.endsWith('PROJ-9-1.md')).length, 5);
  });

  it('validates malformed placeholders and exempts complete placeholders from contract errors', t => {
    const { local, write } = workspace(t);
    for (const [value, expected] of [['bad<', ['issue-invalid']], ['[PROJ-1]', ['issue-invalid']], ['<PROJ-123>', ['placeholder']]] as const) {
      write('local', 'learnings/solutions/PROJ-1-1.md', solution('resolved').replace('issue: PROJ-1', `issue: ${value}`));
      assert.deepEqual(check(local).findings.map(f => f.rule), expected);
    }
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('resolved'));
    for (const [value, expected] of [
      ['PROJ-1, bad<', ['issues-invalid']],
      ['<PROJ-1>, bad<', ['placeholder', 'issues-invalid']],
      ['<PROJ-1>, PROJ-2', ['placeholder']],
    ] as const) {
      write('local', 'learnings/patterns/p.md', patternDoc('p', '# P').replace('issues: [PROJ-1]', `issues: [${value}]`));
      assert.deepEqual(check(local).findings.map(f => f.rule), expected);
    }
    write('local', 'learnings/patterns/p.md', patternDoc('p', '# P'));
    for (const [value, expected] of [['magento<', ['platform-invalid']], ['[]', ['platform-invalid']], ['<vtex|wake|shopify|other>', ['placeholder']]] as const) {
      write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06').replace('platform: vtex', `platform: ${value}`));
      assert.deepEqual(check(local).findings.map(f => f.rule), expected);
    }
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06'));
  });

  it('accepts qualified learning sources only in the documented shape', t => {
    const { local, write } = workspace(t);
    const decision = (source: string) => `---\nid: d\ntype: decision\ncreated_at: 2026-10-04\nsource: [${source}]\n---\n\n# D\n`;
    for (const folder of ['solutions', 'patterns', 'decisions']) {
      write('local', 'learnings/decisions/d.md', decision(`PROJ-1-1, knowledge:acme.team-1/learnings/${folder}/record.v1.md`));
      assert.deepEqual(check(local, 'learnings').findings, [], folder);
    }
    for (const source of [
      'knowledge:x/learnings/../../secret.md',
      'knowledge:x/criteria/record.md',
      'knowledge:x/learnings/other/record.md',
      'knowledge:x/learnings/solutions/extra/record.md',
      'knowledge:/learnings/solutions/record.md',
      'knowledge:../learnings/solutions/record.md',
      'knowledge:x/learnings/solutions/record..md',
      'knowledge:x/learnings/solutions/.md',
      'knowledge:x/learnings/solutions/record.txt',
    ]) {
      write('local', 'learnings/decisions/d.md', decision(source));
      assert.deepEqual(check(local, 'learnings').findings.map(f => f.rule), ['source-invalid'], source);
    }
    write('local', 'learnings/decisions/d.md', decision('PROJ-1-1'));
    for (const [path, doc] of [
      ['learnings/solutions/PROJ-1-1.md', solution('resolved').replace('chosen_by: Fulano', 'chosen_by: user-1')],
      ['learnings/patterns/p.md', patternDoc('p', '# P')],
    ]) {
      write('local', path!, doc!.replace('repositories: [acme-shop-checkout]', 'repositories: [knowledge:acme/glossary/acme-shop-checkout.md]'));
    }
    assert.deepEqual(check(local, 'learnings').findings.map(f => f.rule), ['repositories-invalid', 'repositories-invalid']);
  });

  it('rejects single-element lists on scalar fields and requires safe lists for repositories and source', t => {
    const { local, write } = workspace(t);
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('[resolved]')
      .replace('id: PROJ-1-1', 'id: [PROJ-1-1]')
      .replace('type: solution', 'type: [solution]')
      .replace('created_at: 2026-10-01', 'created_at: [2026-10-01]')
      .replace('chosen_by: Fulano', 'chosen_by: [Fulano]')
      .replace('repositories: [acme-shop-checkout]', 'repositories: acme-shop-checkout')
      .replace('category: bug', 'category: [bug]')
      .replace('confidence: 70', 'confidence: [70]'));
    write('local', 'criteria/c.md', criterion('c')
      .replace('approved_by: Beltrana', 'approved_by: [Beltrana]')
      .replace('applies_to: category', 'applies_to: [category]'));
    write('local', 'learnings/patterns/p.md', patternDoc('p', '# P').replace('repositories: [acme-shop-checkout]', 'repositories: [../bad]'));
    write('local', 'learnings/decisions/d.md', '---\nid: d\ntype: decision\ncreated_at: 2026-10-04\nsource: PROJ-1-1\n---\n\n# D\n');
    write('local', 'learnings/decisions/d2.md', '---\nid: d2\ntype: decision\ncreated_at: 2026-10-04\nsource: [../bad]\n---\n\n# D\n');
    write('local', 'glossary/acme-shop-checkout.md', glossary('2026-10-06')
      .replace(`sources_hash: ${sha}`, `indexed_commit: [${'a'.repeat(40)}]\nindexed_commit_date: [2026-10-05]\nindexed_dirty: [false]\nsources_hash: [${sha}]`));
    assert.deepEqual(rules(local), [
      'criteria/c.md:applies-to-invalid',
      'criteria/c.md:pseudonym-required',
      'glossary/acme-shop-checkout.md:indexed-commit-date-invalid',
      'glossary/acme-shop-checkout.md:indexed-commit-invalid',
      'glossary/acme-shop-checkout.md:indexed-dirty-invalid',
      'glossary/acme-shop-checkout.md:sources-hash-invalid',
      'learnings/decisions/d.md:source-invalid',
      'learnings/decisions/d2.md:source-invalid',
      'learnings/patterns/p.md:repositories-invalid',
      'learnings/solutions/PROJ-1-1.md:category-invalid',
      'learnings/solutions/PROJ-1-1.md:confidence-invalid',
      'learnings/solutions/PROJ-1-1.md:date-invalid',
      'learnings/solutions/PROJ-1-1.md:id-mismatch',
      'learnings/solutions/PROJ-1-1.md:pseudonym-required',
      'learnings/solutions/PROJ-1-1.md:repositories-invalid',
      'learnings/solutions/PROJ-1-1.md:result-invalid',
      'learnings/solutions/PROJ-1-1.md:type-mismatch',
    ]);
    assert.ok(issues(local).ids.includes('PROJ-1-1'));
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
    write('local', 'learnings/solutions/PROJ-1-1.md', solution('resolved', 'Funcionou em produção.').replace('**Observação:**', '**Observação**:'));
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
    write('repo', 'src/generated/ignored.ts', 'x');
    const generated = hashOf('src/generated');
    chmodSync(join(base, 'src', 'generated'), 0o000);
    try {
      assert.equal(hashOf('src/generated'), hashOf('src/missing'), 'a folder named on its own is skipped when a .gitignore above excludes it');
    } finally {
      chmodSync(join(base, 'src', 'generated'), 0o755);
    }
    assert.ok(generated);
  });

  it('reads an explicit file even when a .gitignore names it, and skips a binary .gitignore', t => {
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

  it('fails the hash when a .gitignore cannot be read instead of hashing what it excludes', t => {
    if (process.getuid?.() === 0) return t.skip('root ignores file permissions');
    const { dir, write } = workspace(t);
    const base = join(dir, 'repo');
    write('repo', '.gitignore', 'hidden/\n');
    write('repo', 'hidden/a.txt', 'x');
    write('repo', 'b.txt', 'y');
    const before = sourcesHash(base, ['.']);
    chmodSync(join(base, '.gitignore'), 0o000);
    try {
      assert.throws(() => sourcesHash(base, ['.']), /\.gitignore: unreadable/);
    } finally {
      chmodSync(join(base, '.gitignore'), 0o644);
    }
    assert.equal(sourcesHash(base, ['.']), before);
  });

  it('fails on a nested unreadable .gitignore for directories but still reads explicit files', t => {
    if (process.getuid?.() === 0) return t.skip('root ignores file permissions');
    const { dir, write } = workspace(t);
    const base = join(dir, 'repo');
    write('repo', 'src/.gitignore', 'hidden/\n');
    write('repo', 'src/hidden/a.txt', 'x');
    chmodSync(join(base, 'src/.gitignore'), 0o000);
    try {
      for (const path of ['.', 'src', 'src/hidden']) {
        assert.throws(() => sourcesHash(base, [path]), /src[/\\]\.gitignore: unreadable/);
      }
      assert.ok(sourcesHash(base, ['src/hidden/a.txt']));
      assert.throws(() => sourcesHash(base, ['src/.gitignore']), /unreadable/);
    } finally {
      chmodSync(join(base, 'src/.gitignore'), 0o644);
    }
  });

  it('fails on a nested symlinked .gitignore for directories', t => {
    const { dir, write } = workspace(t);
    const base = join(dir, 'repo');
    write('repo', 'src/hidden/a.txt', 'x');
    write('repo', 'real.ignore', 'hidden/\n');
    symlinkSync(join(base, 'real.ignore'), join(base, 'src/.gitignore'));
    for (const path of ['.', 'src', 'src/hidden']) {
      assert.throws(() => sourcesHash(base, [path]), /src[/\\]\.gitignore: not-regular-file/);
    }
  });

  it('evaluates anchored rules of a nested .gitignore and skips folders under an ignored ancestor', t => {
    const { dir, write } = workspace(t);
    const base = join(dir, 'repo');
    write('repo', 'src/.gitignore', '/ignored.txt\n');
    write('repo', 'src/keep.ts', 'x');
    write('repo', 'src/deep/.gitignore', '/local.txt\n');
    write('repo', 'src/deep/a.ts', 'x');
    const before = sourcesHash(base, ['.']);
    write('repo', 'src/ignored.txt', 'x');
    write('repo', 'src/deep/local.txt', 'x');
    assert.equal(sourcesHash(base, ['.']), before, 'the first .gitignore found below the base anchors to its own folder');
    write('repo', 'src/other/ignored.txt', 'x');
    assert.notEqual(sourcesHash(base, ['.']), before, 'an anchored rule does not reach deeper folders');

    write('repo', '.gitignore', 'foo/\n');
    write('repo', 'foo/bar/x.ts', 'x');
    assert.equal(sourcesHash(base, ['foo/bar']), sourcesHash(base, ['missing']), 'a folder under an ignored ancestor is skipped');
    assert.notEqual(sourcesHash(base, ['foo/bar/x.ts']), sourcesHash(base, ['missing']), 'a file named on its own is still read');
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

  it('fails instead of reporting a clean run when the knowledge directory is missing or not a directory', t => {
    const { dir, write } = workspace(t);
    const missing = join(dir, 'nunca-existiu');
    for (const call of [() => check(missing), () => issues(missing), () => plan(missing, dir), () => plan(dir, missing)]) {
      assert.throws(call, /not found/);
    }
    const notDir = join(dir, 'nao-e-pasta');
    writeFileSync(notDir, '');
    for (const call of [() => check(notDir), () => issues(notDir)]) assert.throws(call, /not a knowledge directory/);
    const run = spawnSync(process.execPath, [script, 'check', missing], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not found/);
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

  it('detects secrets under quoted keys and Authorization headers, and ignores prose and placeholders', () => {
    for (const line of [
      '"password": "hunter2hunter2"', '{"apiKey": "abcd1234efgh"}', "{'token': 'abc12345'}", "'secret': abc12345", 'password: "hunter"',
      'Authorization: Basic dXNlcjpwYXNz', 'Authorization: Bearer abcdef123456', 'Authorization: Token abcdef123456',
      'Authorization: Digest abcdef123456', 'Authorization: Digest username="fulano", response="abcdef123456"', '{"Authorization": "Digest abcdef123456"}',
      '{"Authorization": "Basic dXNlcjpwYXNz"}', "{'headers': {'Authorization': 'Bearer abcdef123456'}}", 'TOKEN: abc123', 'PASSWORD=abc123',
      'password: correcthorsebatterystaple', 'secret: Abcdefghijkl', 'password: correcthorsebatterystaple.',
    ]) assert.equal(hasSecret(line), true, line);
    for (const line of [
      'Renovar o token: ao expirar a sessão', 'password: veja o cofre', 'Authorization: Basic <token>',
      'Authorization: Basic xxxx', 'Authorization: Digest <token>', 'Authorization: Digest xxxx', 'Authorization: Digest curto', 'Authorization: Basic', 'Authorization: Bearer curto', '"password": "<token>"', '{"apiKey": "xxxx"}', "{'token': '<token>'}",
      '"password": ""', '"user": "fulano"',
    ]) assert.equal(hasSecret(line), false, line);
  });

  it('accepts an optional https reference_url on a solution and refuses anything else', t => {
    const { local, write } = workspace(t);
    const withUrl = (url: string) => solution('pending').replace('result: pending', `reference_url: ${url}\nresult: pending`);
    write('local', 'learnings/solutions/PROJ-1-1.md', withUrl('https://github.com/acme/acme-shop-checkout/pull/12'));
    assert.equal(check(local).findings.filter(f => f.rule === 'reference-url-invalid').length, 0);
    write('local', 'learnings/solutions/PROJ-1-1.md', withUrl('https://github.com:443/acme/x/pull/1'));
    assert.equal(check(local).findings.filter(f => f.rule === 'reference-url-invalid').length, 0);
    for (const bad of ['http://github.com/acme/acme-shop-checkout/pull/12', 'https://user:pass@github.com/acme/x/pull/1', 'https://token@github.com/acme/x/pull/1', 'github.com/acme/x/pull/1', '[https://github.com/acme/x/pull/1]', 'https://%', '']) {
      write('local', 'learnings/solutions/PROJ-1-1.md', withUrl(bad));
      assert.ok(check(local).findings.some(f => f.rule === 'reference-url-invalid'), bad);
    }
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

  it('keeps symlinks out of hash and plan, fingerprints unreadable files by name, and reports them in check', t => {
    const { dir, local, shared, write } = workspace(t);
    write('local', 'criteria/good.md', criterion('good'));
    write('shared', 'criteria/good.md', criterion('good'));
    const initial = sourcesHash(local, ['.']);
    symlinkSync(join(local, 'criteria/good.md'), join(local, 'criteria/link.md'));
    symlinkSync(local, join(local, 'cycle'));
    symlinkSync(local, join(local, 'criteria/cycle.md'));
    assert.equal(sourcesHash(local, ['.']), initial, 'symlinks stay outside the fingerprint');
    write('local', 'criteria/huge.md', 'a'.repeat(1024 * 1024 + 1));
    write('local', 'criteria/binary.md', '\0binary');
    assert.notEqual(sourcesHash(local, ['.']), initial, 'unreadable files still change the hash when they appear');
    assert.throws(() => sourcesHash(local, ['criteria/huge.md']), /file-too-large/);
    assert.throws(() => sourcesHash(local, ['criteria/binary.md']), /binary-file/);
    assert.deepEqual(plan(local, shared).items, [
      { path: 'criteria/binary.md', action: 'conflict', reason: 'binary-file' },
      { path: 'criteria/cycle.md', action: 'conflict', reason: 'symlink' },
      { path: 'criteria/good.md', action: 'skip', reason: 'unchanged' },
      { path: 'criteria/huge.md', action: 'conflict', reason: 'file-too-large' },
      { path: 'criteria/link.md', action: 'conflict', reason: 'symlink' },
    ], 'broken or linked registries surface as conflicts');
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

  it('fails the hash for a path it cannot traverse instead of treating it as absent', t => {
    const { local, write } = workspace(t);
    write('local', 'src/a.txt', 'a');
    write('local', 'file.txt', 'f');
    assert.throws(() => sourcesHash(local, ['file.txt/inside']), /not-directory/);
    if (process.getuid?.() === 0) return;
    chmodSync(join(local, 'src'), 0o000);
    try {
      assert.throws(() => sourcesHash(local, ['src/a.txt']), /unreadable/);
    } finally {
      chmodSync(join(local, 'src'), 0o755);
    }
  });

  it('surfaces broken registries as conflicts instead of dropping from the plan', t => {
    const { local, shared, write } = workspace(t);
    write('local', 'criteria/broken-local.md', 'x'.repeat(1024 * 1024 + 1));
    write('shared', 'learnings/patterns/broken-shared.md', 'y'.repeat(1024 * 1024 + 1));
    write('shared', 'criteria/only-shared.md', criterion('only-shared'));
    write('local', 'criteria/only-shared.md', criterion('only-shared'));
    assert.deepEqual(plan(local, shared), {
      items: [
        { path: 'criteria/broken-local.md', action: 'conflict', reason: 'file-too-large' },
        { path: 'criteria/only-shared.md', action: 'skip', reason: 'unchanged' },
        { path: 'learnings/patterns/broken-shared.md', action: 'conflict', reason: 'shared:file-too-large' },
      ],
      remove: [],
    });
  });

  it('never removes a shared criterion that could not be read', t => {
    const { local, shared, write } = workspace(t);
    write('shared', 'criteria/old.md', 'z'.repeat(1024 * 1024 + 1));
    write('local', 'criteria/new.md', criterion('new', 'old'));
    assert.deepEqual(plan(local, shared), {
      items: [
        { path: 'criteria/new.md', action: 'add', reason: 'new' },
        { path: 'criteria/old.md', action: 'conflict', reason: 'shared:file-too-large' },
      ],
      remove: [],
    });
  });

  it('reports a shared criterion without read permission as a conflict', t => {
    if (process.getuid?.() === 0) return t.skip('root ignores file permissions');
    const { local, shared, write } = workspace(t);
    write('shared', 'criteria/old.md', criterion('old'));
    write('local', 'criteria/new.md', criterion('new', 'old'));
    chmodSync(join(shared, 'criteria/old.md'), 0o000);
    t.after(() => { if (existsSync(join(shared, 'criteria/old.md'))) chmodSync(join(shared, 'criteria/old.md'), 0o644); });
    assert.deepEqual(plan(local, shared), {
      items: [
        { path: 'criteria/new.md', action: 'add', reason: 'new' },
        { path: 'criteria/old.md', action: 'conflict', reason: 'shared:unreadable' },
      ],
      remove: [],
    });
  });

  it('reports a shared kind folder without read permission as a conflict', t => {
    if (process.getuid?.() === 0) return t.skip('root ignores file permissions');
    const { local, shared, write } = workspace(t);
    write('local', 'criteria/a.md', criterion('a'));
    write('shared', 'criteria/old.md', criterion('old'));
    chmodSync(join(shared, 'criteria'), 0o000);
    try {
      const { items, remove } = plan(local, shared);
      assert.deepEqual(items.filter(item => item.path.startsWith('criteria')), [
        { path: 'criteria', action: 'conflict', reason: 'shared:unreadable' },
        { path: 'criteria/a.md', action: 'conflict', reason: 'shared:unreadable' },
      ]);
      assert.deepEqual(remove, []);
    } finally {
      chmodSync(join(shared, 'criteria'), 0o755);
    }
  });

  it('reports a shared folder that is a regular file as a conflict', t => {
    const { local, shared, write } = workspace(t);
    write('local', 'criteria/a.md', criterion('a'));
    write('local', 'learnings/patterns/p.md', patternDoc('p', 'x'));
    write('shared', 'learnings', 'not a folder');
    const { items, remove } = plan(local, shared);
    assert.deepEqual(items.filter(item => item.path.startsWith('learnings')), [
      { path: 'learnings/decisions', action: 'conflict', reason: 'shared:not-directory' },
      { path: 'learnings/patterns', action: 'conflict', reason: 'shared:not-directory' },
      { path: 'learnings/patterns/p.md', action: 'conflict', reason: 'shared:not-directory' },
      { path: 'learnings/solutions', action: 'conflict', reason: 'shared:not-directory' },
    ]);
    assert.deepEqual(items.find(item => item.path === 'criteria/a.md'), { path: 'criteria/a.md', action: 'add', reason: 'new' });
    assert.deepEqual(remove, []);
  });

  it('blocks additions beneath a shared folder that is a link', t => {
    const { dir, local, shared, write } = workspace(t);
    write('local', 'criteria/a.md', criterion('a'));
    write('local', 'learnings/patterns/p.md', patternDoc('p', 'x'));
    write('elsewhere', 'b.md', criterion('b'));
    mkdirSync(shared, { recursive: true });
    symlinkSync(join(dir, 'elsewhere'), join(shared, 'criteria'));
    const { items, remove } = plan(local, shared);
    assert.deepEqual(items.filter(item => item.path.startsWith('criteria')), [
      { path: 'criteria', action: 'conflict', reason: 'shared:symlink' },
      { path: 'criteria/a.md', action: 'conflict', reason: 'shared:symlink' },
    ]);
    assert.ok(items.some(item => item.path === 'learnings/patterns/p.md' && item.action === 'add'));
    assert.deepEqual(remove, []);
  });

  it('resolves the base once, so a symlinked base hashes like the real one, and missing or file bases fail', t => {
    const { dir, local, write } = workspace(t);
    write('local', 'src/a.ts', 'a');
    symlinkSync(local, join(dir, 'alias'));
    assert.equal(sourcesHash(join(dir, 'alias'), ['src']), sourcesHash(local, ['src']));
    assert.throws(() => sourcesHash(join(dir, 'never-was'), ['src']), /not found/);
    assert.throws(() => sourcesHash(join(local, 'src/a.ts'), ['src']), /not a base directory/);
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

  it('sees an untracked file next to a tracked one that differs only in case', t => {
    const cwd = repository(t);
    writeFileSync(join(cwd, 'Foo'), 'one');
    run(cwd, 'add', '.');
    run(cwd, 'commit', '-q', '-m', 'Foo');
    run(cwd, 'config', 'core.ignoreCase', 'true');
    writeFileSync(join(cwd, 'foo'), 'two');
    // On a case-insensitive disk the second write just overwrote the first: nothing to hide there.
    if (readdirSync(cwd).filter(name => name.toLowerCase() === 'foo').length < 2) return;
    assert.equal(run(cwd, 'status', '--porcelain'), '', 'the setup does hide the file from plain git status');
    assert.equal(provenance(cwd).indexed_dirty, true);
  });

  it('gives no provenance, and runs no filter, when the filter listing overflows its buffer', t => {
    const cwd = repository(t);
    const marker = join(cwd, '..', 'filter-ran');
    const script = join(cwd, '..', 'clean.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    writeFileSync(join(cwd, '.gitattributes'), '*.txt filter=zprobe\n');
    for (let i = 0; i < 40; i++) run(cwd, 'config', `filter.a${String(i).padStart(2, '0')}.clean`, 'cat');
    run(cwd, 'config', 'filter.zprobe.clean', script);
    writeFileSync(join(cwd, 'a.txt'), 'one');
    run(cwd, 'add', '.');
    run(cwd, 'commit', '-q', '-m', 'with filter');
    rmSync(marker, { force: true });
    writeFileSync(join(cwd, 'a.txt'), 'two');
    assert.deepEqual(provenance(cwd, 256), { git: false, reason: 'filters-unreadable' });
    assert.equal(existsSync(marker), false);
    writeFileSync(join(cwd, 'a.txt'), 'one');
    assert.equal(provenance(cwd).git, true);
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

  it('sees an edit that keeps size and mtime when the repository only trusts them', t => {
    const cwd = repository(t);
    const file = join(cwd, 'README.md');
    const mtime = new Date('2020-01-01T00:00:00Z');
    run(cwd, 'config', 'core.checkStat', 'minimal');
    run(cwd, 'config', 'core.trustctime', 'false');
    utimesSync(file, mtime, mtime);
    run(cwd, 'add', '.');
    run(cwd, 'commit', '-q', '--amend', '-m', 'init');
    // Git compares ctime in whole seconds: the edit has to land in a later second than the index entry.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    writeFileSync(file, 'acmf');
    utimesSync(file, mtime, mtime);
    assert.equal(run(cwd, 'status', '--porcelain'), '', 'the setup does hide the edit from plain git status');
    assert.equal(provenance(cwd).indexed_dirty, true);
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
