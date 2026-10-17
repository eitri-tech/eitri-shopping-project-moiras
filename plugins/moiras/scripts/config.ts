/**
 * Creates and checks `.moiras/sources.json`, the configuration the skills read.
 * It is the only file the plugin sets up for the user, and it never overwrites one.
 *
 * Usage:
 *   node config.ts init [--dir <path>] [--dry-run] < config.json
 *   node config.ts check [<file>]
 *
 * Findings carry the path of the field and the rule, never the value.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hasSecret, isCalendarDate, patterns, placeholder, pseudonymPattern } from './knowledge.ts';

export const usage = 'Usage: node config.ts init [--dir <path>] [--dry-run] < config.json | check [<file>]';

export interface Finding {
  path: string;
  rule: string;
  severity: 'error' | 'warning';
}

export const defaultDir = '.moiras';
const scopes = new Set(['local', 'project', 'group', 'global']);
const jiraKey = /^[A-Z][A-Z0-9]*-\d+$/;
const host = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const slackUser = /^[UW][A-Z0-9]{8,}$/;
const slackChannel = /^[CG][A-Z0-9]{8,}$/;
const userInfo = patterns.find(entry => entry.rule === 'url-credentials')!.test;
const secret = patterns.find(entry => entry.rule === 'secret')!.test;
const absolutePath = patterns.find(entry => entry.rule === 'absolute-path')!.test;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
/** Names become file names (`glossary/<name>.md`) and `knowledge:<name>/...` references: no separators, no `.`/`..`. */
const safeName = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Rule-by-rule check of a parsed configuration. */
export function validate(config: unknown): Finding[] {
  const findings: Finding[] = [];
  const add = (path: string, rule: string, severity: Finding['severity'] = 'error') => findings.push({ path, rule, severity });
  if (!isObject(config)) return [{ path: '', rule: 'not-an-object', severity: 'error' }];

  // Jira is required and Slack is the usual context; any other top-level block is another source (see stages/clotho.md),
  // kept as given. Every string, in every block: no secrets, no credentials in URLs, no machine-specific paths.
  const scan = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      const scrubbed = value.replace(/\b[a-z][\w+.-]*:\/\/([^\s/@]{1,512})@/gi, (url, info: string) => info.split(':').every(placeholder) ? '' : url);
      if (hasSecret(value) || secret.test(value)) add(path, 'secret');
      else if (userInfo.test(scrubbed)) add(path, 'url-credentials');
      if (absolutePath.test(value)) add(path, 'absolute-path', 'warning');
    } else if (Array.isArray(value)) value.forEach((item, index) => scan(item, `${path}[${index}]`));
    else if (isObject(value)) for (const [key, item] of Object.entries(value)) scan(item, path ? `${path}.${key}` : key);
  };
  scan(config, '');
  // Any string under a key that names a credential (token, password...), at any depth, is a secret even when it looks harmless.
  const credentialKey = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;
  const scanKeys = (value: unknown, path: string, underCredential = false) => {
    if (typeof value === 'string') {
      if (underCredential && value.trim() !== '' && !placeholder(value.trim())) add(path, 'secret');
    } else if (Array.isArray(value)) value.forEach((item, index) => scanKeys(item, `${path}[${index}]`, underCredential));
    else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) scanKeys(item, path ? `${path}.${key}` : key, underCredential || credentialKey.test(key));
    }
  };
  scanKeys(config, '');

  const list = (value: unknown, path: string): Json[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(item => !isObject(item))) { add(path, 'not-a-list'); return []; }
    return value as Json[];
  };

  // jira
  const jira = config.jira;
  if (jira === undefined) add('jira', 'jira-missing', 'warning'); // only the triage needs it; index, sync and publish do not
  else if (!isObject(jira)) add('jira', 'not-an-object');
  else {
    if (!isText(jira.site) || !host.test(jira.site)) add('jira.site', 'site-invalid');
    if (jira.epic === undefined) add('jira.epic', 'epic-missing', 'warning');
    else if (typeof jira.epic !== 'string' || !jiraKey.test(jira.epic)) add('jira.epic', 'epic-invalid');
    if (jira.project_end !== undefined && !(typeof jira.project_end === 'string' && isCalendarDate(jira.project_end))) add('jira.project_end', 'date-invalid');
    if (jira.agency_field !== undefined && !isText(jira.agency_field)) add('jira.agency_field', 'field-invalid');
  }

  // agencies
  list(config.agencies, 'agencies').forEach((agency, index) => {
    if (!isText(agency.name)) add(`agencies[${index}].name`, 'field-missing');
  });

  // slack
  if (config.slack !== undefined) {
    const slack = config.slack;
    if (!isObject(slack)) add('slack', 'not-an-object');
    else {
      if (slack.lookback_days !== undefined && !(Number.isInteger(slack.lookback_days) && (slack.lookback_days as number) > 0)) add('slack.lookback_days', 'lookback-invalid');
      const people = (items: Json[], path: string) => items.forEach((person, index) => {
        if (!isText(person.name)) add(`${path}[${index}].name`, 'field-missing');
        if (typeof person.id !== 'string' || !slackUser.test(person.id)) add(`${path}[${index}].id`, 'slack-id-invalid');
      });
      people(list(slack.people, 'slack.people'), 'slack.people');
      list(slack.channels, 'slack.channels').forEach((channel, index) => {
        const path = `slack.channels[${index}]`;
        if (!isText(channel.name)) add(`${path}.name`, 'field-missing');
        if (typeof channel.id !== 'string' || !slackChannel.test(channel.id)) add(`${path}.id`, 'slack-id-invalid');
        people(list(channel.people, `${path}.people`), `${path}.people`);
      });
    }
  }

  // interactions: a comment is never applied without the "sim", so it cannot be automatic.
  if (config.interactions !== undefined) {
    const interactions = config.interactions;
    if (!isObject(interactions)) add('interactions', 'not-an-object');
    else {
      if (interactions.enabled !== undefined && typeof interactions.enabled !== 'boolean') add('interactions.enabled', 'field-invalid');
      if (interactions.jira !== undefined && !(isObject(interactions.jira) && (interactions.jira.comment === undefined || typeof interactions.jira.comment === 'boolean'))) add('interactions.jira.comment', 'field-invalid');
      if (interactions.slack !== undefined && !(isObject(interactions.slack) && (interactions.slack.reaction === undefined || isText(interactions.slack.reaction)))) add('interactions.slack.reaction', 'field-invalid');
      const auto = interactions.auto_types;
      if (auto !== undefined) {
        if (!Array.isArray(auto) || auto.some(type => typeof type !== 'string')) add('interactions.auto_types', 'not-a-list');
        else if (auto.some(type => type !== 'reaction')) add('interactions.auto_types', 'auto-type-not-allowed');
      }
    }
  }

  // knowledge
  const names = new Set<string>();
  let locals = 0;
  list(config.knowledge, 'knowledge').forEach((entry, index) => {
    const path = `knowledge[${index}]`;
    if (!isText(entry.name)) add(`${path}.name`, 'field-missing');
    else if (!safeName.test(entry.name)) add(`${path}.name`, 'name-invalid');
    else if (names.has(entry.name)) add(`${path}.name`, 'name-duplicate');
    else names.add(entry.name);
    if (typeof entry.scope !== 'string' || !scopes.has(entry.scope)) add(`${path}.scope`, 'scope-invalid');
    if (entry.scope === 'local' && ++locals > 1) add(`${path}.scope`, 'local-duplicate');
    if (!isText(entry.dir)) add(`${path}.dir`, 'field-missing');
    if (entry.repository !== undefined && !isText(entry.repository)) add(`${path}.repository`, 'field-invalid');
    if (entry.scope === 'local' && entry.repository !== undefined) add(`${path}.repository`, 'local-with-repository');
  });

  // index
  if (config.index !== undefined) {
    const index = config.index;
    if (!isObject(index)) add('index', 'not-an-object');
    else {
      if (index.roots !== undefined && (!Array.isArray(index.roots) || index.roots.some(root => !isText(root)))) add('index.roots', 'not-a-list');
      list(index.repositories, 'index.repositories').forEach((repository, position) => {
        const path = `index.repositories[${position}]`;
        for (const field of ['name', 'path']) if (!isText(repository[field])) add(`${path}.${field}`, 'field-missing');
        if (isText(repository.name) && !safeName.test(repository.name)) add(`${path}.name`, 'name-invalid');
        for (const field of ['url', 'owner', 'agency', 'platform']) if (repository[field] !== undefined && !isText(repository[field])) add(`${path}.${field}`, 'field-invalid');
      });
    }
  }

  // audit
  if (config.audit !== undefined) {
    const audit = config.audit;
    if (!isObject(audit)) add('audit', 'not-an-object');
    else if (audit.auditors !== undefined) {
      if (!Array.isArray(audit.auditors)) add('audit.auditors', 'not-a-list');
      else audit.auditors.forEach((auditor, index) => {
        if (typeof auditor !== 'string' || !pseudonymPattern.test(auditor)) add(`audit.auditors[${index}]`, 'pseudonym-required');
      });
    }
  }

  for (const key of ['memory', 'runs']) {
    const section = config[key];
    if (section !== undefined && !(isObject(section) && (section.dir === undefined || isText(section.dir)))) add(`${key}.dir`, 'field-invalid');
  }
  return findings;
}

