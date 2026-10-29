/* Usage:
 * node skills.ts plan --local <dir> [--shared <dir>]... --fingerprint <sha256:...> [--date AAAA-MM-DD]
 * node skills.ts write --local <dir> [--shared <dir>]... --fingerprint <sha256:...> --expect <digest> [--date AAAA-MM-DD]
 * node skills.ts stale --skills <dir> [--local <dir>] [--shared <dir>]... --fingerprint <sha256:...>
 *
 * Exports each learning that stands alone (resolved solutions, patterns and decisions) as <local>/skills/<id>/SKILL.md,
 * self-contained: it names neither the plugin nor its paths. `plan` writes nothing. `write` writes only the add and update
 * items of a plan, and only when its digest is the one the user approved (a change since then refuses the write).
 * `stale` tells, for the skills of a folder, whether the current knowledge still produces them, and which conflicts.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable and import siblings with the .ts extension.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { check, checkSkill, githubSource, isCalendarDate, pathIssue, records, skillFiles, skillMetadata, skillName, validReferenceUrl } from './knowledge.ts';
import type { Doc, Finding } from './knowledge.ts';
import { hash } from './memory.ts';

export const usage = 'Usage: node skills.ts plan --local <dir> [--shared <dir>]... --fingerprint <sha256:...> [--date AAAA-MM-DD] | write --local <dir> [--shared <dir>]... --fingerprint <sha256:...> --expect <digest> [--date AAAA-MM-DD] | stale --skills <dir> [--local <dir>] [--shared <dir>]... --fingerprint <sha256:...>';

type Fields = Doc['fields'];
type Kind = 'solution' | 'pattern' | 'decision';

/** A record of the knowledge as a source for skills. `valid` is false when `check` flags it: it is then never exported. */
interface Source {
  path: string;
  type: string;
  doc: Doc | null;
  valid: boolean;
}

interface Sources {
  solutions: Map<string, Source>;
  patterns: Map<string, Source>;
  decisions: Map<string, Source>;
  /** Active criteria only: the ones a newer criterion replaces (`replaces`) are left out. */
  criteria: Map<string, Source>;
  glossary: Map<string, Source>;
}

export interface Excluded {
  id: string;
  kind: string;
  reason: string;
}

/** Everything a skill needs, already synthesized from the records: no raw text of issues or conversations. */
interface Draft {
  id: string;
  kind: Kind;
  title: string;
  repository: string;
  repositories: string[];
  component: string;
  category: string;
  symptom: string;
  cause: string;
  confirm: string;
  correction: string;
  result?: string;
  unresolved: string[];
  sources: string[];
  references: string[];
}

export interface Candidate extends Draft {
  name: string;
  rules: string[];
  ruleIds: string[];
  terms: string[];
  glossaryIds: string[];
}

export interface PlanItem {
  id: string;
  name: string;
  path: string;
  action: 'add' | 'update' | 'unchanged' | 'blocked';
  reason: string;
  diff?: string[];
  findings?: { rule: string; line?: number }[];
}

export interface SkillPlan {
  fingerprint: string;
  date: string;
  digest: string;
  items: PlanItem[];
  excluded: Excluded[];
  orphans: string[];
}

export interface Options {
  local: string;
  shared: string[];
  fingerprint: string;
  date: string;
}

const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const safeName = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const maxDiffLines = 200;
const maxDescription = 300;
const noConfirm = 'Não há passos de confirmação registrados para este aprendizado: confirme pelo sintoma no código do componente.';
const placeholderValue = /<[^>]*>/;

const fieldsOf = (source: Source): Fields => source.doc?.fields ?? {};
const bodyOf = (source: Source): string => source.doc?.body ?? '';
const scalar = (value: Fields[string] | undefined): string => (typeof value === 'string' ? value.trim() : '');
const list = (value: Fields[string] | undefined): string[] => (Array.isArray(value) ? value : value ? value.split(',') : [])
  .map(item => item.trim())
  .filter(Boolean);
const uniq = <T>(items: T[]): T[] => [...new Set(items)];
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const stem = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
export const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const byKey = <T>(map: Map<string, T>): [string, T][] => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u);

