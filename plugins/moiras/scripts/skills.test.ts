import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { check, checkSkill, plan } from './knowledge.ts';
import { buildPlan, concrete, lineDiff, main, slug, stale, write } from './skills.ts';

const fingerprint = `sha256:${'a'.repeat(64)}`;
const next = `sha256:${'c'.repeat(64)}`;
const date = '2026-10-29';
const sources = `sha256:${'1'.repeat(64)}`;

function fixture(t: TestContext, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

const solution = (id: string, options: { result?: string; component?: string; issue?: string; body?: string; extra?: string } = {}) => `---
id: ${id}
type: solution
issue: ${options.issue ?? 'PROJ-1'}
created_at: 2026-10-01
chosen_by: reviewer-01
repositories: [acme-shop-checkout]
${options.component === undefined ? 'component: checkout' : options.component ? `component: ${options.component}` : ''}
category: bug
confidence: 70
result: ${options.result ?? 'resolved'}
${options.extra ?? ''}---

${options.body ?? solutionBody()}`;

const solutionBody = (symptom = 'o carrinho é recriado quando o usuário troca de seller no checkout', fix = 'reaproveitar o id do carrinho ao trocar de seller.') => `# Manter o id do carrinho na troca de seller

**Problema:** ${symptom}.

**Causa provável:** o carrinho antigo é descartado na troca de seller.

**Solução:** ${fix}

1. Ler o id atual antes de criar um carrinho novo.

**Riscos:** itens de sellers diferentes no mesmo carrinho.

**Observação:**
`;

const glossary = `---
id: acme-shop-checkout
type: repository
url: https://github.com/acme/acme-shop-checkout
local_path: ../acme-shop-checkout
platform: other
apps: [checkout, cart]
keywords: [carrinho, checkout]
owner: "@acme/squad-checkout"
indexed_at: 2026-01-15
sources_hash: ${sources}
---

# acme-shop-checkout

Loja virtual da Acme: carrinho e checkout.

## Componentes

- \`checkout\`: \`src/views/checkout/\`
- \`cart\`: \`src/views/cart/\`
`;

const criterion = (id: string, title: string, replaces = '[]') => `---
id: ${id}
type: criterion
created_at: 2026-02-01
approved_by: reviewer-01
applies_to: solutions
replaces: ${replaces}
---

# ${title}

Problema de plataforma de terceiros entra como needs-info até haver evidência.

**Por quê:** evita atribuir ao app um defeito da plataforma.
`;

const pattern = `---
id: cart-keeps-id
type: pattern
created_at: 2026-01-15
repositories: [acme-shop-checkout]
component: checkout
issues: [PROJ-1, PROJ-2]
---

# Carrinho perde o id na troca de seller

**Sintoma:** o carrinho some ao trocar de seller no checkout.

**Onde olhar:** a pasta de checkout do acme-shop-checkout.

**Soluções que funcionaram:** PROJ-1-1.
`;

const decision = `---
id: keep-cart-id
type: decision
created_at: 2026-01-20
source: [PROJ-1-1]
---

# Manter o id do carrinho

**Decisão:** manter o id do carrinho ao trocar de seller.

**Por quê:** a solução PROJ-1-1 resolveu o problema assim.
`;

const rejected = `---
id: rejected-cart-redirect
type: decision
created_at: 2026-02-10
issue: PROJ-1
outcome: rejected
reason: redirecionar para a home perde o carrinho de outro seller
reference_url: https://github.com/acme/acme-shop-checkout/pull/15
imported_from: git
---

# Redirecionar o carrinho para a home

**Decisão:** enviar o usuário para a home ao trocar de seller.

**Por quê:** foi testado e descartado.
`;

/** A knowledge that passes `check`, with one resolved solution that has a pattern, a decision, a rejected decision and a glossary. */
function base(): Record<string, string> {
  return {
    'glossary/acme-shop-checkout.md': glossary,
    'criteria/platform-first.md': criterion('platform-first', 'Falha de plataforma de terceiros'),
    'learnings/solutions/PROJ-1-1.md': solution('PROJ-1-1', { extra: 'reference_url: https://github.com/acme/acme-shop-checkout/pull/12\n' }),
    'learnings/solutions/PROJ-1-2.md': solution('PROJ-1-2', { result: 'not-resolved' }),
    'learnings/patterns/cart-keeps-id.md': pattern,
    'learnings/decisions/keep-cart-id.md': decision,
    'learnings/decisions/rejected-cart-redirect.md': rejected,
  };
}

const exportedDir = (dir: string, id: string) => join(dir, 'skills', id, 'SKILL.md');

describe('skills: which records become skills', () => {
  it('exports a resolved solution as one self-contained skill, named from repository, component and id', t => {
    const local = fixture(t, base());
    const result = buildPlan({ local, shared: [], fingerprint, date });
    const item = result.plan.items.find(entry => entry.path === 'skills/PROJ-1-1/SKILL.md');
    assert.equal(item?.action, 'add');
    assert.equal(item?.name, 'acme-shop-checkout-checkout-proj-1-1');
    const text = result.texts.get('skills/PROJ-1-1/SKILL.md')!;
    assert.match(text, /^description: "O carrinho é recriado quando o usuário troca de seller no checkout \(acme-shop-checkout\/checkout\)\. Use quando aparecer esse sintoma\."$/m);
    assert.match(text, /^metadata: \{ source_hash: "sha256:a{64}", indexed_at: "2026-10-29" \}$/m);
    for (const section of ['## Sintoma', '## Causa', '## Como confirmar', '## Correção que resolveu', '## O que não resolveu', '## Regras e termos usados', '## Origem']) {
      assert.ok(text.includes(section), section);
    }
    assert.match(text, /Referência \(PR\): https:\/\/github\.com\/acme\/acme-shop-checkout\/pull\/12/);
    assert.deepEqual(checkSkill('skills/PROJ-1-1/SKILL.md', text), []);
  });

  it('exports patterns and decisions as their own skills, and never a rejected decision', t => {
    const local = fixture(t, base());
    const { plan: result } = buildPlan({ local, shared: [], fingerprint, date });
    const names = Object.fromEntries(result.items.map(item => [item.id, item.name]));
    assert.equal(names['cart-keeps-id'], 'acme-shop-checkout-checkout-cart-keeps-id');
    assert.equal(names['keep-cart-id'], 'acme-shop-checkout-checkout-keep-cart-id');
    assert.equal(names['rejected-cart-redirect'], undefined);
    assert.ok(result.excluded.some(entry => entry.id === 'rejected-cart-redirect' && entry.reason === 'rejected-attached'));
  });

  it('leaves out pending and not-resolved solutions, a learning without concrete symptom and one without component, with the reason only', t => {
    const local = fixture(t, {
      ...base(),
      'learnings/solutions/PROJ-2-1.md': solution('PROJ-2-1', { result: 'pending', issue: 'PROJ-2' }),
      'learnings/solutions/PROJ-4-1.md': solution('PROJ-4-1', { issue: 'PROJ-4', body: solutionBody('indeterminada') }),
      'learnings/solutions/PROJ-5-1.md': solution('PROJ-5-1', { issue: 'PROJ-5', component: '' }),
    });
    const { plan: result } = buildPlan({ local, shared: [], fingerprint, date });
    const reason = (id: string) => result.excluded.find(entry => entry.id === id)?.reason;
    assert.equal(reason('PROJ-2-1'), 'pending');
    assert.equal(reason('PROJ-1-2'), 'not-resolved');
    assert.equal(reason('PROJ-4-1'), 'no-symptom');
    assert.equal(reason('PROJ-5-1'), 'component-missing');
    assert.equal(result.items.some(item => item.id === 'PROJ-4-1' || item.id === 'PROJ-5-1'), false);
  });

  it('puts the not-resolved attempts of the same issue in "O que não resolveu"', t => {
    const local = fixture(t, base());
    const { texts } = buildPlan({ local, shared: [], fingerprint, date });
    const text = texts.get('skills/PROJ-1-1/SKILL.md')!;
    assert.match(text, /^- Manter o id do carrinho na troca de seller \(PROJ-1-2\): não resolveu$/m);
    assert.match(text, /^- Redirecionar o carrinho para a home: redirecionar para a home perde o carrinho de outro seller \(acme\/acme-shop-checkout#15\)$/m);
  });

  describe('rejected approaches in "O que não resolveu"', () => {
    /** A rejected decision in the format of moiras-learn --from-git: `outcome`, `reason`, `reference_url` and `issue`, no `source`. */
    const rejectedOf = (id: string, title: string, options: { issue?: string; url?: string }) => `---
id: ${id}
type: decision
created_at: 2026-02-12
outcome: rejected
reason: não atende o carrinho de outro seller
${options.issue ? `issue: ${options.issue}\n` : ''}${options.url ? `reference_url: ${options.url}\n` : ''}imported_from: git
---

# ${title}

**Decisão:** seguir por outro caminho.

**Por quê:** foi testado e descartado.
`;
    const solvedWith = (url: string, body?: string) => ({
      'learnings/solutions/PROJ-9-1.md': solution('PROJ-9-1', { issue: 'PROJ-9', extra: `reference_url: ${url}\n`, body }),
    });

    it('shows a rejection of the same issue with no substitute PR cited by the learning', t => {
      const local = fixture(t, {
        ...base(),
        ...solvedWith('https://github.com/acme/acme-shop-checkout/pull/30'),
        'learnings/decisions/rejected-nine.md': rejectedOf('rejected-nine', 'Pular a validação do seller', { issue: 'PROJ-9', url: 'https://github.com/acme/acme-shop-checkout/pull/31' }),
      });
      const { texts } = buildPlan({ local, shared: [], fingerprint, date });
      assert.match(texts.get('skills/PROJ-9-1/SKILL.md')!, /^- Pular a validação do seller: não atende o carrinho de outro seller \(acme\/acme-shop-checkout#31\)$/m);
    });

    it('matches the dono/repo#n form of the issue as well as the Jira key', t => {
      const local = fixture(t, {
        ...base(),
        'learnings/solutions/PROJ-9-1.md': solution('PROJ-9-1', { issue: 'acme/acme-shop-checkout#9' }),
        'learnings/decisions/rejected-nine.md': rejectedOf('rejected-nine', 'Trocar o seller no servidor', { issue: 'acme/acme-shop-checkout#9' }),
      });
      const { texts } = buildPlan({ local, shared: [], fingerprint, date });
      assert.match(texts.get('skills/PROJ-9-1/SKILL.md')!, /^- Trocar o seller no servidor: /m);
    });

    it('falls back to the reference_url when the learning cites the rejected PR, with no issue in common', t => {
      const local = fixture(t, {
        ...base(),
        ...solvedWith('https://github.com/acme/acme-shop-checkout/pull/30', solutionBody('o carrinho some ao trocar de seller no checkout', 'manter o id, no lugar de https://github.com/acme/acme-shop-checkout/pull/31.')),
        'learnings/decisions/rejected-nine.md': rejectedOf('rejected-nine', 'Recriar o carrinho', { url: 'https://github.com/acme/acme-shop-checkout/pull/31' }),
      });
      const { texts } = buildPlan({ local, shared: [], fingerprint, date });
      assert.match(texts.get('skills/PROJ-9-1/SKILL.md')!, /^- Recriar o carrinho: .* \(acme\/acme-shop-checkout#31\)$/m);
    });

    it('does not show a rejection of another issue, nor one whose PR is only a prefix of the cited number', t => {
      const local = fixture(t, {
        ...base(),
        ...solvedWith('https://github.com/acme/acme-shop-checkout/pull/30', solutionBody('o carrinho some ao trocar de seller no checkout', 'manter o id, como em https://github.com/acme/acme-shop-checkout/pull/310.')),
        'learnings/decisions/other-issue.md': rejectedOf('other-issue', 'Mudar a home', { issue: 'PROJ-42', url: 'https://github.com/acme/acme-shop-checkout/pull/44' }),
        'learnings/decisions/prefix.md': rejectedOf('prefix', 'Fechar a PR antiga', { url: 'https://github.com/acme/acme-shop-checkout/pull/31' }),
      });
      const { texts } = buildPlan({ local, shared: [], fingerprint, date });
      const text = texts.get('skills/PROJ-9-1/SKILL.md')!;
      assert.doesNotMatch(text, /Mudar a home/);
      assert.doesNotMatch(text, /Fechar a PR antiga/);
      assert.doesNotMatch(texts.get('skills/PROJ-1-1/SKILL.md')!, /Mudar a home/);
    });
  });

  it('embeds the applicable criteria and the glossary entries, without local paths', t => {
    const local = fixture(t, base());
    const { texts } = buildPlan({ local, shared: [], fingerprint, date });
    const text = texts.get('skills/PROJ-1-1/SKILL.md')!;
    assert.match(text, /- Falha de plataforma de terceiros: Problema de plataforma de terceiros/);
    assert.match(text, /- acme-shop-checkout \(https:\/\/github\.com\/acme\/acme-shop-checkout\), plataforma other/);
    assert.match(text, /  - `checkout`: `src\/views\/checkout\/`/);
    assert.doesNotMatch(text, /local_path|\.\.\/acme|owner/);
  });

  it('leaves out a criterion that a newer one replaces', t => {
    const local = fixture(t, {
      ...base(),
      'criteria/old-rule.md': criterion('old-rule', 'Regra antiga'),
      'criteria/new-rule.md': criterion('new-rule', 'Regra nova', '[old-rule]'),
    });
    const { texts } = buildPlan({ local, shared: [], fingerprint, date });
    const text = texts.get('skills/PROJ-1-1/SKILL.md')!;
    assert.doesNotMatch(text, /Regra antiga/);
    assert.match(text, /Regra nova/);
  });

  it('leaves out two learnings whose names collide, both of them, with the reason', t => {
    const local = fixture(t, {
      ...base(),
      'learnings/solutions/PROJ-7-1.md': solution('PROJ-7-1', { issue: 'PROJ-7' }),
      'learnings/solutions/proj-7-1.md': solution('proj-7-1', { issue: 'PROJ-7' }),
    });
    const { plan: result } = buildPlan({ local, shared: [], fingerprint, date });
    assert.equal(result.excluded.filter(entry => entry.reason === 'name-collision').length, 2);
  });
});

describe('skills: writing is idempotent and only with the approved plan', () => {
  it('writes the approved plan, and a second plan adds and updates nothing', t => {
    const local = fixture(t, base());
    const first = buildPlan({ local, shared: [], fingerprint, date }).plan;
    const done = write({ local, shared: [], fingerprint, date, expect: first.digest });
    assert.ok(done.written.includes('skills/PROJ-1-1/SKILL.md'));
    assert.deepEqual(done.check, []);
    assert.ok(readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8').startsWith('---\nname: acme-shop-checkout-checkout-proj-1-1\n'));

    const second = buildPlan({ local, shared: [], fingerprint, date }).plan;
    assert.deepEqual(second.items.filter(item => item.action !== 'unchanged'), []);
    const again = write({ local, shared: [], fingerprint, date, expect: second.digest });
    assert.deepEqual(again.written, []);
  });

  it('refuses to write when the plan changed after the user approved it, and writes nothing', t => {
    const local = fixture(t, base());
    const approved = buildPlan({ local, shared: [], fingerprint, date }).plan;
    writeFileSync(join(local, 'learnings/solutions/PROJ-9-1.md'), solution('PROJ-9-1', { issue: 'PROJ-9' }));
    assert.throws(() => write({ local, shared: [], fingerprint, date, expect: approved.digest }), /plan changed/);
    assert.throws(() => readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8'));
  });

  it('keeps the name and the folder on regeneration, updates the file, and does not touch the date when the fingerprint is the same', t => {
    const local = fixture(t, base());
    const first = buildPlan({ local, shared: [], fingerprint, date }).plan;
    write({ local, shared: [], fingerprint, date, expect: first.digest });
    writeFileSync(join(local, 'learnings/solutions/PROJ-1-1.md'), solution('PROJ-1-1', { extra: 'reference_url: https://github.com/acme/acme-shop-checkout/pull/12\n', body: solutionBody('o carrinho é recriado quando o usuário troca de seller no checkout', 'manter o carrinho e o id na troca de seller.') }));
    const changed = buildPlan({ local, shared: [], fingerprint: next, date: '2026-11-02' }).plan;
    const item = changed.items.find(entry => entry.id === 'PROJ-1-1');
    assert.equal(item?.action, 'update');
    assert.equal(item?.path, 'skills/PROJ-1-1/SKILL.md');
    assert.ok(item?.diff?.some(line => line.startsWith('+ ') && line.includes('manter o carrinho')));
    write({ local, shared: [], fingerprint: next, date: '2026-11-02', expect: changed.digest });
    const names = readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8');
    assert.match(names, /^name: acme-shop-checkout-checkout-proj-1-1$/m);
    assert.match(names, /indexed_at: "2026-11-02"/);
    assert.equal(buildPlan({ local, shared: [], fingerprint: next, date: '2026-12-01' }).plan.items.find(entry => entry.id === 'PROJ-1-1')?.action, 'unchanged');
  });

  it('blocks a skill that breaks the rules (code block), with the rule and line only, and never writes it', t => {
    const body = `# Manter o id do carrinho na troca de seller\n\n**Problema:** o carrinho é recriado quando o usuário troca de seller no checkout.\n\n**Solução:** reaproveitar o id do carrinho.\n\nReferência: acme/acme-shop-checkout/src/cart.ts@abcdef1\n\n\`\`\`ts\nconst total = 1;\n\`\`\`\n\n**Riscos:** itens de sellers diferentes.\n`;
    const local = fixture(t, { ...base(), 'learnings/solutions/PROJ-8-1.md': solution('PROJ-8-1', { issue: 'PROJ-8', body }) });
    const { plan: result, texts } = buildPlan({ local, shared: [], fingerprint, date });
    const item = result.items.find(entry => entry.id === 'PROJ-8-1');
    assert.equal(item?.action, 'blocked');
    assert.deepEqual(item?.findings?.map(finding => finding.rule), ['skill-code-block', 'skill-code-block']);
    assert.equal(texts.has('skills/PROJ-8-1/SKILL.md'), false);
    assert.equal(JSON.stringify(result).includes('const total'), false);
  });

  it('a secret in a learning leaves it out: only the record and its reason show', t => {
    const body = solutionBody('o carrinho é recriado quando o usuário troca de seller no checkout', 'usar API_KEY=abcdefgh1234 no serviço.');
    const local = fixture(t, { ...base(), 'learnings/solutions/PROJ-6-1.md': solution('PROJ-6-1', { issue: 'PROJ-6', body }) });
    const { plan: result } = buildPlan({ local, shared: [], fingerprint, date });
    assert.ok(result.excluded.some(entry => entry.id === 'PROJ-6-1' && entry.reason === 'source-invalid'));
    assert.equal(JSON.stringify(result).includes('abcdefgh1234'), false);
    assert.equal(result.items.some(item => item.id === 'PROJ-6-1'), false);
  });

  it('reports orphans and never removes them', t => {
    const local = fixture(t, base());
    const first = buildPlan({ local, shared: [], fingerprint, date }).plan;
    write({ local, shared: [], fingerprint, date, expect: first.digest });
    mkdirSync(join(local, 'skills/PROJ-99-1'), { recursive: true });
    writeFileSync(join(local, 'skills/PROJ-99-1/SKILL.md'), readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8').replace(/PROJ-1-1/g, 'PROJ-99-1'));
    const later = buildPlan({ local, shared: [], fingerprint, date }).plan;
    assert.deepEqual(later.orphans, ['skills/PROJ-99-1/SKILL.md']);
    assert.ok(readFileSync(exportedDir(local, 'PROJ-99-1'), 'utf8'));
  });
});

describe('skills: staleness and conflicts after the knowledge moves on', () => {
  it('marks a skill whose learning changed result as stale, with the result conflict', t => {
    const local = fixture(t, base());
    const first = buildPlan({ local, shared: [], fingerprint, date }).plan;
    write({ local, shared: [], fingerprint, date, expect: first.digest });
    writeFileSync(join(local, 'learnings/solutions/PROJ-1-1.md'), solution('PROJ-1-1', { result: 'not-resolved', extra: 'reference_url: https://github.com/acme/acme-shop-checkout/pull/12\n' }));
    const entry = stale({ skills: local, local, shared: [], fingerprint: next }).find(item => item.path === 'skills/PROJ-1-1/SKILL.md');
    assert.equal(entry?.status, 'stale');
    assert.deepEqual(entry?.conflicts.map(conflict => conflict.kind), ['result-changed', 'source-missing']);
  });

  it('flags a criterion that a newer one replaces as a conflict of the skill', t => {
    const local = fixture(t, base());
    const first = buildPlan({ local, shared: [], fingerprint, date }).plan;
    write({ local, shared: [], fingerprint, date, expect: first.digest });
    writeFileSync(join(local, 'criteria/new-rule.md'), criterion('new-rule', 'Regra nova', '[platform-first]'));
    rmSync(join(local, 'criteria/platform-first.md'));
    const entry = stale({ skills: local, local, shared: [], fingerprint: next }).find(item => item.path === 'skills/PROJ-1-1/SKILL.md');
    assert.equal(entry?.status, 'stale');
    assert.ok(entry?.conflicts.some(conflict => conflict.kind === 'criterion-replaced' && conflict.detail === 'platform-first'));
  });

  it('reports a skill edited by hand as divergent when the fingerprint did not move, and current otherwise', t => {
    const local = fixture(t, base());
    const first = buildPlan({ local, shared: [], fingerprint, date }).plan;
    write({ local, shared: [], fingerprint, date, expect: first.digest });
    assert.equal(stale({ skills: local, local, shared: [], fingerprint }).find(item => item.path === 'skills/PROJ-1-1/SKILL.md')?.status, 'current');
    writeFileSync(exportedDir(local, 'PROJ-1-1'), readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8').replace('Sintoma', 'Sintoma editado'));
    const entry = stale({ skills: local, local, shared: [], fingerprint }).find(item => item.path === 'skills/PROJ-1-1/SKILL.md');
    assert.equal(entry?.status, 'divergent');
  });

  it('reads the skills of another folder (a shared clone) against the sources given', t => {
    const local = fixture(t, base());
    const shared = fixture(t, {});
    const first = buildPlan({ local, shared: [], fingerprint, date }).plan;
    write({ local, shared: [], fingerprint, date, expect: first.digest });
    const copied = readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8');
    mkdirSync(join(shared, 'skills/PROJ-1-1'), { recursive: true });
    writeFileSync(join(shared, 'skills/PROJ-1-1/SKILL.md'), copied);
    const entries = stale({ skills: shared, local, shared: [], fingerprint: next });
    assert.equal(entries[0]?.status, 'stale');
    assert.deepEqual(entries[0]?.conflicts, []);
  });
});

describe('knowledge.ts: skills are checked and planned like the other records', () => {
  it('check flags a skill with a secret, a name that does not match its folder, and a missing section', t => {
    const dir = fixture(t, {
      'skills/PROJ-1-1/SKILL.md': `---\nname: acme-otro-nome\ndescription: "Carrinho some. Use quando aparecer."\nmetadata: { source_hash: "${fingerprint}", indexed_at: "2026-10-29" }\n---\n\n# Titulo\n\n## Sintoma\n\nAPI_KEY=abcdefgh1234\n`,
    });
    const rules = check(dir, 'skills').findings.map(finding => finding.rule);
    assert.ok(rules.includes('skill-name-invalid'));
    assert.ok(rules.includes('secret'));
    assert.ok(rules.includes('skill-section-missing'));
  });

  it('check accepts a generated skill', t => {
    const local = fixture(t, base());
    const { plan: result } = buildPlan({ local, shared: [], fingerprint, date });
    write({ local, shared: [], fingerprint, date, expect: result.digest });
    assert.deepEqual(check(local, 'skills').findings, []);
  });

  it('plan adds a new local skill, and conflicts with a shared one of the same sources but other content', t => {
    const local = fixture(t, base());
    const shared = fixture(t, base());
    const built = buildPlan({ local, shared: [], fingerprint, date }).plan;
    write({ local, shared: [], fingerprint, date, expect: built.digest });
    const sharedCopy = readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8');
    mkdirSync(join(shared, 'skills/PROJ-1-1'), { recursive: true });
    writeFileSync(join(shared, 'skills/PROJ-1-1/SKILL.md'), sharedCopy.replace('Sintoma', 'Sintoma do time'));
    const skillItems = <T extends { path: string }>(items: T[]) => items.filter(item => item.path === 'skills/PROJ-1-1/SKILL.md');
    const items = skillItems(plan(local, shared, 'acme').items);
    assert.deepEqual(items.map(item => [item.path, item.action, item.reason]), [['skills/PROJ-1-1/SKILL.md', 'conflict', 'same-sources-different-skill']]);
    assert.deepEqual(skillItems(plan(local, fixture(t, base()), 'acme').items).map(item => item.action), ['add']);
  });
});

describe('skills: helpers and the command', () => {
  it('slugs names to lowercase kebab case', () => {
    assert.equal(slug('acme-shop-checkout-checkout-PROJ-1-1'), 'acme-shop-checkout-checkout-proj-1-1');
    assert.equal(slug('__A  b__'), 'a-b');
  });

  it('treats a symptom with fewer than three words, or placeholders, as not concrete', () => {
    assert.equal(concrete('carrinho some'), false);
    assert.equal(concrete('indeterminada'), false);
    assert.equal(concrete('o carrinho <descrição> some'), false);
    assert.equal(concrete('o carrinho some ao trocar de seller'), true);
  });

  it('shows only the changed lines of a diff', () => {
    assert.deepEqual(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd']), ['- b', '+ x', '+ d']);
  });

  it('the command plans and writes with --expect, and refuses a bad fingerprint', t => {
    const local = fixture(t, base());
    const planned = main(['plan', '--local', local, '--fingerprint', fingerprint, '--date', date]);
    assert.equal(planned.code, 0);
    const digest = (JSON.parse(planned.output) as { digest: string }).digest;
    const written = main(['write', '--local', local, '--fingerprint', fingerprint, '--date', date, '--expect', digest]);
    assert.equal(written.code, 0);
    assert.ok(readFileSync(exportedDir(local, 'PROJ-1-1'), 'utf8'));
    assert.throws(() => main(['plan', '--local', local, '--fingerprint', 'sha256:xyz']), /--fingerprint|Usage/);
  });
});
