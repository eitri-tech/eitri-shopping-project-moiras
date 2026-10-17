import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { init, main, validate } from './config.ts';

const script = join(import.meta.dirname, 'config.ts');
const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', 'sources.example.json'), 'utf8'));

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'moiras-config-'));
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
    assert.deepEqual(rules({ jira: { site: 'example.atlassian.net' } }), ['jira.epic:epic-missing:warning']);
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
    assert.deepEqual(rules({ ...minimal(), github: { retries: 3, max_tokens: 4096, token_budget: 1000, tokenizer: { enabled: true, limit: 5 } } }), []);
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

  it('writes nothing when there are errors or on a dry run', t => {
    const { target } = workspace(t);
    const invalid = init({ ...minimal(), jira: {} }, target);
    assert.deepEqual(invalid.created, []);
    assert.ok(invalid.findings.some(finding => finding.severity === 'error'));
    assert.deepEqual(init(minimal(), target, true).created, []);
    assert.ok(!existsSync(target));
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