/** The text under a `**Label:**` line, up to the next label or heading (lines of a list belong to it). */
function labelled(body: string, label: string): string {
  const prefix = `**${label}:**`;
  const lines = body.split('\n');
  const start = lines.findIndex(line => line.startsWith(prefix));
  if (start === -1) return '';
  const out = [lines[start]!.slice(prefix.length).trim()];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('**') || line.startsWith('#')) break;
    out.push(line.trimEnd());
  }
  return out.join('\n').trim();
}

const titleOf = (body: string): string => body.split('\n').find(line => line.startsWith('# '))?.slice(2).trim() ?? '';

/** The rule of a criterion: the paragraph under its title, before any label. */
function ruleOf(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex(line => line.startsWith('# '));
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('**') || line.startsWith('#')) break;
    if (line.trim()) out.push(line.trim());
  }
  return oneLine(out.join(' '));
}

/** A symptom is concrete when it says what happens in at least three words; `indeterminada` and placeholders are not. */
export function concrete(text: string): boolean {
  const value = oneLine(text);
  const tokens = value.match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? [];
  return tokens.length >= 3&& !/^(?:indeterminad[oa]|n\/?a|tbd|todo)\.?$/i.test(value) && !placeholderValue.test(value) && !/AAAA-MM-DD/.test(value);
}

const validRef = (value: Fields[string] | undefined): string | undefined => {
  const url = scalar(value);
  return url && validReferenceUrl(url) ? url : undefined;
};
const referenceLine = (url: string | undefined): string => (url ? `Referência (PR): ${url}` : 'Referência não registrada.');

/** The issue keys of a record (`issue`, or `issues` of a pattern): a Jira key or `dono/repo#n`, as written. */
const issueKeysOf = (fields: Fields): string[] => uniq([...list(fields.issue), ...list(fields.issues)]);
/** Whether `text` cites `url` as a whole link (`pull/15` does not cite `pull/150`). */
const citesUrl = (text: string, url: string): boolean => new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`).test(text);

/** `dono/repo#n` of a GitHub source, the issue keys of the record: how a skill cites where it came from. */
function refsOf(fields: Fields): string[] {
  const url = validRef(fields.reference_url);
  return uniq([...(url ? [githubSource(url) ?? ''] : []), ...list(fields.issue)]).filter(Boolean);
}

/** The records of the knowledges, first knowledge wins for each path (the list order is the scope order: local first). */
function loadSources(dirs: string[]): Sources {
  const merged = new Map<string, Source>();
  for (const dir of dirs) {
    const invalid = new Set(check(dir).findings.filter(finding => finding.severity === 'error').map(finding => finding.path));
    for (const entry of records(dir)) {
      if (merged.has(entry.path)) continue;
      merged.set(entry.path, {
        path: entry.path,
        type: entry.kind.type,
        doc: entry.issue ? null : entry.doc,
        valid: !entry.issue && entry.doc !== null && !invalid.has(entry.path),
      });
    }
  }
  const values = [...merged.values()];
  const byType = (type: string) => new Map(values.filter(source => source.type === type).map((source): [string, Source] => [stem(source.path), source]));
  const replaced = new Set<string>();
  for (const source of values) {
    if (source.type === 'criterion' && source.valid) for (const id of list(fieldsOf(source).replaces)) replaced.add(stem(id));
  }
  return {
    solutions: byType('solution'),
    patterns: byType('pattern'),
    decisions: byType('decision'),
    criteria: new Map([...byType('criterion')].filter(([id]) => !replaced.has(id))),
    glossary: byType('repository'),
  };
}

/** Criteria a skill applies: `solutions` ones apply to all; `category` ones when the category is named in them. */
function criteriaFor(sources: Sources, category: string): { ids: string[]; lines: string[] } {
  const ids: string[] = [];
  const lines: string[] = [];
  for (const [id, source] of byKey(sources.criteria)) {
    if (!source.valid) continue;
    const applies = scalar(fieldsOf(source).applies_to);
    const title = titleOf(bodyOf(source)) || id;
    const rule = ruleOf(bodyOf(source));
    const applicable = applies === 'solutions' || (applies === 'category' && category !== '' && words(`${title} ${rule}`).includes(category.toLowerCase()));
    if (!applicable) continue;
    ids.push(id);
    lines.push(`- ${title}: ${rule}`);
  }
  return { ids, lines };
}

