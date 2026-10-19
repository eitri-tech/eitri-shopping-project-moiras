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
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
/** Field for a category: a name (`labels`, `Story Points`, `Área responsável`), a REST id (`customfield_10020`) or the JQL id `cf[10020]`. The Clotho quotes names, so no quotes or control characters. */
const jiraField = /^(?:cf\[\d+\]|[\p{L}\p{N}_][\p{L}\p{M}\p{N} _.-]{0,63})$/u;
/** Category value (a label, component or option name): quoted by the Clotho, so no double quote, backslash or control character. */
const jiraValue = /^[^"\\\u0000-\u001f]{1,128}$/;
const slackUser = /^[UW][A-Z0-9]{8,}$/;
const slackChannel = /^[CG][A-Z0-9]{8,}$/;
const userInfo = patterns.find(entry => entry.rule === 'url-credentials')!.test;
const secret = patterns.find(entry => entry.rule === 'secret')!.test;
const absolutePath = patterns.find(entry => entry.rule === 'absolute-path')!.test;
const absolutePathValue = /^(?:\/|~|[A-Za-z]:[\\/])/;

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
  // Any string or number under a key that names a credential (token, password...), at any depth, is a secret even when it
  // looks harmless (only an empty string, null or a `<placeholder>` passes). Booleans carry no secret, and numbers under
  // a counter such as `max_tokens` or `token_budget` are not credentials either.
  // `auth` only as a whole word (auth, auth_token, x-auth): `author` is not a credential.
  const credentialKey = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|bearer|cookie|session[_-]?id|(?:^|[_-])auth(?:$|[_-]))/i;
  const counterKey = /^(?:(?:max|min|total|input|output|prompt|completion)[_-]?tokens|tokens?[_-]?(?:budget|limit|count|usage|ttl|expiry|lifetime))$/i;
  // The counter exemption applies from the key down, never below a credential key, and a credential key inside it clears it.
  const scanKeys = (value: unknown, path: string, underCredential = false, counter = false) => {
    if (typeof value === 'string') {
      if (underCredential && value.trim() !== '' && !placeholder(value.trim())) add(path, 'secret');
    } else if (typeof value === 'number') {
      if (underCredential && !counter) add(path, 'secret');
    } else if (Array.isArray(value)) value.forEach((item, index) => scanKeys(item, `${path}[${index}]`, underCredential, counter));
    else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        const isCounter = counterKey.test(key);
        const isCredential = credentialKey.test(key);
        scanKeys(item, path ? `${path}.${key}` : key, underCredential || isCredential, isCredential && !isCounter ? false : counter || (isCounter && !underCredential));
      }
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
    // The scope of the triage is epics and/or categories (field + values, ANDed by the Clotho).
    // `epic` stays as the single-epic shorthand.
    if (jira.epic !== undefined && (typeof jira.epic !== 'string' || !jiraKey.test(jira.epic))) add('jira.epic', 'epic-invalid');
    if (jira.epics !== undefined) {
      if (!Array.isArray(jira.epics) || jira.epics.length === 0) add('jira.epics', 'not-a-list');
      else (jira.epics as unknown[]).forEach((epic, index, all) => {
        if (typeof epic !== 'string' || !jiraKey.test(epic)) add(`jira.epics[${index}]`, 'epic-invalid');
        else if (all.indexOf(epic) !== index) add(`jira.epics[${index}]`, 'epic-duplicate'); // `epic` repeated in `epics` is fine: the Clotho unions them
      });
    }
    if (jira.categories !== undefined) {
      if (!Array.isArray(jira.categories) || jira.categories.length === 0 || jira.categories.some(item => !isObject(item))) add('jira.categories', 'not-a-list');
      else (jira.categories as Json[]).forEach((category, index) => {
        const path = `jira.categories[${index}]`;
        if (!isText(category.field)) add(`${path}.field`, 'field-missing');
        else if (!jiraField.test(category.field.normalize('NFC'))) add(`${path}.field`, 'field-invalid');
        if (!Array.isArray(category.values) || category.values.length === 0) add(`${path}.values`, 'not-a-list');
        else category.values.forEach((value, position) => {
          if (!isText(value) || !jiraValue.test(value)) add(`${path}.values[${position}]`, 'value-invalid');
        });
      });
    }
    // The free-form query is gone. Ignoring a leftover one would quietly widen the scope (the epics alone, or nothing, would apply), so say so.
    if (jira.jql !== undefined) add('jira.jql', 'jql-unsupported');
    if ([jira.epic, jira.epics, jira.categories].every(part => part === undefined)) add('jira', 'scope-missing', 'warning');
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

  const warnPath = (path: string, value: unknown) => {
    if (isText(value) && absolutePathValue.test(value.trim()) && !findings.some(f => f.path === path && f.rule === 'absolute-path')) {
      add(path, 'absolute-path', 'warning');
    }
  };

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
    else warnPath(`${path}.dir`, entry.dir);
    if (entry.repository !== undefined && !isText(entry.repository)) add(`${path}.repository`, 'field-invalid');
    if (entry.scope === 'local' && entry.repository !== undefined) add(`${path}.repository`, 'local-with-repository');
  });

  // index
  if (config.index !== undefined) {
    const index = config.index;
    if (!isObject(index)) add('index', 'not-an-object');
    else {
      if (index.roots !== undefined) {
        if (!Array.isArray(index.roots) || index.roots.some(root => !isText(root))) add('index.roots', 'not-a-list');
        else index.roots.forEach((root, position) => warnPath(`index.roots[${position}]`, root));
      }
      // Each name is a file (`glossary/<name>.md`): two repositories with one name (any case) would overwrite each other.
      const repositoryNames = new Set<string>();
      list(index.repositories, 'index.repositories').forEach((repository, position) => {
        const path = `index.repositories[${position}]`;
        for (const field of ['name', 'path']) if (!isText(repository[field])) add(`${path}.${field}`, 'field-missing');
        warnPath(`${path}.path`, repository.path);
        if (isText(repository.name) && !safeName.test(repository.name)) add(`${path}.name`, 'name-invalid');
        else if (isText(repository.name) && repositoryNames.has(repository.name.toLowerCase())) add(`${path}.name`, 'name-duplicate');
        else if (isText(repository.name)) repositoryNames.add(repository.name.toLowerCase());
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
    if (section !== undefined) {
      if (!(isObject(section) && (section.dir === undefined || isText(section.dir)))) add(`${key}.dir`, 'field-invalid');
      else warnPath(`${key}.dir`, section.dir);
    }
  }
  return findings;
}

const hasErrors = (findings: Finding[]) => findings.some(finding => finding.severity === 'error');

/** True when a `*` rule is not re-included by a later negation such as `!sources.json`. */
function ignoresEverything(rules: string): boolean {
  // Git drops only unescaped trailing spaces: leading spaces and tabs belong to the pattern, so ` *` and `*\t` do not ignore everything.
  const lines = rules.split(/\r?\n/).map(line => line.replace(/ +$/, '')).filter(line => line && !line.startsWith('#'));
  const last = lines.lastIndexOf('*');
  return last !== -1 && !lines.slice(last + 1).some(line => line.startsWith('!'));
}

/** Runs Git read-only at the nearest existing ancestor of `file`; undefined when Git is missing or `file` is outside a repository. */
function git(file: string, ...args: string[]): number | undefined {
  let base = dirname(resolve(file));
  while (!existsSync(base) && dirname(base) !== base) base = dirname(base);
  if (spawnSync('git', ['-C', base, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }).status !== 0) return undefined;
  return spawnSync('git', ['-C', base, ...args, '--', resolve(file)], { stdio: 'ignore' }).status ?? undefined;
}

/**
 * Whether the configuration file sits where the user approved and where nothing commits it by accident, for `init` (errors,
 * before writing) and `check` (warnings, on an existing file):
 * - no symlink in any existing component of its path, nor in `extra` (the sibling ignore file), since writes would land elsewhere;
 * - not tracked by Git (ignore rules do not apply to tracked paths, even when the file is gone from disk);
 * - with `ignored`, ignored by Git (no Git, or outside a repository, means nothing to report).
 */
function storageFindings(file: string, severity: Finding['severity'], { ignored = false, extra = [] as string[] } = {}): Finding[] {
  const findings: Finding[] = [];
  const parts = resolve(file).split(sep).filter(Boolean);
  const paths = parts.map((_, index) => `${sep}${parts.slice(0, index + 1).join(sep)}`);
  for (const path of [...paths, ...extra]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) findings.push({ path, rule: 'symlink-refused', severity });
  }
  if (git(file, 'ls-files', '--error-unmatch') === 0) findings.push({ path: file, rule: 'sources-tracked', severity });
  else if (ignored && git(file, 'check-ignore', '-q') === 1) findings.push({ path: file, rule: 'not-ignored', severity });
  return findings;
}

/** Creates the configuration folder and file; refuses to touch an existing file. */
export function init(config: unknown, dir = defaultDir, dryRun = false): { created: string[]; findings: Finding[] } {
  const findings = validate(config);
  const ignore = join(dir, '.gitignore');
  // An existing ignore file that does not cover the folder would leave IDs and names open to an accidental commit:
  // refuse before writing anything (the dry run reports it too).
  if (existsSync(ignore) && !ignoresEverything(readFileSync(ignore, 'utf8'))) findings.push({ path: ignore, rule: 'gitignore-not-protecting', severity: 'error' });
  const file = join(dir, 'sources.json');
  // Writes must land where the user approved, and the file must not already be tracked (see storageFindings).
  findings.push(...storageFindings(file, 'error', { extra: [ignore] }));
  if (hasErrors(findings)) return { created: [], findings };
  if (existsSync(file)) throw new Error(`${file} already exists; edit it by hand or remove it first.`);
  if (dryRun) return { created: [], findings };
  mkdirSync(dir, { recursive: true });
  // The folder ignores itself, so nothing in it (IDs, knowledge, memory, reports) is committed by accident;
  // the ignore file goes first so the configuration is never on disk unprotected.
  const created: string[] = [];
  if (!existsSync(ignore)) {
    writeFileSync(ignore, '*\n', { flag: 'wx' });
    created.push(ignore);
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  created.push(file);
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
    const findings = [...validate(config), ...storageFindings(file, 'warning', { ignored: true, extra: [join(dirname(resolve(file)), '.gitignore')] })];
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
