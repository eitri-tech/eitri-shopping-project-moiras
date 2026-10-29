import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { addPending, knowledgeIndex, main, pendingKeys, readPending, selectItems, type Selection } from './learn-git.ts';
import { check, gitSource, issues } from './knowledge.ts';
import { adapterFor, adapters, type Pull } from './providers.ts';

const repo = 'acme-shop-checkout';
const slug = `acme/${repo}`;
const github = (raw: Record<string, unknown>): Pull => adapters.github.pull(raw, 'acme', repo)!;
const bitbucket = (raw: Record<string, unknown>): Pull => adapters.bitbucket.pull(raw, 'acme', repo)!;
const pull = (number: number, extra: Record<string, unknown> = {}) => github({
  number, title: `Keep the orderFormId (${number})`, url: `https://github.com/acme/${repo}/pull/${number}`, state: 'MERGED',
  mergedAt: '2026-10-10T12:00:00Z', headRefName: `fix/${number}`, labels: [{ name: 'bug' }], body: 'Reuses the id.', ...extra,
});
/** A PR closed without merge: its closing date and, when given, its comments. */
const closed = (number: number, extra: Record<string, unknown> = {}) => pull(number, {
  state: 'CLOSED', mergedAt: null, closedAt: '2026-10-10T12:00:00Z', title: `Cache the seller list (${number})`, body: 'Caches it.', ...extra,
});
const refs = (selection: Selection) => selection.candidates.map(item => item.ref);
const reasons = (selection: Selection) => Object.fromEntries(selection.skipped.map(item => [item.ref, item.reason]));
const options = { owner: 'acme', repository: repo };
const tmp = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-learn-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const record = (dir: string, relative: string, body: string) => {
  mkdirSync(dirname(join(dir, relative)), { recursive: true });
  writeFileSync(join(dir, relative), body);
};

describe('providers', () => {
  it('maps GitHub and Bitbucket states to the normalized ones', () => {
    assert.equal(github({ number: 1, state: 'MERGED' }).state, 'merged');
    assert.equal(github({ number: 1, state: 'CLOSED' }).state, 'closed');
    assert.equal(github({ number: 1, state: 'OPEN' }).state, 'open');
    assert.equal(bitbucket({ id: 1, state: 'MERGED' }).state, 'merged');
    assert.equal(bitbucket({ id: 1, state: 'DECLINED' }).state, 'closed');
    assert.equal(bitbucket({ id: 1, state: 'SUPERSEDED' }).state, 'superseded');
    assert.equal(bitbucket({ id: 1, state: 'OPEN' }).state, 'open');
  });

  it('reads the closing links of GitHub only for the same owner and repository', () => {
    const other = { number: 4, url: 'https://github.com/other/x/issues/4', repository: { name: 'x', owner: { login: 'other' } } };
    const own = { number: 3, url: `https://github.com/acme/${repo}/issues/3`, repository: { name: repo, owner: { login: 'acme' } } };
    assert.deepEqual(github({ number: 1, closingIssuesReferences: [other, own] }).closes, [3]);
  });

  it('gives Bitbucket PRs no closing links and no labels, and reads the comments the reader fetched', () => {
    const pr = bitbucket({ id: 2, state: 'DECLINED', updated_on: '2026-10-10T12:00:00Z', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/2` } }, source: { branch: { name: 'feat/2' } }, comments: [{ created_on: '2026-10-08T12:00:00Z', content: { raw: 'Não seguimos.' } }] });
    assert.deepEqual([pr.closes, pr.labels, pr.closedAt, pr.branch], [[], [], '2026-10-10T12:00:00Z', 'feat/2']);
    assert.deepEqual(pr.discussion, [{ kind: 'comment', at: '2026-10-08T12:00:00Z', text: 'Não seguimos.' }]);
  });

  it('normalizes Bitbucket timestamps with an offset to UTC, so a merged PR is not dropped', () => {
    const merged = { id: 12, title: 'Keep the orderFormId', state: 'MERGED', updated_on: '2026-10-10T12:00:00+00:00', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/12` } }, comments: [{ created_on: '2026-10-09T09:30:00-03:00', content: { raw: 'Ok.' } }] };
    const pr = bitbucket(merged);
    assert.deepEqual([pr.mergedAt, pr.discussion[0]!.at], ['2026-10-10T12:00:00Z', '2026-10-09T12:30:00Z']);
    const selection = selectItems({ pulls: [pr] }, { provider: 'bitbucket', ...options });
    assert.deepEqual(refs(selection), [`${slug}#12`]);
    assert.equal(selection.candidates[0]!.closed_at, '2026-10-10T12:00:00Z');
  });

  it('refuses an unknown provider', () => {
    assert.throws(() => adapterFor('gitlab'), /Unknown provider/);
    assert.equal(adapterFor('bitbucket').pullUrl('acme', repo, 7), `https://bitbucket.org/acme/${repo}/pull-requests/7`);
  });
});