/** The glossary entries of the repositories a skill names: where the code lives, in the glossary's own words. */
function glossaryFor(sources: Sources, repositories: string[]): { ids: string[]; lines: string[] } {
  const ids: string[] = [];
  const lines: string[] = [];
  for (const repository of repositories) {
    const source = sources.glossary.get(repository);
    if (!source?.valid) continue;
    const fields = fieldsOf(source);
    const url = scalar(fields.url);
    const platform = scalar(fields.platform);
    const keywords = list(fields.keywords);
    lines.push(`- ${repository}${url && validReferenceUrl(url) ? ` (${url})` : ''}${platform ? `, plataforma ${platform}` : ''}`);
    if (keywords.length) lines.push(`  - Palavras-chave: ${keywords.join(', ')}`);
    for (const line of bodyOf(source).split('\n')) if (line.startsWith('- ')) lines.push(`  ${line.trimEnd()}`);
    ids.push(repository);
  }
  return { ids, lines };
}

function candidateOf(sources: Sources, draft: Draft): Candidate {
  const criteria = criteriaFor(sources, draft.category);
  const glossary = glossaryFor(sources, draft.repositories);
  return {
    ...draft,
    name: slug(`${draft.repository}-${draft.component}-${draft.id}`),
    rules: criteria.lines,
    ruleIds: criteria.ids,
    terms: glossary.lines,
    glossaryIds: glossary.ids,
  };
}

/**
 * One candidate per learning that can stand alone, and an exclusion (with its reason, never its text) for every other record.
 * Solutions must be resolved; patterns and decisions take their symptom and correction from their own text or their sources.
 */