const hasErrors = (findings: Finding[]) => findings.some(finding => finding.severity === 'error');

/** True when a `*` rule is not re-included by a later negation such as `!sources.json`. */
function ignoresEverything(rules: string): boolean {
  const lines = rules.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const last = lines.lastIndexOf('*');
  return last !== -1 && !lines.slice(last + 1).some(line => line.startsWith('!'));
}

/** Creates the configuration folder and file; refuses to touch an existing file. */
export function init(config: unknown, dir = defaultDir, dryRun = false): { created: string[]; findings: Finding[] } {
  const findings = validate(config);
  const ignore = join(dir, '.gitignore');
  // An existing ignore file that does not cover the folder would leave IDs and names open to an accidental commit:
  // refuse before writing anything (the dry run reports it too).
  if (existsSync(ignore) && !ignoresEverything(readFileSync(ignore, 'utf8'))) findings.push({ path: ignore, rule: 'gitignore-not-protecting', severity: 'error' });
  if (hasErrors(findings)) return { created: [], findings };
  const file = join(dir, 'sources.json');
  if (existsSync(file)) throw new Error(`${file} already exists; edit it by hand or remove it first.`);
  if (dryRun) return { created: [], findings };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  const created = [file];
  // The folder ignores itself, so nothing in it (IDs, knowledge, memory, reports) is committed by accident.
  if (!existsSync(ignore)) {
    writeFileSync(ignore, '*\n', { flag: 'wx' });
    created.push(ignore);
  }
  return { created, findings };
}

export function main(argv: string[], input?: string): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { dir: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${usage}`);
  }
  const { positionals: [command, ...rest], values } = parsed;
  if (command === 'init') {
    if (rest.length) throw new Error(usage);
    let config: unknown;
    try { config = JSON.parse(input ?? readFileSync(0, 'utf8')); } catch { throw new Error('The configuration on stdin is not valid JSON.'); }
    const result = init(config, values.dir, values['dry-run']);
    return { output: JSON.stringify(result), code: hasErrors(result.findings) ? 1 : 0 };
  }
  if (command === 'check') {
    if (rest.length > 1 || values.dir !== undefined || values['dry-run'] !== undefined) throw new Error(usage);
    const file = rest[0] ?? join(defaultDir, 'sources.json');
    let config: unknown;
    try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is missing or is not valid JSON.`); }
    const findings = validate(config);
    return { output: JSON.stringify({ findings }), code: hasErrors(findings) ? 1 : 0 };
  }
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    const { output, code } = main(process.argv.slice(2));
    process.stdout.write(`${output}\n`);
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