describe('merged PRs and rejected approaches', () => {
  it('a merged PR is a solution, and a PR closed without merge is not one without a reason', () => {
    const selection = selectItems({ pulls: [pull(1), closed(2)] }, options);
    assert.deepEqual(refs(selection), [`${slug}#1`]);
    assert.equal(selection.candidates[0]!.outcome, 'resolved');
    assert.deepEqual(reasons(selection), { [`${slug}#2`]: 'not-merged' });
  });

  it('only a merged revert invalidates a solution: an open or closed revert leaves the original', () => {
    const original = pull(20);
    const openRevert = pull(21, { state: 'OPEN', mergedAt: null, title: 'Revert "Keep the orderFormId (20)"', body: 'This reverts #20.' });
    const closedRevert = closed(22, { title: 'Reverte o #20', body: 'Reverte o #20.' });
    const kept = selectItems({ pulls: [original, openRevert, closedRevert] }, options);
    assert.deepEqual(refs(kept).sort(), [`${slug}#20`]);
    assert.equal(kept.candidates[0]!.outcome, 'resolved');
    const mergedRevert = pull(23, { title: 'Revert "Keep the orderFormId (20)"', body: 'This reverts #20.' });
    const reverted = selectItems({ pulls: [original, mergedRevert] }, options);
    assert.deepEqual(reasons(reverted), { [`${slug}#20`]: 'reverted', [`${slug}#23`]: 'is-revert' });
  });

  it('a comment of the week before the closing is the explicit reason: a rejected approach, never a solution', () => {
    const selection = selectItems({ pulls: [closed(5, { comments: [{ createdAt: '2026-10-08T12:00:00Z', body: 'Não vamos seguir: quebra a troca de seller.' }] })] }, options);
    assert.equal(selection.candidates.length, 1);
    const [candidate] = selection.candidates;
    assert.equal(candidate!.outcome, 'rejected');
    assert.equal(candidate!.kind, 'pr');
    assert.equal(candidate!.reason_kind, 'comment');
    assert.equal(candidate!.reason_at, '2026-10-08T12:00:00Z');
    assert.equal(candidate!.closed_at, '2026-10-10T12:00:00Z');
    assert.ok(!JSON.stringify(selection).includes('quebra'), 'the reason text is never printed');
  });

  it('a review counts as the reason too', () => {
    const selection = selectItems({ pulls: [closed(5, { reviews: [{ submittedAt: '2026-10-09T12:00:00Z', body: 'Abordagem errada: o problema está no seller.' }] })] }, options);
    assert.equal(selection.candidates[0]!.reason_kind, 'review');
  });

  it('a comment older than the window, or with no date, gives no reason', () => {
    const selection = selectItems({ pulls: [closed(6, { comments: [{ createdAt: '2026-09-01T12:00:00Z', body: 'Talvez' }, { body: 'Sem data' }] })] }, options);
    assert.deepEqual(refs(selection), []);
    assert.deepEqual(reasons(selection), { [`${slug}#6`]: 'not-merged' });
  });

  it('a PR that another PR replaces says so at the start of a line, and that is its reason', () => {
    const selection = selectItems({ pulls: [closed(5), pull(6, { state: 'OPEN', mergedAt: null, body: 'Replaces #5\n\nVai pelo outro caminho.' })] }, options);
    assert.equal(selection.candidates.length, 1);
    assert.equal(selection.candidates[0]!.reason_kind, 'superseded');
    assert.equal(selection.candidates[0]!.superseded_by, `${slug}#6`);
  });

  it('a mention of a number in the middle of a sentence is not a replacement', () => {
    const selection = selectItems({ pulls: [closed(5), closed(8, { body: 'This change replaces the #5 logic in part.' })] }, options);
    assert.deepEqual(refs(selection), []);
    assert.equal(reasons(selection)[`${slug}#5`], 'not-merged');
  });

  it('a superseded PR (Bitbucket) with no reason stays out as no-reason; with a comment it is a rejected approach', () => {
    const plain = { id: 9, title: 'Cache', state: 'SUPERSEDED', updated_on: '2026-10-10T12:00:00Z', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/9` } } };
    const bare = selectItems({ pulls: [bitbucket(plain)] }, { provider: 'bitbucket', ...options });
    assert.deepEqual(reasons(bare), { [`${slug}#9`]: 'no-reason' });
    const explained = selectItems({ pulls: [bitbucket({ ...plain, comments: [{ created_on: '2026-10-09T12:00:00Z', content: { raw: 'Substituído pelo outro.' } }] })] }, { provider: 'bitbucket', ...options });
    assert.equal(explained.candidates[0]!.reason_kind, 'comment');
  });

  it('a rejected PR still goes through the revert and secret rules', () => {
    const token = `ghp_${'a'.repeat(30)}`;
    const selection = selectItems({ pulls: [
      closed(10, { title: 'Revert the cache change', comments: [{ createdAt: '2026-10-09T12:00:00Z', body: 'Não.' }] }),
      closed(11, { comments: [{ createdAt: '2026-10-09T12:00:00Z', body: `use ${token}` }] }),
    ] }, options);
    assert.deepEqual(reasons(selection), { [`${slug}#10`]: 'is-revert', [`${slug}#11`]: 'secret' });
    assert.ok(!JSON.stringify(selection).includes(token));
  });

  it('a rejected PR that is already known (its record cites the PR URL) is not proposed again', t => {
    const dir = tmp(t);
    record(dir, 'learnings/decisions/acme-shop-checkout-pr-5.md', `---\nid: acme-shop-checkout-pr-5\ntype: decision\ncreated_at: 2026-10-12\noutcome: rejected\nreason: Caches the seller list and breaks the switch.\nreference_url: https://github.com/acme/${repo}/pull/5\nimported_from: git\n---\n\n# Do not cache the seller list\n\n**Decisão:** keep the list live.\n`);
    assert.deepEqual(check(dir, 'learnings').findings, []);
    const known = knowledgeIndex([dir]);
    assert.ok(known.known.has(`${slug}#5`));
    const selection = selectItems({ pulls: [closed(5, { comments: [{ createdAt: '2026-10-08T12:00:00Z', body: 'Não.' }] })] }, { ...options, known: known.known, ids: known.ids });
    assert.deepEqual(reasons(selection), { [`${slug}#5`]: 'already-known' });
    assert.deepEqual(issues([dir]).issues[`${slug}#5`], { solutions: [], patterns: [], decisions: ['acme-shop-checkout-pr-5'] });
  });
});

describe('Bitbucket in the same format', () => {
  it('takes a merged Bitbucket PR as a solution, with its own provider and reference', () => {
    const pr = { id: 7, title: 'Keep the orderFormId', description: 'Reuses the id.', state: 'MERGED', updated_on: '2026-10-11T12:00:00Z', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/7` } }, source: { branch: { name: 'feat/7' } } };
    const selection = selectItems({ pulls: [bitbucket(pr)] }, { provider: 'bitbucket', ...options });
    assert.equal(selection.provider, 'bitbucket');
    assert.deepEqual(refs(selection), [`${slug}#7`]);
    assert.equal(selection.candidates[0]!.provider, 'bitbucket');
    assert.equal(selection.candidates[0]!.outcome, 'resolved');
  });

  it('refuses a Bitbucket PR that belongs to another workspace or repository', () => {
    const pr = { id: 7, title: 'x', state: 'MERGED', updated_on: '2026-10-11T12:00:00Z', links: { html: { href: 'https://bitbucket.org/other/x/pull-requests/7' } } };
    assert.deepEqual(reasons(selectItems({ pulls: [bitbucket(pr)] }, { provider: 'bitbucket', ...options })), { [`${slug}#7`]: 'invalid' });
  });

  it('turns a declined Bitbucket PR with a comment into a rejected approach', () => {
    const pr = { id: 4, title: 'Cache the list', state: 'DECLINED', updated_on: '2026-10-10T12:00:00Z', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/4` } }, comments: [{ created_on: '2026-10-09T12:00:00Z', content: { raw: 'Fechando, não é o caminho.' } }] };
    const selection = selectItems({ pulls: [bitbucket(pr)] }, { provider: 'bitbucket', ...options });
    assert.equal(selection.candidates[0]!.outcome, 'rejected');
    assert.equal(selection.candidates[0]!.url, `https://bitbucket.org/acme/${repo}/pull-requests/4`);
  });

  it('builds the candidates from the command line with --provider, and refuses issues from a provider without them', () => {
    const input = JSON.stringify({ pulls: [{ id: 7, title: 'Keep', state: 'MERGED', updated_on: '2026-10-11T12:00:00Z', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/7` } } }] });
    const parsed = JSON.parse(main(['eligible', '--provider', 'bitbucket', '--repo', slug], input).output);
    assert.deepEqual(parsed.candidates.map((item: { ref: string; provider: string }) => [item.ref, item.provider]), [[`${slug}#7`, 'bitbucket']]);
    assert.throws(() => main(['eligible', '--provider', 'bitbucket', '--repo', slug], JSON.stringify({ pulls: [], issues: [{}] })), /Usage/);
    assert.throws(() => main(['eligible', '--provider', 'gitlab', '--repo', slug], '{"pulls":[]}'), /Unknown provider/);
  });

  it('accepts the provider name in the GitHub source URL check', () => {
    assert.equal(gitSource(`https://bitbucket.org/acme/${repo}/pull-requests/7`), `bitbucket:${slug}#7`);
    assert.equal(gitSource(`https://github.com/acme/${repo}/pull/7`), `${slug}#7`);
    assert.equal(gitSource('https://bitbucket.org/acme/x/pull-requests/7/extra'), undefined);
  });
});

describe('identity across providers', () => {
  const bbPull = (number: number) => bitbucket({ id: number, title: 'Keep the orderFormId', state: 'MERGED', updated_on: '2026-10-10T12:00:00Z', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/${number}` } } });

  it('the same owner, repository and number on two providers are two different learnings', () => {
    assert.equal(gitSource(`https://github.com/acme/${repo}/pull/5`), `${slug}#5`);
    assert.equal(gitSource(`https://bitbucket.org/acme/${repo}/pull-requests/5`), `bitbucket:${slug}#5`);
    const fromBitbucket = selectItems({ pulls: [pull(5)] }, { ...options, known: new Set([`bitbucket:${slug}#5`]) });
    assert.deepEqual(refs(fromBitbucket), [`${slug}#5`]);
    const fromGithub = selectItems({ pulls: [bbPull(5)] }, { provider: 'bitbucket', ...options, known: new Set([`${slug}#5`]) });
    assert.deepEqual(refs(fromGithub), [`${slug}#5`]);
    assert.equal(fromGithub.candidates[0]!.key, `bitbucket:${slug}#5`);
  });

  it('a GitHub reference without a provider is GitHub: the first version of the form still counts as known', () => {
    const legacy = selectItems({ pulls: [pull(5)] }, { ...options, known: new Set([`${repo}#5`]) });
    assert.deepEqual(reasons(legacy), { [`${slug}#5`]: 'already-known' });
  });

  it('a pending Bitbucket item does not hide the GitHub PR with the same number', t => {
    const dir = tmp(t);
    addPending(dir, selectItems({ pulls: [bbPull(5)] }, { provider: 'bitbucket', ...options }).candidates, '2026-10-20T00:00:00Z');
    const pending = pendingKeys(dir);
    assert.deepEqual(refs(selectItems({ pulls: [pull(5)] }, { ...options, pending })), [`${slug}#5`]);
    assert.deepEqual(reasons(selectItems({ pulls: [bbPull(5)] }, { provider: 'bitbucket', ...options, pending })), { [`${slug}#5`]: 'already-pending' });
  });
});

describe('pending list with providers', () => {
  it('keeps the outcome of a rejected approach and tells providers with the same reference apart', t => {
    const dir = tmp(t);
    const rejected = selectItems({ pulls: [closed(5, { comments: [{ createdAt: '2026-10-08T12:00:00Z', body: 'Não.' }] })] }, options).candidates;
    addPending(dir, rejected, '2026-10-20T00:00:00Z');
    addPending(dir, rejected, '2026-10-21T00:00:00Z');
    const other = selectItems({ pulls: [bitbucket({ id: 5, title: 'x', state: 'DECLINED', updated_on: '2026-10-10T12:00:00Z', links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/5` } }, comments: [{ created_on: '2026-10-08T12:00:00Z', content: { raw: 'Não.' } }] })] }, { provider: 'bitbucket', ...options }).candidates;
    addPending(dir, other, '2026-10-22T00:00:00Z');
    const items = readPending(dir);
    assert.equal(items.length, 2);
    assert.equal(items[0]!.outcome, 'rejected');
    assert.equal(items[0]!.provider, undefined);
    assert.equal(items[1]!.provider, 'bitbucket');
  });
});

describe('the rejected approach record in the knowledge check', () => {
  const header = (extra: string) => `---\nid: acme-shop-checkout-pr-5\ntype: decision\ncreated_at: 2026-10-12\n${extra}---\n\n# Do not cache the seller list\n\n**Decisão:** keep the list live.\n`;
  const good = 'outcome: rejected\nreason: Caches the seller list and breaks the switch.\nreference_url: https://github.com/acme/acme-shop-checkout/pull/5\nimported_from: git\n';
  const findingsOf = (t: TestContext, extra: string) => {
    const dir = tmp(t);
    record(dir, 'learnings/decisions/acme-shop-checkout-pr-5.md', header(extra));
    return check(dir, 'learnings').findings.map(finding => finding.rule).sort();
  };

  it('accepts a rejected approach with reason, source URL and imported_from git, and no source', t => {
    assert.deepEqual(findingsOf(t, good), []);
  });

  it('requires the reason, a valid source URL, imported_from git and a short reason', t => {
    assert.deepEqual(findingsOf(t, good.replace(/reason: .*\n/, '')), ['reason-missing']);
    assert.deepEqual(findingsOf(t, good.replace(/reason: .*\n/, `reason: ${'x'.repeat(301)}\n`)), ['reason-too-long']);
    assert.deepEqual(findingsOf(t, good.replace(/reference_url: .*\n/, '')), ['reference-url-missing']);
    assert.deepEqual(findingsOf(t, good.replace(/reference_url: .*\n/, 'reference_url: http://github.com/acme/x/pull/5\n')), ['reference-url-invalid', 'reference-url-missing']);
    assert.deepEqual(findingsOf(t, good.replace('imported_from: git', 'imported_from: github')), ['rejected-import-invalid']);
  });

  it('keeps the outcome to decisions, and a decision without outcome still needs its source', t => {
    assert.deepEqual(findingsOf(t, 'outcome: maybe\n'), ['field-missing', 'outcome-invalid']);
    assert.deepEqual(findingsOf(t, 'imported_from: git\nreference_url: https://github.com/acme/acme-shop-checkout/pull/5\n'), ['field-missing']);
  });

  it('a git-imported solution needs its source URL too', t => {
    const dir = tmp(t);
    record(dir, 'learnings/solutions/acme-shop-checkout-pr-7.md', `---\nid: acme-shop-checkout-pr-7\ntype: solution\nissue: acme-shop-checkout#7\nchosen_by: reviewer-01\nrepositories: [acme-shop-checkout]\ncategory: bug\nconfidence: 70\nresult: resolved\ncreated_at: 2026-10-12\nimported_from: git\n---\n\n# Keep the id\n\n**Problema:** x.\n`);
    assert.deepEqual(check(dir, 'learnings').findings.map(finding => finding.rule), ['reference-url-missing']);
  });
});

describe('selection holds the watermark and the shape of solutions', () => {
  it('moves the PR watermark with the newest merged or rejected PR, and keeps the rest of the shape', () => {
    const selection = selectItems({ pulls: [closed(5, { closedAt: '2026-10-12T12:00:00Z', comments: [{ createdAt: '2026-10-11T12:00:00Z', body: 'Não.' }] })] }, options);
    assert.equal(selection.watermark.pr, '2026-10-12T12:00:00Z');
    assert.deepEqual(Object.keys(selection.candidates[0]!).sort(), ['closed_at', 'key', 'kind', 'outcome', 'provider', 'ref', 'reason_at', 'reason_kind', 'suggested_id', 'url'].sort());
  });
});
