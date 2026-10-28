import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { addPending, auto, autoDisposition, main, readPending, readWatermark, removePending, select, writeWatermark } from './learn-github.ts';
import { check, issues } from './knowledge.ts';

const repo = 'acme-shop-checkout';
const slug = `acme/${repo}`;
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `Keep the orderFormId (${number})`, url: `https://github.com/acme/${repo}/pull/${number}`, state: 'MERGED',
  mergedAt: '2026-10-10T12:00:00Z', headRefName: `fix/${number}`, labels: [{ name: 'bug' }], body: 'Reuses the id.', ...extra,
});
const ticket = (number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `Cart loses items (${number})`, url: `https://github.com/acme/${repo}/issues/${number}`, state: 'CLOSED', stateReason: 'COMPLETED',
  closedAt: '2026-10-11T12:00:00Z', labels: [{ name: 'bug' }], body: 'Items vanish.', ...extra,
});
const reasons = (selection: ReturnType<typeof select>) => Object.fromEntries(selection.skipped.map(item => [item.ref, item.reason]));
const refs = (selection: ReturnType<typeof select>) => selection.candidates.map(item => item.ref);
const tmp = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-learn-github-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('which sources count', () => {
  it('takes merged PRs and issues closed as completed, and nothing else', () => {
    const selection = select({
      prs: [pull(1), pull(2, { state: 'CLOSED', mergedAt: null }), pull(3, { state: 'OPEN', mergedAt: null })],
      issues: [ticket(10), ticket(11, { stateReason: 'NOT_PLANNED' }), ticket(12, { stateReason: 'DUPLICATE' }), ticket(13, { state: 'OPEN', stateReason: null })],
    }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${repo}#1`, `${repo}#10`]);
    assert.deepEqual(reasons(selection), { [`${repo}#2`]: 'not-merged', [`${repo}#3`]: 'not-merged', [`${repo}#11`]: 'not-completed', [`${repo}#12`]: 'not-completed', [`${repo}#13`]: 'not-completed' });
  });

  it('skips reverted PRs and the revert PRs themselves, even when the revert is outside the period', () => {
    const selection = select({ prs: [
      pull(1), pull(2), pull(3),
      pull(4, { title: 'Revert "Keep the orderFormId (1)"', mergedAt: '2026-11-20T12:00:00Z' }),
      pull(5, { title: 'Undo the change', body: 'This reverts #2.' }),
      pull(6, { title: 'Revert the checkout change', body: 'Reverts #3', mergedAt: '2026-10-20T12:00:00Z' }),
    ] }, { owner: 'acme', repository: repo, until: '2026-10-31' });
    assert.deepEqual(refs(selection), [`${repo}#5`]);
    assert.equal(reasons(selection)[`${repo}#1`], 'reverted');
    assert.equal(reasons(selection)[`${repo}#3`], 'reverted');
    assert.equal(reasons(selection)[`${repo}#4`], 'is-revert');
    assert.equal(reasons(selection)[`${repo}#6`], 'is-revert');
  });

  it('detects reverts written in Portuguese, in the title or in the body, in any case', () => {
    // The real case: PR #59 "Reverte o #58 ..." undoes PR #58.
    const real = select({ prs: [pull(58, { title: 'Exigir inglês em PRs, commits e issues de saúde' }), pull(59, { title: 'Reverte o #58: exigir inglês em PRs', mergedAt: '2026-10-12T12:00:00Z' })] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(real), []);
    assert.equal(reasons(real)[`${repo}#58`], 'reverted');
    assert.equal(reasons(real)[`${repo}#59`], 'is-revert');
    const variants: [string, string][] = [
      ['Reverter o #1', ''], ['REVERTENDO #1', ''], ['Desfaz o #1', ''], ['desfazer #1: ajuste', ''], ['Reverte #1', ''],
      ['Ajuste de volta', 'reverte o #1'], ['Ajuste de volta', 'Desfaz o #1 por causa de um erro'], ['Ajuste de volta', 'Esta PR REVERTE #1'], ['Ajuste de volta', 'Desfazer o #1'],
    ];
    for (const [title, body] of variants) {
      const selection = select({ prs: [pull(1), pull(2, { title, body })] }, { owner: 'acme', repository: repo });
      assert.equal(reasons(selection)[`${repo}#1`], 'reverted', `${title} / ${body}`);
      assert.ok(!refs(selection).includes(`${repo}#1`));
    }
    // A title that only looks similar is not a revert, and a bare number elsewhere does not name a PR.
    const plain = select({ prs: [pull(1), pull(2, { title: 'Reversível: novo seletor', body: 'Mantém o #1 como está.' }), pull(3, { title: 'Reverted state fix', body: 'Does not revert #1.' })] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(plain), [`${repo}#1`, `${repo}#2`, `${repo}#3`]);
  });

  it('does not learn an issue twice through the PR that closed it', () => {
    const selection = select({ prs: [pull(1, { closingIssuesReferences: [{ number: 10 }] }), pull(2, { closingIssuesReferences: [{ number: 11 }], title: 'Fix cart' }), pull(3, { title: 'Revert "Fix cart"' })], issues: [ticket(10), ticket(11)] }, { owner: 'acme', repository: repo });
    assert.equal(reasons(selection)[`${repo}#10`], 'covered-by-pr');
    assert.equal(reasons(selection)[`${repo}#11`], 'reverted');
    assert.deepEqual(selection.candidates[0]!.closes, [`${repo}#10`]);
  });

  it('links the PR to a Jira key in the title or in the branch name', () => {
    const selection = select({ prs: [pull(1, { title: 'PROJ-123 keep the id' }), pull(2, { headRefName: 'fix/PROJ-124-cart' }), pull(3)] }, { owner: 'acme', repository: repo });
    assert.deepEqual(selection.candidates.map(item => item.jira_key), ['PROJ-123', 'PROJ-124', undefined]);
  });
});

describe('filters', () => {
  const input = { prs: [pull(1, { mergedAt: '2026-09-30T23:59:59Z' }), pull(2, { mergedAt: '2026-10-01T00:00:00Z' }), pull(3, { mergedAt: '2026-10-15T23:59:59Z', labels: [{ name: 'Checkout' }] }), pull(4, { mergedAt: '2026-10-16T00:00:00Z' })] };

  it('filters by period, inclusive on both ends', () => {
    const selection = select(input, { owner: 'acme', repository: repo, since: '2026-10-01', until: '2026-10-15' });
    assert.deepEqual(refs(selection), [`${repo}#2`, `${repo}#3`]);
    assert.equal(reasons(selection)[`${repo}#1`], 'outside-period');
    assert.equal(reasons(selection)[`${repo}#4`], 'outside-period');
  });

  it('filters by label, case-insensitively, alone or with the period', () => {
    assert.deepEqual(refs(select(input, { owner: 'acme', repository: repo, labels: ['checkout'] })), [`${repo}#3`]);
    assert.deepEqual(refs(select(input, { owner: 'acme', repository: repo, labels: ['checkout', 'bug'], since: '2026-10-16' })), [`${repo}#4`]);
    assert.equal(reasons(select(input, { owner: 'acme', repository: repo, labels: ['checkout'] }))[`${repo}#2`], 'label-mismatch');
  });

  it('refuses invalid dates, repositories and shapes', () => {
    assert.throws(() => select(input, { owner: 'acme', repository: repo, since: '2026-02-30' }), /Usage:/);
    assert.throws(() => select(input, { owner: 'acme', repository: '../x' }), /Usage:/);
    assert.throws(() => select([], { owner: 'acme', repository: repo }), /Expected/);
    assert.throws(() => select({ prs: {} }, { owner: 'acme', repository: repo }), /Expected/);
  });

  it('accepts only the URL of this repository PR or issue', () => {
    const selection = select({ prs: [pull(1, { url: 'https://github.com/acme/other/pull/1' }), pull(2, { url: `https://github.com/acme/${repo}/issues/2` }), pull(3, { url: `http://github.com/acme/${repo}/pull/3` }), pull(4, { url: `https://u:p@github.com/acme/${repo}/pull/4` }), pull(5)] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${repo}#5`]);
    assert.equal(selection.skipped.filter(item => item.reason === 'invalid').length, 4);
  });

  it('checks the owner as well as the repository name in the URL', () => {
    const other = (number: number, owner: string, name = repo) => pull(number, { url: `https://github.com/${owner}/${name}/pull/${number}` });
    const selection = select({ prs: [other(1, 'acme'), other(2, 'ACME'), other(3, 'fork-owner'), other(4, 'acme', 'other-repo')] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${repo}#1`, `${repo}#2`]);
    assert.deepEqual(selection.skipped.map(item => item.reason), ['invalid', 'invalid']);
    assert.deepEqual(refs(select({ prs: [other(3, 'fork-owner')] }, { owner: 'fork-owner', repository: repo })), [`${repo}#3`]);
    assert.throws(() => select({ prs: [] }, { owner: '../x', repository: repo }), /Usage:/);
    assert.throws(() => main(['eligible', '--repo', repo], '{}'), /Usage:/);
    assert.throws(() => main(['eligible', '--repo', 'a/b/c'], '{}'), /Usage:/);
  });
});

describe('secrets', () => {
  it('blocks an item with a secret anywhere in its text, without echoing it', () => {
    const token = `ghp_${'a'.repeat(30)}`;
    const selection = select({ prs: [pull(1, { body: `deploy with ${token}` }), pull(2, { headRefName: 'API_KEY=abcdef123456789' }), pull(3, { files: [{ path: 'src/a.ts' }], comments: [{ body: 'password: "hunter2hunter2"' }] }), pull(4)] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${repo}#4`]);
    assert.deepEqual(selection.skipped.map(item => item.reason), ['secret', 'secret', 'secret']);
    assert.ok(!JSON.stringify(selection).includes(token));
  });

  it('prints no text from the PR or the issue', () => {
    const selection = select({ prs: [pull(1, { title: 'Distinctive title', body: 'Distinctive body' })], issues: [ticket(2, { body: 'Another distinctive body' })] }, { owner: 'acme', repository: repo });
    assert.ok(!/istinctive/.test(JSON.stringify(selection)));
  });
});

describe('dedup', () => {
  it('skips what the knowledge cites by ref or by Jira key, and what is pending', () => {
    const selection = select({ prs: [pull(1), pull(2, { title: 'PROJ-9 fix' }), pull(3), pull(4)] }, { owner: 'acme', repository: repo, known: new Set([`${repo}#1`, 'PROJ-9']), pending: new Set([`${repo}#3`]) });
    assert.deepEqual(refs(selection), [`${repo}#4`]);
    assert.deepEqual(Object.values(reasons(selection)), ['already-known', 'already-known', 'already-pending']);
  });

  it('suggests ids that are free and unique', () => {
    const selection = select({ prs: [pull(1), pull(2)], issues: [ticket(3)] }, { owner: 'acme', repository: repo, ids: new Set([`${repo}-pr-1`]) });
    assert.deepEqual(selection.candidates.map(item => item.suggested_id), [`${repo}-pr-1-2`, `${repo}-pr-2`, `${repo}-issue-3`]);
  });

  it('running twice over the same period gives nothing new once the learnings exist', t => {
    const dir = tmp(t);
    const local = join(dir, 'local');
    const input = { prs: [pull(1), pull(2)], issues: [ticket(3)] };
    const first = select(input, { owner: 'acme', repository: repo, since: '2026-10-01' });
    assert.equal(first.candidates.length, 3);
    for (const candidate of first.candidates) {
      mkdirSync(join(local, 'learnings/solutions'), { recursive: true });
      writeFileSync(join(local, `learnings/solutions/${candidate.suggested_id}.md`), solution(candidate.suggested_id, candidate.ref, candidate.url));
    }
    assert.deepEqual(check(local, 'learnings').findings, []);
    const index = issues(local);
    const second = main(['eligible', '--repo', slug, '--since', '2026-10-01', '--knowledge', local], JSON.stringify(input));
    const parsed = JSON.parse(second.output);
    assert.deepEqual(parsed.candidates, []);
    assert.deepEqual(parsed.skipped.map((item: { reason: string }) => item.reason), ['already-known', 'already-known', 'already-known']);
    assert.deepEqual(Object.keys(index.issues).sort(), first.candidates.map(item => item.ref).sort());
  });
});

const solution = (id: string, ref: string, url: string | undefined, extra = '') => `---
id: ${id}
type: solution
issue: ${ref}
created_at: 2026-10-12
chosen_by: reviewer-01
repositories: [${repo}]
category: bug
confidence: 60
result: resolved
imported_from: github
${url ? `reference_url: ${url}\n` : ''}${extra}---

# Reaproveitar o orderFormId

**Solução:** reaproveitar o orderFormId.

**Observação:** Importado do GitHub; confira antes de publicar.
`;

describe('records from GitHub in the knowledge check', () => {
  it('accepts a repository#number origin and requires the source URL', t => {
    const dir = tmp(t);
    mkdirSync(join(dir, 'learnings/solutions'), { recursive: true });
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-1.md`), solution(`${repo}-pr-1`, `${repo}#1`, `https://github.com/acme/${repo}/pull/1`));
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-2.md`), solution(`${repo}-pr-2`, `${repo}#2`, undefined));
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-3.md`), solution(`${repo}-pr-3`, 'not a ref', `https://github.com/acme/${repo}/pull/3`));
    const findings = check(dir, 'learnings').findings.map(item => `${item.path.split('/').pop()}:${item.rule}`);
    assert.deepEqual(findings, [`${repo}-pr-2.md:reference-url-missing`, `${repo}-pr-3.md:issue-invalid`]);
  });

  it('accepts GitHub refs in the issues of a pattern', t => {
    const dir = tmp(t);
    mkdirSync(join(dir, 'learnings/patterns'), { recursive: true });
    writeFileSync(join(dir, 'learnings/patterns/p.md'), `---\nid: p\ntype: pattern\ncreated_at: 2026-10-12\nrepositories: [${repo}]\nissues: [${repo}#1, PROJ-2]\n---\n\n# Padrão\n\n**Sintoma:** itens somem.\n`);
    assert.deepEqual(check(dir, 'learnings').findings, []);
  });
});

describe('watermark and pending list', () => {
  const stateDir = (t: TestContext) => join(tmp(t), 'state');

  it('moves forward only, per repository and kind', t => {
    const dir = stateDir(t);
    assert.deepEqual(readWatermark(dir, slug), {});
    writeWatermark(dir, slug, { pr: '2026-10-10T12:00:00Z', issue: '2026-10-11T12:00:00Z' });
    assert.deepEqual(writeWatermark(dir, slug, { pr: '2026-10-01T00:00:00Z' }), { pr: '2026-10-10T12:00:00Z', issue: '2026-10-11T12:00:00Z' });
    assert.deepEqual(writeWatermark(dir, slug, { pr: '2026-10-12T00:00:00Z' }).pr, '2026-10-12T00:00:00Z');
    assert.deepEqual(readWatermark(dir, 'acme/other'), {});
    assert.throws(() => writeWatermark(dir, slug, { pr: 'yesterday' }), /Usage:/);
  });

  it('automatic runs take only what closed since the previous one', t => {
    const dir = stateDir(t);
    const run = (input: unknown, since?: string) => auto(input, { owner: 'acme', repository: repo, state: dir, since });
    assert.throws(() => run({ prs: [pull(1)] }), /needs --since/);
    const first = run({ prs: [pull(1, { mergedAt: '2026-10-05T00:00:00Z' }), pull(2, { mergedAt: '2026-09-01T00:00:00Z' })], issues: [ticket(3, { closedAt: '2026-10-06T00:00:00Z' })] }, '2026-10-01');
    assert.deepEqual(refs(first), [`${repo}#1`, `${repo}#3`]);
    assert.equal(first.first_run, true);
    assert.deepEqual(readWatermark(dir, slug), { pr: '2026-10-05T00:00:00Z', issue: '2026-10-06T00:00:00Z' });
    const second = run({ prs: [pull(1, { mergedAt: '2026-10-05T00:00:00Z' }), pull(4, { mergedAt: '2026-10-20T00:00:00Z' })], issues: [ticket(3, { closedAt: '2026-10-06T00:00:00Z' }), ticket(5, { closedAt: '2026-10-21T00:00:00Z' })] });
    assert.deepEqual(refs(second), [`${repo}#4`, `${repo}#5`]);
    assert.equal(second.first_run, false);
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${repo}#1`, `${repo}#3`, `${repo}#4`, `${repo}#5`]);
    assert.deepEqual(run({ prs: [pull(4, { mergedAt: '2026-10-20T00:00:00Z' })] }).candidates, []);
  });

  it('only builds a pending list: no learning is written', t => {
    const dir = tmp(t);
    const state = join(dir, 'state');
    const out = auto({ prs: [pull(1)] }, { owner: 'acme', repository: repo, state, since: '2026-10-01' });
    assert.equal(autoDisposition, 'pending');
    assert.equal(out.disposition, 'pending');
    assert.deepEqual(readdirNames(dir), ['state']);
    assert.deepEqual(readdirNames(state), ['pending.json', 'watermark.json']);
  });

  it('does not queue blocked or ineligible items', t => {
    const dir = stateDir(t);
    auto({ prs: [pull(1, { body: `token ${'ghp_'}${'b'.repeat(30)}` }), pull(2, { state: 'CLOSED', mergedAt: null }), pull(3)] }, { owner: 'acme', repository: repo, state: dir, since: '2026-10-01' });
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${repo}#3`]);
    assert.ok(!readFileSync(join(dir, 'pending.json'), 'utf8').includes('ghp_'));
  });

  it('removes items from the pending list once they are approved or dropped', t => {
    const dir = stateDir(t);
    const selection = select({ prs: [pull(1), pull(2)] }, { owner: 'acme', repository: repo });
    addPending(dir, selection.candidates);
    addPending(dir, selection.candidates);
    assert.equal(readPending(dir).length, 2);
    assert.deepEqual(removePending(dir, [`${repo}#1`]).map(item => item.ref), [`${repo}#2`]);
  });

  it('refuses a linked state folder or file', t => {
    const dir = tmp(t);
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    assert.throws(() => readPending(join(dir, 'link')), /refused/);
    mkdirSync(join(dir, 'state'));
    symlinkSync(join(dir, 'real'), join(dir, 'state', 'pending.json'));
    assert.throws(() => addPending(join(dir, 'state'), []), /refused/);
  });
});

const readdirNames = (dir: string) => readdirSync(dir).sort();

describe('command line', () => {
  it('runs eligible, watermark and pending, and rejects bad arguments', t => {
    const dir = join(tmp(t), 'state');
    const eligible = JSON.parse(main(['eligible', '--repo', slug, '--label', 'bug', '--since', '2026-10-01'], JSON.stringify({ prs: [pull(1)] })).output);
    assert.equal(eligible.candidates[0].ref, `${repo}#1`);
    const done = JSON.parse(main(['auto', '--repo', slug, '--state', dir, '--since', '2026-10-01'], JSON.stringify({ prs: [pull(1)] })).output);
    assert.equal(done.disposition, 'pending');
    assert.deepEqual(JSON.parse(main(['watermark', 'get', '--state', dir, '--repo', slug]).output), { pr: '2026-10-10T12:00:00Z' });
    assert.deepEqual(JSON.parse(main(['watermark', 'set', '--state', dir, '--repo', slug, '--issue', '2026-10-02T00:00:00Z']).output), { pr: '2026-10-10T12:00:00Z', issue: '2026-10-02T00:00:00Z' });
    assert.equal(JSON.parse(main(['pending', 'list', '--state', dir]).output).items.length, 1);
    assert.deepEqual(JSON.parse(main(['pending', 'remove', '--state', dir, '--ref', `${repo}#1`]).output).items, []);
    for (const argv of [[], ['eligible'], ['auto', '--repo', slug], ['watermark', 'get', '--state', dir], ['pending', 'remove', '--state', dir], ['pending', 'list', '--state', dir, '--ref', 'x'], ['eligible', '--repo', slug, '--after', 'ontem'], ['nope']]) {
      assert.throws(() => main(argv, '{}'), /Usage:/, argv.join(' '));
    }
    assert.throws(() => main(['eligible', '--repo', slug], 'not json'), /Invalid JSON/);
  });
});
