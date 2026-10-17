import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { init, main, validate } from './config.ts';
import type { Finding } from './config.ts';

const script = join(import.meta.dirname, 'config.ts');
const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', 'sources.example.json'), 'utf8'));

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'moiras-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, target: join(dir, '.moiras') };
}

const minimal = () => ({
  jira: { site: 'example.atlassian.net', epic: 'PROJ-100' },
  knowledge: [{ name: 'local', scope: 'local', dir: '.moiras/knowledge' }],
});
const rules = (config: unknown) => validate(config).map(finding => `${finding.path}:${finding.rule}:${finding.severity}`);

describe('validate', () => {
  it('accepts the shipped example and a minimal configuration', () => {
    assert.deepEqual(validate(example), []);
    assert.deepEqual(validate(minimal()), []);
  });

  it('reports a missing jira section, a bad site and a bad epic', () => {
    assert.deepEqual(rules({}), ['jira:jira-missing:warning']);
    assert.deepEqual(rules({ jira: 3 }), ['jira:not-an-object:error']);
    assert.deepEqual(rules({ jira: { site: 'https://example.atlassian.net/x', epic: 'proj-1' } }), ['jira.site:site-invalid:error', 'jira.epic:epic-invalid:error']);
    assert.deepEqual(rules({ jira: { site: 'example.atlassian.net' } }), ['jira:scope-missing:warning']);
  });

  it('accepts several epics, categories and a JQL fragment as the scope', () => {
    const site = 'example.atlassian.net';
    assert.deepEqual(rules({ jira: { site, epics: ['PROJ-100', 'PROJ-101'] } }), []);
    assert.deepEqual(rules({ jira: { site, epic: 'PROJ-100', epics: ['PROJ-101'] } }), []);
    assert.deepEqual(rules({ jira: { site, epic: 'PROJ-100', epics: ['PROJ-100'] } }), []);
    assert.deepEqual(rules({ jira: { site, epics: ['PROJ-100'], categories: [{ field: 'labels', values: ['checkout'] }] } }), []);
    assert.deepEqual(rules({ jira: { site, categories: [{ field: 'labels', values: ['checkout'] }, { field: 'customfield_10020', values: ['Sprint 12'] }, { field: 'Story Points', values: ['3'] }, { field: 'Área responsável', values: ['Pagamentos'] }, { field: 'A\u0301rea responsa\u0301vel', values: ['Pagamentos'] }, { field: 'cf[10021]', values: ['x'] }] } }), []);
    assert.deepEqual(rules({ jira: { site, jql: 'project = PROJ AND type = Bug' } }), []);
  });

  it('rejects a bad scope without echoing values', () => {
    const site = 'example.atlassian.net';
    assert.deepEqual(rules({ jira: { site, epics: [] } }), ['jira.epics:not-a-list:error']);
    assert.deepEqual(rules({ jira: { site, epics: ['PROJ-1', 'proj-2', 'PROJ-1'] } }), ['jira.epics[1]:epic-invalid:error', 'jira.epics[2]:epic-duplicate:error']);
    assert.deepEqual(rules({ jira: { site, epics: ['PROJ-1', 'PROJ-1'] } }), ['jira.epics[1]:epic-duplicate:error']);
    for (const extra of [{ epic: 'PROJ-1' }, { epics: ['PROJ-1'] }, { categories: [{ field: 'labels', values: ['a'] }] }]) {
      assert.deepEqual(rules({ jira: { site, ...extra, jql: 'project = PROJ' } }), ['jira.jql:scope-conflict:error']);
    }
    assert.deepEqual(rules({ jira: { site, categories: [] } }), ['jira.categories:not-a-list:error']);
    assert.deepEqual(rules({ jira: { site, categories: [{ values: ['a'] }, { field: 'la"bels', values: [] }, { field: 'labels', values: ['a"b', 'c\\d', ''] }] } }), [
      'jira.categories[0].field:field-missing:error',
      'jira.categories[1].field:field-invalid:error',
      'jira.categories[1].values:not-a-list:error',
      'jira.categories[2].values[0]:value-invalid:error',
      'jira.categories[2].values[1]:value-invalid:error',
      'jira.categories[2].values[2]:value-invalid:error',
    ]);
    assert.deepEqual(rules({ jira: { site, jql: 3 } }), ['jira.jql:field-invalid:error']);
    assert.deepEqual(rules({ jira: { site, jql: 'project = PROJ order   by created' } }), ['jira.jql:jql-order-by:error']);
    assert.deepEqual(rules({ jira: { site, jql: 'a'.repeat(2001) } }), ['jira.jql:jql-too-long:error']);
    assert.deepEqual(rules({ jira: { site, jql: 'summary ~ "order by date" AND labels = \'order by\'' } }), []);
  });

  it('accepts a configuration without Jira for the skills that do not triage', () => {
    const config = { knowledge: minimal().knowledge, index: { roots: ['../acme'], repositories: [{ name: 'acme-shop-checkout', path: '../acme-shop-checkout' }] } };
    assert.deepEqual(rules(config), ['jira:jira-missing:warning']);
  });

  it('checks dates, Slack ids and the lookback', () => {
    const bad = {
      ...minimal(),
      jira: { site: 'example.atlassian.net', epic: 'PROJ-100', project_end: '2026-02-30' },
      slack: { lookback_days: 0, people: [{ name: 'Fulano', id: 'u123' }], channels: [{ name: '#proj-squad', id: 'X0123456789', people: [{ name: 'Sicrano', id: 'C0123456789' }] }] },
    };
    assert.deepEqual(rules(bad), [
      'jira.project_end:date-invalid:error',
      'slack.lookback_days:lookback-invalid:error',
      'slack.people[0].id:slack-id-invalid:error',
      'slack.channels[0].id:slack-id-invalid:error',
      'slack.channels[0].people[0].id:slack-id-invalid:error',
    ]);
  });

  it('never lets a comment run without approval', () => {
    assert.deepEqual(rules({ ...minimal(), interactions: { enabled: true, auto_types: ['reaction', 'comment'] } }), ['interactions.auto_types:auto-type-not-allowed:error']);
    assert.deepEqual(rules({ ...minimal(), interactions: { enabled: 'sim' } }), ['interactions.enabled:field-invalid:error']);
    assert.deepEqual(rules({ ...minimal(), interactions: { jira: { comment: 'false' }, slack: { reaction: 42 } } }), ['interactions.jira.comment:field-invalid:error', 'interactions.slack.reaction:field-invalid:error']);
    assert.deepEqual(rules({ ...minimal(), interactions: { enabled: true, auto_types: ['reaction'], jira: { comment: false }, slack: { reaction: 'eyes' } } }), []);
  });

  it('requires file-name-safe names for repositories and knowledges', () => {
    const config = {
      ...minimal(),
      knowledge: [{ name: 'local', scope: 'local', dir: '.moiras/knowledge' }, { name: '../criteria', scope: 'group', dir: '../x' }],
      index: { repositories: [{ name: '../criteria/x', path: '../a' }, { name: 'a/b', path: '../b' }, { name: '..', path: '../c' }, { name: 'acme.shop-checkout_2', path: '../d' }] },
    };
    assert.deepEqual(rules(config), [
      'knowledge[1].name:name-invalid:error',
      'index.repositories[0].name:name-invalid:error',
      'index.repositories[1].name:name-invalid:error',
      'index.repositories[2].name:name-invalid:error',
    ]);
  });

  it('rejects repositories that would share a glossary file', () => {
    const config = { ...minimal(), index: { repositories: [{ name: 'acme-shop-checkout', path: '../a' }, { name: 'Acme-Shop-Checkout', path: '../b' }, { name: 'acme-shop-cart', path: '../c' }] } };
    assert.deepEqual(rules(config), ['index.repositories[1].name:name-duplicate:error']);
  });

  it('checks the knowledge list', () => {
    const config = {
      ...minimal(),
      knowledge: [
        { name: 'local', scope: 'local', dir: '.moiras/knowledge' },
        { name: 'local', scope: 'everyone', dir: '../x' },
        { name: 'other', scope: 'local', dir: '../y', repository: 'git@github.com:<org>/y.git' },
        { name: 'team', scope: 'group' },
      ],
    };
    assert.deepEqual(rules(config), [
      'knowledge[1].name:name-duplicate:error',
      'knowledge[1].scope:scope-invalid:error',
      'knowledge[2].scope:local-duplicate:error',
      'knowledge[2].repository:local-with-repository:error',
      'knowledge[3].dir:field-missing:error',
    ]);
  });

  it('requires pseudonyms for auditors and names and paths for repositories', () => {
    const config = {
      ...minimal(),
      audit: { auditors: ['reviewer-01', 'Maria Silva'] },
      index: { roots: ['../acme'], repositories: [{ name: 'acme-shop-checkout' }, { path: '../x' }] },
    };
    assert.deepEqual(rules(config), [
      'index.repositories[0].path:field-missing:error',
      'index.repositories[1].name:field-missing:error',
      'audit.auditors[1]:pseudonym-required:error',
    ]);
  });

  it('rejects secrets and credentials in URLs, and warns about personal paths', () => {
    const config = {
      ...minimal(),
      knowledge: [
        { name: 'local', scope: 'local', dir: '.moiras/knowledge' },
        { name: 'team', scope: 'group', dir: '../team', repository: 'https://user:hunter2@github.com/<org>/team.git' },
        { name: 'bot', scope: 'global', dir: '../bot', repository: 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/<org>/bot.git' },
        { name: 'ok', scope: 'project', dir: '/home/fulano/knowledge', repository: 'https://<user>:<token>@github.com/<org>/ok.git' },
      ],
    };
    assert.deepEqual(rules(config), [
      'knowledge[1].repository:url-credentials:error',
      'knowledge[2].repository:secret:error',
      'knowledge[3].dir:absolute-path:warning',
    ]);
    // Findings name the field and the rule, never the value.
    assert.ok(!JSON.stringify(validate(config)).includes('hunter2'));
  });

  it('keeps blocks of other sources, still scanning them, and rejects a non-object', () => {
    assert.deepEqual(rules({ ...minimal(), github: { repositories: ['acme/acme-shop-checkout'] } }), []);
    assert.deepEqual(rules({ ...minimal(), github: { token: 'synthetic', nested: { Password: 'synthetic' } } }), ['github.token:secret:error', 'github.nested.Password:secret:error']);
    assert.deepEqual(rules({ ...minimal(), github: { token: '<token>' } }), []);
    assert.deepEqual(rules({ ...minimal(), github: { api_keys: ['plain-value'], credentials: { value: 'plain-value', list: [{ k: 'x' }] } } }), ['github.api_keys[0]:secret:error', 'github.credentials.value:secret:error', 'github.credentials.list[0].k:secret:error']);
    assert.deepEqual(rules({ ...minimal(), github: { credentials: { value: '<token>' } } }), []);
    assert.deepEqual(rules({ ...minimal(), github: { token: 123456, api_keys: [123456], credentials: { value: 123456, flag: true, none: null } } }), ['github.token:secret:error', 'github.api_keys[0]:secret:error', 'github.credentials.value:secret:error']);
    assert.deepEqual(rules({ ...minimal(), github: { retries: 3, max_tokens: 4096, token_budget: 1000, tokenizer: { enabled: true } } }), []);
    assert.deepEqual(rules({ ...minimal(), github: { token_budget: { password: 123456, limit: 5 }, tokenizer: { token: 1 } } }), ['github.token_budget.password:secret:error', 'github.tokenizer.token:secret:error']);
    assert.deepEqual(rules({ ...minimal(), github: { tokens: [123456], password_tokens: 123456, password: { max_tokens: 123456 } } }), ['github.tokens[0]:secret:error', 'github.password_tokens:secret:error', 'github.password.max_tokens:secret:error']);
    assert.deepEqual(rules({ ...minimal(), github: { auth: 'Basic cGxhaW4tc2VjcmV0LXZhbHVl', headers: { Authorization: 'Bearer plain-value', 'x-auth': 'plain-value' }, cookie: 'sid=plain-value', session_id: 'plain-value', sessionId: 'plain-value' } }), ['github.auth:secret:error', 'github.headers.Authorization:secret:error', 'github.headers.x-auth:secret:error', 'github.cookie:secret:error', 'github.session_id:secret:error', 'github.sessionId:secret:error']);
    assert.deepEqual(rules({ ...minimal(), github: { author: 'Fulano', authors: ['Beltrana'], auth: '<token>', session: { timeout: 30 } } }), []);
    assert.deepEqual(rules({ ...minimal(), github: { tokens: ['plain-value'] } }), ['github.tokens[0]:secret:error']);
    assert.deepEqual(rules({ ...minimal(), github: { url: 'https://user:hunter2@github.com/acme' } }), ['github.url:url-credentials:error']);
    assert.deepEqual(rules([]), [':not-an-object:error']);
    assert.deepEqual(rules({ ...minimal(), agencies: [{ channel: '#a' }], slack: 3 }), ['agencies[0].name:field-missing:error', 'slack:not-an-object:error']);
  });
});

describe('init', () => {
  it('creates sources.json and a self-ignoring folder', t => {
    const { target } = workspace(t);
    const result = init(minimal(), target);
    assert.deepEqual(result.created, [join(target, '.gitignore'), join(target, 'sources.json')]);
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'sources.json'), 'utf8')), minimal());
    assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), '*\n');
    assert.deepEqual(validate(JSON.parse(readFileSync(join(target, 'sources.json'), 'utf8'))), []);
  });

  it('never overwrites an existing file', t => {
    const { target } = workspace(t);
    init(minimal(), target);
    writeFileSync(join(target, 'sources.json'), '{"mine":true}\n');
    assert.throws(() => init(minimal(), target), /already exists/);
    assert.equal(readFileSync(join(target, 'sources.json'), 'utf8'), '{"mine":true}\n');
  });

  it('keeps a protecting .gitignore and refuses one that does not protect the folder', t => {
    const { target } = workspace(t);
    init(minimal(), target);
    writeFileSync(join(target, '.gitignore'), '# mine\n*\n');
    rmSync(join(target, 'sources.json'));
    assert.deepEqual(init(minimal(), target).created, [join(target, 'sources.json')]);
    assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), '# mine\n*\n');
    const refused = (rules: string, dryRun = false) => {
      writeFileSync(join(target, '.gitignore'), rules);
      rmSync(join(target, 'sources.json'), { force: true });
      const result = init(minimal(), target, dryRun);
      assert.deepEqual(result.created, []);
      assert.ok(!existsSync(join(target, 'sources.json')));
      assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), rules);
      return result.findings.map(finding => `${finding.rule}:${finding.severity}`);
    };
    assert.deepEqual(refused('custom\n'), ['gitignore-not-protecting:error']);
    assert.deepEqual(refused('*\n!sources.json\n'), ['gitignore-not-protecting:error']);
    assert.deepEqual(refused('custom\n', true), ['gitignore-not-protecting:error']);
    assert.deepEqual(refused(' *\n'), ['gitignore-not-protecting:error']);
    assert.deepEqual(refused('\t*\n'), ['gitignore-not-protecting:error']);
    assert.deepEqual(refused('*\t\n'), ['gitignore-not-protecting:error']);
    // Trailing spaces and CRLF are dropped by Git, so these still protect the folder.
    writeFileSync(join(target, '.gitignore'), '*  \r\n');
    rmSync(join(target, 'sources.json'), { force: true });
    assert.deepEqual(init(minimal(), target).created, [join(target, 'sources.json')]);
  });

  it('refuses to recreate a configuration that Git still tracks', t => {
    const { dir, target } = workspace(t);
    const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (git('init', '-q').status !== 0) return t.skip('git is not available');
    init(minimal(), target);
    assert.equal(git('add', '-f', '.moiras/sources.json').status, 0);
    rmSync(join(target, 'sources.json'));
    const result = init(minimal(), target);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.findings.map(finding => `${finding.rule}:${finding.severity}`), ['sources-tracked:error']);
    assert.ok(!existsSync(join(target, 'sources.json')));
  });

  it('refuses a symlinked folder or file instead of writing through it', t => {
    const { dir, target } = workspace(t);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, target);
    for (const dryRun of [false, true]) {
      const result = init(minimal(), target, dryRun);
      assert.deepEqual(result.created, []);
      assert.deepEqual(result.findings.map(finding => `${finding.rule}:${finding.severity}`), ['symlink-refused:error']);
    }
    assert.deepEqual(readdirSync(outside), []);
    rmSync(target);
    // A link anywhere above the folder, even outside the working directory, is refused too.
    symlinkSync(outside, join(dir, 'link'));
    const above = init(minimal(), join(dir, 'link', 'project', '.moiras'));
    assert.deepEqual(above.created, []);
    assert.deepEqual(above.findings.map(finding => `${finding.rule}:${finding.path}`), [`symlink-refused:${join(dir, 'link')}`]);
    assert.deepEqual(readdirSync(outside), []);
    // A link above the folder is refused too when it lives under the working directory.
    const nested = join(process.cwd(), `.moiras-link-test-${process.pid}`);
    t.after(() => rmSync(nested, { force: true }));
    symlinkSync(outside, nested);
    const through = init(minimal(), join(nested, '.moiras'));
    assert.deepEqual(through.created, []);
    assert.ok(through.findings.some(finding => finding.rule === 'symlink-refused'));
    assert.deepEqual(readdirSync(outside), []);
    mkdirSync(target);
    writeFileSync(join(dir, 'real'), '');
    symlinkSync(join(dir, 'real'), join(target, '.gitignore'));
    assert.ok(init(minimal(), target).findings.some(finding => finding.rule === 'symlink-refused'));
    assert.ok(!existsSync(join(target, 'sources.json')));
  });

  it('writes nothing when there are errors or on a dry run', t => {
    const { target } = workspace(t);
    const invalid = init({ ...minimal(), jira: {} }, target);
    assert.deepEqual(invalid.created, []);
    assert.ok(invalid.findings.some(finding => finding.severity === 'error'));
    assert.deepEqual(init(minimal(), target, true).created, []);
    assert.ok(!existsSync(target));
  });
});