export function buildCandidates(sources: Sources): { candidates: Candidate[]; excluded: Excluded[] } {
  const excluded: Excluded[] = [];
  const exclude = (id: string, kind: string, reason: string) => {
    excluded.push({ id, kind, reason });
  };
  // "O que não resolveu": a rejected decision goes with the learnings of its issue (`issue`); a learning that cites the rejected
  // PR (`reference_url`, or its URL in the text) is the fallback. Not-resolved solutions of the same issue go there too.
  const rejections: { issues: string[]; url?: string; line: string }[] = [];
  for (const [id, source] of byKey(sources.decisions)) {
    if (!source.valid || scalar(fieldsOf(source).outcome) !== 'rejected') continue;
    const fields = fieldsOf(source);
    const url = validRef(fields.reference_url);
    const cited = url ? githubSource(url) : undefined;
    rejections.push({ issues: issueKeysOf(fields), url, line: `- ${titleOf(bodyOf(source)) || id}: ${scalar(fields.reason) || 'motivo não registrado'}${cited ? ` (${cited})` : ''}` });
  }
  const notResolved: { id: string; issues: string[]; line: string }[] = [];
  for (const [id, source] of byKey(sources.solutions)) {
    if (!source.valid || scalar(fieldsOf(source).result) !== 'not-resolved') continue;
    notResolved.push({ id, issues: issueKeysOf(fieldsOf(source)), line: `- ${titleOf(bodyOf(source)) || id} (${id}): não resolveu` });
  }

  const drafts: Draft[] = [];
  const rejectedFor = (keys: string[], refs: { urls: (string | undefined)[]; texts: string[] }): string[] => rejections
    .filter(entry => entry.issues.some(key => keys.includes(key))
      || (entry.url !== undefined && (refs.urls.includes(entry.url) || refs.texts.some(text => citesUrl(text, entry.url!)))))
    .map(entry => entry.line);
  const notResolvedFor = (id: string, keys: string[]): string[] => notResolved
    .filter(entry => entry.id !== id && entry.issues.some(key => keys.includes(key)))
    .map(entry => entry.line);

  for (const [id, source] of byKey(sources.solutions)) {
    const fields = fieldsOf(source);
    const result = scalar(fields.result);
    if (!source.valid) { exclude(id, 'solution', 'source-invalid'); continue; }
    if (result !== 'resolved') { exclude(id, 'solution', result === 'pending' ? 'pending' : 'not-resolved'); continue; }
    const repositories = list(fields.repositories);
    const component = scalar(fields.component);
    if (!component) { exclude(id, 'solution', 'component-missing'); continue; }
    if (!repositories[0]) { exclude(id, 'solution', 'repository-missing'); continue; }
    const symptom = labelled(bodyOf(source), 'Problema');
    if (!concrete(symptom)) { exclude(id, 'solution', 'no-symptom'); continue; }
    const correction = labelled(bodyOf(source), 'Solução');
    if (!correction) { exclude(id, 'solution', 'no-correction'); continue; }
    const keys = issueKeysOf(fields);
    const url = validRef(fields.reference_url);
    drafts.push({
      id,
      kind: 'solution',
      title: titleOf(bodyOf(source)) || id,
      repository: repositories[0]!,
      repositories,
      component,
      category: scalar(fields.category),
      symptom,
      cause: labelled(bodyOf(source), 'Causa provável') || 'indeterminada no registro',
      confirm: labelled(bodyOf(source), 'Como confirmar') || noConfirm,
      correction: [correction, '', referenceLine(validRef(fields.reference_url))].join('\n'),
      result,
      unresolved: uniq([...rejectedFor(keys, { urls: [url], texts: [bodyOf(source)] }), ...notResolvedFor(id, keys)]),
      sources: [],
      references: refsOf(fields),
    });
  }

  for (const [id, source] of byKey(sources.patterns)) {
    const fields = fieldsOf(source);
    if (!source.valid) { exclude(id, 'pattern', 'source-invalid'); continue; }
    const component = scalar(fields.component);
    if (!component) { exclude(id, 'pattern', 'component-missing'); continue; }
    const repositories = list(fields.repositories);
    if (!repositories[0]) { exclude(id, 'pattern', 'repository-missing'); continue; }
    const symptom = labelled(bodyOf(source), 'Sintoma');
    if (!concrete(symptom)) { exclude(id, 'pattern', 'no-symptom'); continue; }
    const parts: { sid: string; solution: Source }[] = [];
    for (const sid of list(labelled(bodyOf(source), 'Soluções que funcionaram').replace(/\.$/, ''))) {
      const solution = sources.solutions.get(sid);
      if (solution?.valid === true && scalar(fieldsOf(solution).result) === 'resolved' && labelled(bodyOf(solution), 'Solução')) parts.push({ sid, solution });
    }
    if (parts.length === 0) { exclude(id, 'pattern', 'no-correction'); continue; }
    drafts.push({
      id,
      kind: 'pattern',
      title: titleOf(bodyOf(source)) || id,
      repository: repositories[0]!,
      repositories,
      component,
      category: '',
      symptom,
      cause: labelled(bodyOf(parts[0]!.solution), 'Causa provável') || 'indeterminada no registro',
      confirm: labelled(bodyOf(source), 'Onde olhar') || noConfirm,
      correction: parts.map(({ sid, solution }) => [
        `### ${titleOf(bodyOf(solution)) || sid} (${sid})`,
        '',
        labelled(bodyOf(solution), 'Solução'),
        '',
        referenceLine(validRef(fieldsOf(solution).reference_url)),
      ].join('\n')).join('\n\n'),
      unresolved: rejectedFor(uniq([...issueKeysOf(fields), ...parts.flatMap(({ solution }) => issueKeysOf(fieldsOf(solution)))]), {
        urls: parts.map(({ solution }) => validRef(fieldsOf(solution).reference_url)),
        texts: [bodyOf(source), ...parts.map(({ solution }) => bodyOf(solution))],
      }),
      sources: parts.map(({ sid }) => sid),
      references: uniq(parts.flatMap(({ solution }) => refsOf(fieldsOf(solution)))),
    });
  }

  for (const [id, source] of byKey(sources.decisions)) {
    const fields = fieldsOf(source);
    if (!source.valid) { exclude(id, 'decision', 'source-invalid'); continue; }
    if (scalar(fields.outcome) === 'rejected') { exclude(id, 'decision', 'rejected-attached'); continue; }
    const sourceIds = list(fields.source).map(stem);
    const baseId = sourceIds.find(sid => {
      const solution = sources.solutions.get(sid);
      return solution?.valid === true && scalar(fieldsOf(solution).result) === 'resolved';
    });
    const base = baseId === undefined ? undefined : sources.solutions.get(baseId);
    const baseFields: Fields = base ? fieldsOf(base) : {};
    const baseBody = base ? bodyOf(base) : '';
    const repositories = list(fields.repositories).length ? list(fields.repositories) : list(baseFields.repositories);
    const component = scalar(fields.component) || scalar(baseFields.component);
    if (!component) { exclude(id, 'decision', 'component-missing'); continue; }
    if (!repositories[0]) { exclude(id, 'decision', 'repository-missing'); continue; }
    const symptom = labelled(bodyOf(source), 'Sintoma') || labelled(bodyOf(source), 'Problema') || labelled(baseBody, 'Problema');
    if (!concrete(symptom)) { exclude(id, 'decision', 'no-symptom'); continue; }
    const decision = labelled(bodyOf(source), 'Decisão');
    if (!decision) { exclude(id, 'decision', 'no-correction'); continue; }
    const why = labelled(bodyOf(source), 'Por quê');
    const reference = validRef(fields.reference_url) ?? validRef(baseFields.reference_url);
    drafts.push({
      id,
      kind: 'decision',
      title: titleOf(bodyOf(source)) || id,
      repository: repositories[0]!,
      repositories,
      component,
      category: scalar(baseFields.category),
      symptom,
      cause: labelled(baseBody, 'Causa provável') || 'indeterminada no registro',
      confirm: labelled(bodyOf(source), 'Como confirmar') || labelled(bodyOf(source), 'Onde olhar') || labelled(baseBody, 'Como confirmar') || noConfirm,
      correction: [decision, ...(why ? ['', `Por quê: ${why}`] : []), '', referenceLine(reference)].join('\n'),
      unresolved: rejectedFor(uniq([...issueKeysOf(fields), ...issueKeysOf(baseFields)]), {
        urls: [validRef(fields.reference_url), validRef(baseFields.reference_url)],
        texts: [bodyOf(source), baseBody],
      }),
      sources: sourceIds,
      references: uniq([...refsOf(baseFields), ...refsOf(fields)]),
    });
  }

  const candidates = drafts.map(draft => candidateOf(sources, draft));
  const names = new Map<string, number>();
  for (const candidate of candidates) names.set(candidate.name, (names.get(candidate.name) ?? 0) + 1);
  const kept = candidates.filter(candidate => {
    if (!safeName.test(candidate.id)) { exclude(candidate.id, candidate.kind, 'id-invalid'); return false; }
    if ((names.get(candidate.name) ?? 0) > 1) { exclude(candidate.id, candidate.kind, 'name-collision'); return false; }
    return true;
  });
  return { candidates: kept, excluded };
}

