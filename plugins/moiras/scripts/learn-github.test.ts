import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { addPending, auto, autoDisposition, main, readPending, readWatermark, removePending, revalidate, scan, select, writeWatermark } from './learn-github.ts';
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
// What `gh pr list --json closingIssuesReferences` returns for one closed issue.
const closing = (number: number, owner = 'acme', name = repo) => ({ number, url: `https://github.com/${owner}/${name}/issues/${number}`, repository: { name, owner: { login: owner } } });
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
    assert.deepEqual(refs(selection), [`${slug}#1`, `${slug}#10`]);
    assert.deepEqual(reasons(selection), { [`${slug}#2`]: 'no-reason', [`${slug}#3`]: 'not-merged',[`${slug}#11`]: 'not-completed', [`${slug}#12`]: 'not-completed', [`${slug}#13`]: 'not-completed' });
  });

  it('skips reverted PRs and the revert PRs themselves, even when the revert is outside the period', () => {
    const selection = select({ prs: [
      pull(1), pull(2), pull(3),
      pull(4, { title: 'Revert "Keep the orderFormId (1)"', mergedAt: '2026-11-20T12:00:00Z' }),
      pull(5, { title: 'Undo the change', body: 'This reverts #2.' }),
      pull(6, { title: 'Revert the checkout change', body: 'Reverts #3', mergedAt: '2026-10-20T12:00:00Z' }),
    ] }, { owner: 'acme', repository: repo, until: '2026-10-31' });
    assert.deepEqual(refs(selection), []);
    assert.equal(reasons(selection)[`${slug}#5`], 'is-revert');
    assert.equal(reasons(selection)[`${slug}#1`], 'reverted');
    assert.equal(reasons(selection)[`${slug}#3`], 'reverted');
    assert.equal(reasons(selection)[`${slug}#4`], 'is-revert');
    assert.equal(reasons(selection)[`${slug}#6`], 'is-revert');
  });

  it('detects reverts written in Portuguese, in the title or in the body, in any case', () => {
    // The real case (titles of the PRs #58 and #59 of this repository): #59 undoes #58.
    const real = select({ prs: [pull(58, { title: 'Require English for PRs, commits and health issues' }), pull(59, { title: 'Reverte o #58: PRs voltam a ser em português', mergedAt: '2026-10-12T12:00:00Z' })] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(real), []);
    assert.equal(reasons(real)[`${slug}#58`], 'reverted');
    assert.equal(reasons(real)[`${slug}#59`], 'is-revert');
    const variants: [string, string][] = [
      ['Reverter o #1', ''], ['REVERTENDO #1', ''], ['Desfaz o #1', ''], ['desfazer #1: ajuste', ''], ['Reverte #1', ''],
      ['Ajuste de volta', 'reverte o #1'], ['Ajuste de volta', 'Desfaz o #1 por causa de um erro'], ['Ajuste de volta', 'Esta PR REVERTE #1'], ['Ajuste de volta', 'Desfazer o #1'],
    ];
    for (const [title, body] of variants) {
      const selection = select({ prs: [pull(1), pull(2, { title, body })] }, { owner: 'acme', repository: repo });
      assert.equal(reasons(selection)[`${slug}#1`], 'reverted', `${title} / ${body}`);
      assert.ok(!refs(selection).includes(`${slug}#1`));
    }
    // A title that only looks similar is not a revert, and a bare number elsewhere does not name a PR.
    const plain = select({ prs: [pull(1), pull(2, { title: 'Reversível: novo seletor', body: 'Mantém o #1 como está.' }), pull(3, { title: 'Reverted state fix', body: 'Does not revert #1.' })] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(plain), [`${slug}#1`, `${slug}#2`, `${slug}#3`]);
  });

  it('does not learn an issue twice through the PR that closed it', () => {
    const selection = select({ prs: [pull(1, { closingIssuesReferences: [closing(10)] }), pull(2, { closingIssuesReferences: [closing(11)], title: 'Fix cart' }), pull(3, { title: 'Revert "Fix cart"' })], issues: [ticket(10), ticket(11)] }, { owner: 'acme', repository: repo });
    assert.equal(reasons(selection)[`${slug}#10`], 'covered-by-pr');
    assert.equal(reasons(selection)[`${slug}#11`], 'reverted');
    assert.deepEqual(selection.candidates[0]!.closes, [`${slug}#10`]);
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
    assert.deepEqual(refs(selection), [`${slug}#2`, `${slug}#3`]);
    assert.equal(reasons(selection)[`${slug}#1`], 'outside-period');
    assert.equal(reasons(selection)[`${slug}#4`], 'outside-period');
  });

  it('filters by label, case-insensitively, alone or with the period', () => {
    assert.deepEqual(refs(select(input, { owner: 'acme', repository: repo, labels: ['checkout'] })), [`${slug}#3`]);
    assert.deepEqual(refs(select(input, { owner: 'acme', repository: repo, labels: ['checkout', 'bug'], since: '2026-10-16' })), [`${slug}#4`]);
    assert.equal(reasons(select(input, { owner: 'acme', repository: repo, labels: ['checkout'] }))[`${slug}#2`], 'label-mismatch');
  });

  it('refuses invalid dates, repositories and shapes', () => {
    assert.throws(() => select(input, { owner: 'acme', repository: repo, since: '2026-02-30' }), /Usage:/);
    assert.throws(() => select(input, { owner: 'acme', repository: '../x' }), /Usage:/);
    assert.throws(() => select([], { owner: 'acme', repository: repo }), /Expected/);
    assert.throws(() => select({ prs: {} }, { owner: 'acme', repository: repo }), /Expected/);
  });

  it('accepts only the URL of this repository PR or issue', () => {
    const selection = select({ prs: [pull(1, { url: 'https://github.com/acme/other/pull/1' }), pull(2, { url: `https://github.com/acme/${repo}/issues/2` }), pull(3, { url: `http://github.com/acme/${repo}/pull/3` }), pull(4, { url: `https://u:p@github.com/acme/${repo}/pull/4` }), pull(5)] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${slug}#5`]);
    assert.equal(selection.skipped.filter(item => item.reason === 'invalid').length, 4);
  });

  it('checks the owner as well as the repository name in the URL', () => {
    const other = (number: number, owner: string, name = repo) => pull(number, { url: `https://github.com/${owner}/${name}/pull/${number}` });
    const selection = select({ prs: [other(1, 'acme'), other(2, 'ACME'), other(3, 'fork-owner'), other(4, 'acme', 'other-repo')] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${slug}#1`, `${slug}#2`]);
    assert.deepEqual(selection.skipped.map(item => item.reason), ['invalid', 'invalid']);
    assert.deepEqual(refs(select({ prs: [other(3, 'fork-owner')] }, { owner: 'fork-owner', repository: repo })), [`fork-owner/${repo}#3`]);
    assert.throws(() => select({ prs: [] }, { owner: '../x', repository: repo }), /Usage:/);
    assert.throws(() => main(['eligible', '--repo', repo], '{}'), /Usage:/);
    assert.throws(() => main(['eligible', '--repo', 'a/b/c'], '{}'), /Usage:/);
  });
});

describe('secrets', () => {
  it('blocks an item with a secret anywhere in its text, without echoing it', () => {
    const token = `ghp_${'a'.repeat(30)}`;
    const selection = select({ prs: [pull(1, { body: `deploy with ${token}` }), pull(2, { headRefName: 'API_KEY=abcdef123456789' }), pull(3, { files: [{ path: 'src/a.ts' }], comments: [{ body: 'password: "hunter2hunter2"' }] }), pull(4)] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${slug}#4`]);
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
    const selection = select({ prs: [pull(1), pull(2, { title: 'PROJ-9 fix' }), pull(3), pull(4)] }, { owner: 'acme', repository: repo, known: new Set([`${slug}#1`, 'PROJ-9']), pending: new Set([`${slug}#3`]) });
    assert.deepEqual(refs(selection), [`${slug}#4`]);
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
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-1.md`), solution(`${repo}-pr-1`, `${slug}#1`, `https://github.com/acme/${repo}/pull/1`));
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-2.md`), solution(`${repo}-pr-2`, `${slug}#2`, undefined));
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
    const run = (input: unknown, since?: string) => auto(input, { owner: 'acme', repository: repo, state: dir, since, limit: 100 });
    assert.throws(() => run({ prs: [pull(1)] }), /needs --since/);
    const first = run({ prs: [pull(1, { mergedAt: '2026-10-05T00:00:00Z' }), pull(2, { mergedAt: '2026-09-01T00:00:00Z' })], issues: [ticket(3, { closedAt: '2026-10-06T00:00:00Z' })] }, '2026-10-01');
    assert.deepEqual(refs(first), [`${slug}#1`, `${slug}#3`]);
    assert.equal(first.first_run, true);
    assert.deepEqual(readWatermark(dir, slug), { pr: '2026-10-05T00:00:00Z', issue: '2026-10-06T00:00:00Z' });
    const second = run({ prs: [pull(1, { mergedAt: '2026-10-05T00:00:00Z' }), pull(4, { mergedAt: '2026-10-20T00:00:00Z' })], issues: [ticket(3, { closedAt: '2026-10-06T00:00:00Z' }), ticket(5, { closedAt: '2026-10-21T00:00:00Z' })] });
    assert.deepEqual(refs(second), [`${slug}#4`, `${slug}#5`]);
    assert.equal(second.first_run, false);
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${slug}#1`, `${slug}#3`, `${slug}#4`, `${slug}#5`]);
    assert.deepEqual(run({ prs: [pull(4, { mergedAt: '2026-10-20T00:00:00Z' })] }).candidates, []);
  });

  it('only builds a pending list: no learning is written', t => {
    const dir = tmp(t);
    const state = join(dir, 'state');
    const out = auto({ prs: [pull(1)] }, { owner: 'acme', repository: repo, state, since: '2026-10-01', limit: 100 });
    assert.equal(autoDisposition, 'pending');
    assert.equal(out.disposition, 'pending');
    assert.deepEqual(readdirNames(dir), ['state']);
    assert.deepEqual(readdirNames(state), ['pending.json', 'watermark.json']);
  });

  it('does not queue blocked or ineligible items', t => {
    const dir = stateDir(t);
    auto({ prs: [pull(1, { body: `token ${'ghp_'}${'b'.repeat(30)}` }), pull(2, { state: 'CLOSED', mergedAt: null }), pull(3)] }, { owner: 'acme', repository: repo, state: dir, since: '2026-10-01', limit: 100 });
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${slug}#3`]);
    assert.ok(!readFileSync(join(dir, 'pending.json'), 'utf8').includes('ghp_'));
  });

  it('removes items from the pending list once they are approved or dropped', t => {
    const dir = stateDir(t);
    const selection = select({ prs: [pull(1), pull(2)] }, { owner: 'acme', repository: repo });
    addPending(dir, selection.candidates);
    addPending(dir, selection.candidates);
    assert.equal(readPending(dir).length, 2);
    assert.deepEqual(removePending(dir, [`${slug}#1`]).map(item => item.ref), [`${slug}#2`]);
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

describe('review fixes', () => {
  const stateDir = (t: TestContext) => join(tmp(t), 'state');
  const queue = (dir: string, input: unknown) => auto(input, { owner: 'acme', repository: repo, state: dir, since: '2026-10-01', limit: 100 });

  it('takes a pending PR off the list when a newer collection shows it was reverted', t => {
    const dir = stateDir(t);
    queue(dir, { prs: [pull(1), pull(2)], issues: [ticket(10)] });
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${slug}#1`, `${slug}#2`, `${slug}#10`]);
    // The next collection only has what is newer than the watermark: the revert, not the original PR.
    const next = queue(dir, { prs: [pull(3, { title: 'Revert "Keep the orderFormId (1)"', mergedAt: '2026-10-20T00:00:00Z' }), pull(4, { title: 'Desfaz', body: 'Reverte o #2', mergedAt: '2026-10-21T00:00:00Z' })] });
    assert.deepEqual(next.pruned.map(item => [item.ref, item.reason]), [[`${slug}#2`, 'reverted']]);
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${slug}#1`, `${slug}#10`]);
  });

  it('takes a pending item off the list when it is no longer eligible, and keeps what the data does not show', t => {
    const dir = stateDir(t);
    queue(dir, { prs: [pull(1), pull(2), pull(3), pull(5)], issues: [ticket(10), ticket(11)] });
    const data = { prs: [pull(1, { title: 'Revert "Keep the orderFormId (3)"' }), pull(2), pull(3), pull(5, { body: `token ${'ghp_'}${'c'.repeat(30)}` })], issues: [ticket(10, { stateReason: 'NOT_PLANNED' })] };
    const known = new Set([`${slug}#2`]);
    const result = revalidate(data, { owner: 'acme', repository: repo, state: dir, known });
    assert.deepEqual(result.valid, []);
    assert.deepEqual(result.removed.map(item => `${item.ref}:${item.reason}`).sort(), [`${slug}#1:is-revert`, `${slug}#10:not-completed`, `${slug}#2:already-known`, `${slug}#3:reverted`, `${slug}#5:secret`].sort());
    assert.deepEqual(result.unverified, [`${slug}#11`]);
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${slug}#11`]);
  });

  it('revalidate keeps what is still eligible and runs from the command line', t => {
    const dir = stateDir(t);
    queue(dir, { prs: [pull(1), pull(2)] });
    const out = JSON.parse(main(['revalidate', '--repo', slug, '--state', dir], JSON.stringify({ prs: [pull(1), pull(2), pull(3, { title: 'Reverte o #2' })] })).output);
    assert.deepEqual(out, { valid: [`${slug}#1`], removed: [{ ref: `${slug}#2`, kind: 'pr', reason: 'reverted' }], unverified: [] });
    assert.deepEqual(readPending(dir).map(item => item.ref), [`${slug}#1`]);
    assert.throws(() => main(['revalidate', '--repo', slug], '{}'), /Usage:/);
  });

  it('classifies a PR as a revert by its body even when the title does not start like one', () => {
    for (const body of ['This reverts #1.', 'Reverte o #1 por causa de um erro.', 'desfaz o #1']) {
      const selection = select({ prs: [pull(1), pull(2, { title: 'Back to the old flow', body })] }, { owner: 'acme', repository: repo });
      assert.equal(reasons(selection)[`${slug}#2`], 'is-revert', body);
      assert.equal(reasons(selection)[`${slug}#1`], 'reverted', body);
      assert.deepEqual(refs(selection), []);
    }
  });

  it('scans the context read for a candidate and blocks the whole item without echoing the secret', () => {
    const token = `ghp_${'d'.repeat(30)}`;
    assert.deepEqual(scan('A review comment about the cart.'), { secret: false });
    assert.deepEqual(scan(JSON.stringify({ comments: [{ body: 'fine' }, { body: `use ${token}` }] })), { secret: true });
    assert.deepEqual(scan('API_KEY=abcdef123456789'), { secret: true });
    const clean = main(['scan'], 'Looks good to me.');
    assert.deepEqual([clean.code, JSON.parse(clean.output)], [0, { secret: false }]);
    const blocked = main(['scan'], `password: "hunter2hunter2"`);
    assert.equal(blocked.code, 1);
    assert.ok(!blocked.output.includes('hunter2'));
    assert.throws(() => main(['scan', '--repo', slug], 'x'), /Usage:/);
  });

  it('ignores closing references to another repository or owner', () => {
    const data = { prs: [pull(1, { closingIssuesReferences: [closing(10), closing(11, 'other-owner'), closing(12, 'acme', 'other-repo'), { number: 13 }, { number: 14, url: `https://github.com/other-owner/${repo}/issues/14` }, { number: 15, repository: { name: repo, owner: { login: 'acme' } }, url: `https://github.com/acme/${repo}/issues/99` }] })], issues: [10, 11, 12, 13, 14, 15].map(number => ticket(number)) };
    const selection = select(data, { owner: 'acme', repository: repo });
    assert.deepEqual(selection.candidates[0]!.closes, [`${slug}#10`]);
    assert.equal(reasons(selection)[`${slug}#10`], 'covered-by-pr');
    assert.deepEqual(refs(selection).filter(ref => ref !== `${slug}#1`), [11, 12, 13, 14, 15].map(number => `${slug}#${number}`));
  });

  it('does not move the watermark of a collection cut by --limit, and keeps what it found pending', t => {
    const dir = stateDir(t);
    const full = Array.from({ length: 3 }, (_, index) => pull(index + 1, { mergedAt: `2026-10-0${index + 1}T00:00:00Z` }));
    const cut = auto({ prs: full, issues: [ticket(10, { closedAt: '2026-10-05T00:00:00Z' })] }, { owner: 'acme', repository: repo, state: dir, since: '2026-10-01', limit: 3 });
    assert.deepEqual(cut.truncated, ['pr']);
    assert.deepEqual(readWatermark(dir, slug), { issue: '2026-10-05T00:00:00Z' });
    assert.equal(readPending(dir).length, 4);
    // A bigger limit reads everything: the watermark moves and nothing is queued twice.
    const complete = auto({ prs: full, issues: [] }, { owner: 'acme', repository: repo, state: dir, limit: 100 });
    assert.deepEqual(complete.truncated, []);
    assert.deepEqual(readWatermark(dir, slug).pr, '2026-10-03T00:00:00Z');
    assert.equal(readPending(dir).length, 4);
    const out = JSON.parse(main(['eligible', '--repo', slug, '--limit', '3'], JSON.stringify({ prs: full, issues: [] })).output);
    assert.deepEqual(out.truncated, ['pr']);
    assert.throws(() => main(['auto', '--repo', slug, '--state', dir, '--since', '2026-10-01'], '{}'), /Usage:/);
    assert.throws(() => main(['auto', '--repo', slug, '--state', dir, '--limit', '0'], '{}'), /Usage:/);
  });

  it('treats a negated verb as no revert, in Portuguese and in English', () => {
    for (const body of ['Não desfaz o #1, só ajusta o layout.', 'não reverte o #1', 'Nao reverter #1', 'This does not reverts #1', 'It never reverts #1', "doesn't reverts #1"]) {
      const selection = select({ prs: [pull(1), pull(2, { title: 'Ajuste de layout', body })] }, { owner: 'acme', repository: repo });
      assert.deepEqual(refs(selection), [`${slug}#1`, `${slug}#2`], body);
    }
  });

  it('does not take a number of another repository as the reverted PR', () => {
    const selection = select({ prs: [pull(1), pull(2, { title: 'Ajuste', body: 'Reverte acme/other-repo#1 e o outro#1.' })] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`${slug}#1`, `${slug}#2`]);
  });

  it('uses owner/repository#n in refs and still reads the old repository#n', t => {
    const dir = stateDir(t);
    const selection = select({ prs: [pull(1), pull(2)], issues: [ticket(3)] }, { owner: 'acme', repository: repo });
    assert.deepEqual(refs(selection), [`acme/${repo}#1`, `acme/${repo}#2`, `acme/${repo}#3`]);
    // Known and pending in the old format (no owner) still count; another owner's ref does not.
    const old = select({ prs: [pull(1), pull(2), pull(4)] }, { owner: 'acme', repository: repo, known: new Set([`${repo}#1`, `other/${repo}#4`]), pending: new Set([`${repo}#2`]) });
    assert.deepEqual(refs(old), [`acme/${repo}#4`]);
    assert.deepEqual(old.skipped.map(item => item.reason), ['already-known', 'already-pending']);
    writeFileSync(join(mkdirSync(dir, { recursive: true }) ?? dir, 'pending.json'), JSON.stringify({ version: 1, items: [{ kind: 'pr', ref: `${repo}#7`, url: `https://github.com/acme/${repo}/pull/7`, closed_at: '2026-10-10T12:00:00Z', added_at: '2026-10-11T00:00:00Z' }] }));
    assert.deepEqual(addPending(dir, select({ prs: [pull(7)] }, { owner: 'acme', repository: repo }).candidates).map(item => item.ref), [`${repo}#7`]);
    assert.deepEqual(removePending(dir, [`acme/${repo}#7`]), []);
  });

  it('accepts owner/repository#n as the issue of a record', t => {
    const dir = tmp(t);
    mkdirSync(join(dir, 'learnings/solutions'), { recursive: true });
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-1.md`), solution(`${repo}-pr-1`, `acme/${repo}#1`, `https://github.com/acme/${repo}/pull/1`));
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-2.md`), solution(`${repo}-pr-2`, `${repo}#2`, `https://github.com/acme/${repo}/pull/2`));
    writeFileSync(join(dir, `learnings/solutions/${repo}-pr-3.md`), solution(`${repo}-pr-3`, `a/b/c#3`, `https://github.com/acme/${repo}/pull/3`));
    assert.deepEqual(check(dir, 'learnings').findings.map(item => `${item.path.split('/').pop()}:${item.rule}`), [`${repo}-pr-3.md:issue-invalid`]);
    // The source URL adds the canonical `owner/repository#n` of each record to the issue it names.
    assert.deepEqual(Object.keys(issues(dir).issues).sort(), [`${repo}#2`, `acme/${repo}#1`, `acme/${repo}#2`]);
  });
});

describe('dedup by the source URL', () => {
  it('keeps a PR known when the Jira key of its record is gone from the title and the branch', t => {
    const dir = tmp(t);
    const local = join(dir, 'local');
    mkdirSync(join(local, 'learnings/solutions'), { recursive: true });
    // First run: the PR carries the Jira key, so the record's `issue` is the key and the PR is only in `reference_url`.
    const first = select({ prs: [pull(7, { title: 'PROJ-5 keep the orderFormId', headRefName: 'fix/PROJ-5-cart' })] }, { owner: 'acme', repository: repo });
    assert.equal(first.candidates[0]!.jira_key, 'PROJ-5');
    writeFileSync(join(local, `learnings/solutions/${first.candidates[0]!.suggested_id}.md`), solution(first.candidates[0]!.suggested_id, 'PROJ-5', first.candidates[0]!.url));
    assert.deepEqual(check(local, 'learnings').findings, []);
    assert.deepEqual(issues(local).issues[`acme/${repo}#7`], { solutions: [first.candidates[0]!.suggested_id], patterns: [] });
    // Second run: the title and branch no longer have the key (renamed PR), but the PR is still the one the record cites.
    const renamed = { prs: [pull(7, { title: 'Keep the orderFormId', headRefName: 'fix/cart' })] };
    const second = JSON.parse(main(['eligible', '--repo', slug, '--knowledge', local], JSON.stringify(renamed)).output);
    assert.deepEqual(second.candidates, []);
    assert.deepEqual(second.skipped, [{ ref: `${slug}#7`, kind: 'pr', reason: 'already-known' }]);
    // Another PR of the same repository is still new, and so is the same number in another owner's repository.
    const other = JSON.parse(main(['eligible', '--repo', slug, '--knowledge', local], JSON.stringify({ prs: [pull(8)] })).output);
    assert.deepEqual(other.candidates.map((item: { ref: string }) => item.ref), [`${slug}#8`]);
    const fork = select({ prs: [pull(7, { url: `https://github.com/fork-owner/${repo}/pull/7` })] }, { owner: 'fork-owner', repository: repo, known: new Set(Object.keys(issues(local).issues)) });
    assert.equal(fork.candidates.length, 1);
  });

  it('indexes only GitHub PR and issue URLs, case-insensitively for the owner and repository', t => {
    const dir = tmp(t);
    mkdirSync(join(dir, 'learnings/solutions'), { recursive: true });
    writeFileSync(join(dir, 'learnings/solutions/a.md'), solution('a', 'PROJ-1', `https://github.com/Acme/${repo}/issues/3`));
    writeFileSync(join(dir, 'learnings/solutions/b.md'), solution('b', 'PROJ-2', 'https://example.com/acme/x/pull/4'));
    assert.deepEqual(Object.keys(issues(dir).issues).sort(), [`Acme/${repo}#3`, 'PROJ-1', 'PROJ-2']);
    const selection = select({ issues: [ticket(3)] }, { owner: 'acme', repository: repo, known: new Set(Object.keys(issues(dir).issues)) });
    assert.deepEqual(selection.skipped.map(item => item.reason), ['already-known']);
  });

  it('does not index the URL of a record that fails the check', t => {
    const dir = tmp(t);
    mkdirSync(join(dir, 'learnings/solutions'), { recursive: true });
    writeFileSync(join(dir, 'learnings/solutions/bad.md'), solution('bad', 'PROJ-1', `https://github.com/acme/${repo}/pull/9`).replace('confidence: 60', 'confidence: 600'));
    assert.deepEqual(issues(dir).issues, {});
  });
});

describe('command line', () => {
  it('runs eligible, watermark and pending, and rejects bad arguments', t => {
    const dir = join(tmp(t), 'state');
    const eligible = JSON.parse(main(['eligible', '--repo', slug, '--label', 'bug', '--since', '2026-10-01'], JSON.stringify({ prs: [pull(1)] })).output);
    assert.equal(eligible.candidates[0].ref, `${slug}#1`);
    const done = JSON.parse(main(['auto', '--repo', slug, '--state', dir, '--limit', '100', '--since', '2026-10-01'], JSON.stringify({ prs: [pull(1)] })).output);
    assert.equal(done.disposition, 'pending');
    assert.deepEqual(JSON.parse(main(['watermark', 'get', '--state', dir, '--repo', slug]).output), { pr: '2026-10-10T12:00:00Z' });
    assert.deepEqual(JSON.parse(main(['watermark', 'set', '--state', dir, '--repo', slug, '--issue', '2026-10-02T00:00:00Z']).output), { pr: '2026-10-10T12:00:00Z', issue: '2026-10-02T00:00:00Z' });
    assert.equal(JSON.parse(main(['pending', 'list', '--state', dir]).output).items.length, 1);
    assert.deepEqual(JSON.parse(main(['pending', 'remove', '--state', dir, '--ref', `${slug}#1`]).output).items, []);
    for (const argv of [[], ['eligible'], ['auto', '--repo', slug], ['watermark', 'get', '--state', dir], ['pending', 'remove', '--state', dir], ['pending', 'list', '--state', dir, '--ref', 'x'], ['eligible', '--repo', slug, '--after', 'ontem'], ['nope']]) {
      assert.throws(() => main(argv, '{}'), /Usage:/, argv.join(' '));
    }
    assert.throws(() => main(['eligible', '--repo', slug], 'not json'), /Invalid JSON/);
  });
});