describe('check storage', () => {
  const rulesOf = (file: string) => (JSON.parse(main(['check', file]).output).findings as Finding[]).map(finding => `${finding.rule}:${finding.severity}`);

  it('warns about a configuration Git would commit, tracks, or reach through a link', t => {
    const { dir, target } = workspace(t);
    const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (git('init', '-q').status !== 0) return t.skip('git is not available');
    mkdirSync(target);
    const file = join(target, 'sources.json');
    writeFileSync(file, `${JSON.stringify(minimal())}\n`);
    assert.deepEqual(rulesOf(file), ['not-ignored:warning']);
    writeFileSync(join(target, '.gitignore'), '*\n');
    assert.deepEqual(rulesOf(file), []);
    assert.equal(git('add', '-f', '.moiras/sources.json').status, 0);
    assert.deepEqual(rulesOf(file), ['sources-tracked:warning']);
    assert.equal(main(['check', file]).code, 0);
    git('rm', '-q', '--cached', '.moiras/sources.json');
    symlinkSync(target, join(dir, 'link'));
    assert.deepEqual(rulesOf(join(dir, 'link', 'sources.json')), ['symlink-refused:warning']);
  });
});

describe('main', () => {
  it('runs init and check through the CLI, with exit codes', t => {
    const { target } = workspace(t);
    const run = (args: string[], input?: string) => spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' });
    const bad = run(['init', '--dir', target], JSON.stringify({ jira: {} }));
    assert.equal(bad.status, 1);
    assert.ok(!existsSync(target));
    const good = run(['init', '--dir', target], JSON.stringify(minimal()));
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout).created, [join(target, '.gitignore'), join(target, 'sources.json')]);
    assert.equal(run(['init', '--dir', target], JSON.stringify(minimal())).status, 2);
    const checked = run(['check', join(target, 'sources.json')]);
    assert.equal(checked.status, 0);
    assert.deepEqual(JSON.parse(checked.stdout), { findings: [] });
    assert.equal(run(['check', join(target, 'missing.json')]).status, 2);
    assert.equal(run(['init'], 'not json').status, 2);
    assert.equal(run(['nope']).status, 2);
  });

  it('accepts the configuration as an argument', t => {
    const { target } = workspace(t);
    const { output, code } = main(['init', '--dir', target, '--dry-run'], JSON.stringify(minimal()));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), { created: [], findings: [] });
  });
});