/** The SKILL.md of a candidate. Its metadata is the only thing that depends on the date: `indexedAt` keeps a regeneration stable. */
export function renderSkill(candidate: Candidate, fingerprint: string, indexedAt: string): string {
  const sentence = oneLine(candidate.symptom).replace(/\.$/, '').slice(0, maxDescription);
  const description = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} (${candidate.repository}/${candidate.component}). Use quando aparecer esse sintoma.`;
  const origin = [
    `- Registro principal: ${candidate.id} (tipo: ${candidate.kind}${candidate.result ? `, result: ${candidate.result}` : ''})`,
    ...(candidate.sources.length ? [`- Registros de origem: ${candidate.sources.join(', ')}`] : []),
    `- Critérios: ${candidate.ruleIds.join(', ') || 'nenhum'}`,
    `- Glossário: ${candidate.glossaryIds.join(', ') || 'nenhum'}`,
    `- Referências: ${candidate.references.join(', ') || 'nenhuma'}`,
  ];
  return [
    '---',
    `name: ${candidate.name}`,
    `description: ${JSON.stringify(description)}`,
    `metadata: { source_hash: "${fingerprint}", indexed_at: "${indexedAt}" }`,
    '---',
    '',
    `# ${candidate.title}`,
    '',
    '## Sintoma',
    '',
    candidate.symptom,
    '',
    '## Causa',
    '',
    candidate.cause,
    '',
    '## Como confirmar',
    '',
    candidate.confirm,
    '',
    '## Correção que resolveu',
    '',
    candidate.correction,
    '',
    '## O que não resolveu',
    '',
    candidate.unresolved.join('\n') || 'Nenhuma tentativa não resolvida ou rejeitada registrada.',
    '',
    '## Regras e termos usados',
    '',
    '### Regras',
    '',
    candidate.rules.join('\n') || 'Nenhuma regra do time se aplica.',
    '',
    '### Termos',
    '',
    candidate.terms.join('\n') || 'Nenhum termo registrado.',
    '',
    '## Origem',
    '',
    ...origin,
    '',
  ].join('\n');
}

/** Changed lines only (`- ` removed, `+ ` added), from a longest-common-subsequence walk; large files are not compared line by line. */
export function lineDiff(before: string[], after: string[]): string[] {
  const n = before.length;
  const m = after.length;
  if (n * m > 1_000_000) return ['(diferença grande demais para mostrar)'];
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push(`- ${before[i++]}`);
    else out.push(`+ ${after[j++]}`);
  }
  while (i < n) out.push(`- ${before[i++]}`);
  while (j < m) out.push(`+ ${after[j++]}`);
  return out.slice(0, maxDiffLines);
}

function digestOf(items: PlanItem[], excluded: Excluded[], orphans: string[], texts: Map<string, string>): string {
  return hash({
    items: items.map(item => ({
      path: item.path,
      action: item.action,
      reason: item.reason,
      text: texts.has(item.path) ? hash(texts.get(item.path)) : null,
      findings: item.findings ?? null,
    })),
    excluded,
    orphans,
  });
}

/** The plan: what would be written, what is blocked (by rule and line, never by content), what was excluded and what is orphaned. */
export function buildPlan(options: Options): { plan: SkillPlan; texts: Map<string, string> } {
  const sources = loadSources([options.local, ...options.shared]);
  const { candidates, excluded } = buildCandidates(sources);
  const existing = new Map(skillFiles(options.local).map(file => [file.path, file] as const));
  const items: PlanItem[] = [];
  const texts = new Map<string, string>();
  for (const candidate of candidates) {
    const path = `skills/${candidate.id}/SKILL.md`;
    const base = { id: candidate.id, name: candidate.name, path };
    const previous = existing.get(path);
    if (previous?.issue) { items.push({ ...base, action: 'blocked', reason: previous.issue }); continue; }
    const previousMeta = previous ? skillMetadata(previous.text) : undefined;
    const indexedAt = previousMeta?.source_hash === options.fingerprint ? previousMeta.indexed_at : options.date;
    const text = renderSkill(candidate, options.fingerprint, indexedAt);
    const findings = checkSkill(path, text);
    if (findings.length) {
      items.push({ ...base, action: 'blocked', reason: 'check-failed', findings: findings.map(finding => (finding.line === undefined ? { rule: finding.rule } : { rule: finding.rule, line: finding.line })) });
      continue;
    }
    texts.set(path, text);
    if (!previous) items.push({ ...base, action: 'add', reason: 'new' });
    else if (previous.text === text) items.push({ ...base, action: 'unchanged', reason: 'unchanged' });
    else {
      items.push({
        ...base,
        action: 'update',
        reason: previousMeta?.source_hash === options.fingerprint ? 'divergent' : 'source-changed',
        diff: lineDiff(previous.text.split('\n'), text.split('\n')),
      });
    }
  }
  const generated = new Set(candidates.map(candidate => `skills/${candidate.id}/SKILL.md`));
  const orphans = [...existing.values()].filter(file => !file.issue && !generated.has(file.path)).map(file => file.path).sort();
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const plan: SkillPlan = {
    fingerprint: options.fingerprint,
    date: options.date,
    digest: digestOf(items, excluded, orphans, texts),
    items,
    excluded,
    orphans,
  };
  return { plan, texts };
}

/** Writes the add and update items of a plan, when its digest is the one the user approved. Nothing is removed. */
export function write(options: Options & { expect: string }): { plan: SkillPlan; written: string[]; check: Finding[] } {
  const { plan, texts } = buildPlan(options);
  if (plan.digest !== options.expect) throw new Error(`The plan changed since it was approved (digest ${plan.digest}): plan again before writing.`);
  const written: string[] = [];
  for (const item of plan.items) {
    if (item.action !== 'add' && item.action !== 'update') continue;
    for (const target of [join('skills', item.id), item.path]) {
      const issue = pathIssue(options.local, target);
      if (issue && issue !== 'missing') throw new Error(`${target}: ${issue}`);
    }
    mkdirSync(join(options.local, 'skills', item.id), { recursive: true });
    writeFileSync(join(options.local, item.path), texts.get(item.path)!);
    written.push(item.path);
  }
  return { plan, written, check: check(options.local, 'skills').findings };
}

export interface Stale {
  path: string;
  name?: string;
  status: 'current' | 'stale' | 'divergent' | 'orphan' | 'invalid';
  conflicts: { kind: string; detail?: string }[];
}

/** The `result` and the criteria a skill was built from, as its Origem section records them. */
function originOf(text: string): { result?: string; criteria: string[] } {
  const main = /^- Registro principal: \S+ \(tipo: \w+(?:, result: ([\w-]+))?\)$/m.exec(text);
  const criteria = /^- Critérios: (.*)$/m.exec(text);
  return {
    result: main?.[1],
    criteria: criteria && criteria[1] !== 'nenhum' ? criteria[1]!.split(', ') : [],
  };
}

/**
 * Compares the skills of a folder with the current knowledge. `stale` (the fingerprint moved on) names the conflicts that a
 * regeneration would show: a learning whose result changed, a criterion replaced or gone. `divergent` means the fingerprint
 * is the same but the file no longer matches what the generator writes (edited by hand or generated by another version).
 */
export function stale(options: { skills: string; local?: string; shared: string[]; fingerprint: string }): Stale[] {
  const sources = loadSources([...(options.local ? [options.local] : []), ...options.shared]);
  const { candidates } = buildCandidates(sources);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate] as const));
  return skillFiles(options.skills).map((file): Stale => {
    if (file.issue) return { path: file.path, status: 'invalid', conflicts: [{ kind: file.issue }] };
    const name = skillName(file.text);
    const meta = skillMetadata(file.text);
    if (!meta) return { path: file.path, name, status: 'invalid', conflicts: [{ kind: 'skill-metadata-invalid' }] };
    const id = file.path.split('/')[1] ?? '';
    const candidate = byId.get(id);
    if (meta.source_hash !== options.fingerprint) {
      const conflicts: Stale['conflicts'] = [];
      const origin = originOf(file.text);
      const source = sources.solutions.get(id);
      if (origin.result) {
        const now = source?.valid === true ? scalar(fieldsOf(source).result) : '';
        if (now !== origin.result) conflicts.push({ kind: 'result-changed', detail: `${origin.result} -> ${now || 'indisponível'}` });
      }
      if (!candidate) conflicts.push({ kind: 'source-missing' });
      const replaced = origin.criteria.filter(criterion => !sources.criteria.has(criterion));
      if (candidate && replaced.length) conflicts.push({ kind: 'criterion-replaced', detail: replaced.join(', ') });
      return { path: file.path, name, status: 'stale', conflicts };
    }
    if (!candidate) return { path: file.path, name, status: 'orphan', conflicts: [{ kind: 'source-missing' }] };
    const same = renderSkill(candidate, options.fingerprint, meta.indexed_at) === file.text;
    return { path: file.path, name, status: same ? 'current' : 'divergent', conflicts: same ? [] : [{ kind: 'skill-divergent' }] };
  });
}

export function main(argv: string[]): { output: string; code: number } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        local: { type: 'string' },
        shared: { type: 'string', multiple: true },
        skills: { type: 'string' },
        fingerprint: { type: 'string' },
        date: { type: 'string' },
        expect: { type: 'string' },
      },
    });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${usage}`);
  }
  const { positionals: [command, ...rest], values } = parsed;
  if (rest.length) throw new Error(usage);
  const shared = values.shared ?? [];
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  if (!isCalendarDate(date)) throw new Error(`--date must be AAAA-MM-DD.\n${usage}`);
  const fingerprint = values.fingerprint ?? '';
  if (command === 'plan' || command === 'write') {
    if (values.local === undefined || !fingerprintPattern.test(fingerprint)) throw new Error(usage);
    const options = { local: values.local, shared, fingerprint, date };
    if (command === 'plan') return { output: JSON.stringify(buildPlan(options).plan), code: 0 };
    if (values.expect === undefined) throw new Error(usage);
    const result = write({ ...options, expect: values.expect });
    return { output: JSON.stringify({ written: result.written, check: result.check }), code: result.check.some(finding => finding.severity === 'error') ? 1 : 0 };
  }
  if (command === 'stale') {
    if (values.skills === undefined || !fingerprintPattern.test(fingerprint)) throw new Error(usage);
    const skills = stale({ skills: values.skills, local: values.local, shared, fingerprint });
    return { output: JSON.stringify({ fingerprint, skills }), code: 0 };
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
