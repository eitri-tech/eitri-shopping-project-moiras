/* Reads `.gitignore` files without running Git, so a recursive walk can leave ignored files and folders out before it touches them.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable (no enums, namespaces or
 * parameter properties) and import siblings with the .ts extension.
 *
 * Follows gitignore(5): blank lines and `#` comments, `!` negation, a trailing `/` for folders only, a leading or inner `/` anchors
 * the pattern to the folder of the file, `*`, `?`, `[...]`, `\` escapes and `**` as a whole path segment. Matching is case sensitive.
 * `.git/info/exclude` and the user-level ignore file are not read: they belong to one clone or one person, not to the repository.
 *
 * Patterns are matched segment by segment with no regular expressions, so a hostile `.gitignore` cannot make a match slow.
 */

type Piece =
  | { kind: 'char'; char: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'class'; negated: boolean; items: (string | [string, string])[] };

/** One path segment of a pattern: its pieces, or a `**` that stands for any number of folders. */
type Segment = Piece[] | 'globstar';

export interface IgnoreRule {
  negated: boolean;
  /** The pattern ended with `/`: it only applies to folders. */
  dirOnly: boolean;
  /** The pattern held a slash: it matches from the folder of its `.gitignore`, not at any depth. */
  anchored: boolean;
  segments: Segment[];
}

/** The rules of one `.gitignore`, and the folder it sits in (relative to the base, `/`-separated; empty for the base itself). */
export interface IgnoreLayer {
  dir: string;
  rules: IgnoreRule[];
}

const maxLineLength = 1024;
const maxRules = 10_000;

/** Index of the `]` that closes the class opened at `open`, or -1. A `]` right after the opening (and any `!` or `^`) is a member. */
function classEnd(chars: string[], open: number): number {
  let index = open + 1;
  if (chars[index] === '!' || chars[index] === '^') index += 1;
  if (chars[index] === ']') index += 1;
  for (; index < chars.length; index += 1) {
    if (chars[index] === '\\') index += 1;
    else if (chars[index] === ']') return index;
  }
  return -1;
}

function classOf(chars: string[]): Piece {
  let negated = false;
  let rest = chars;
  if (rest[0] === '!' || rest[0] === '^') { negated = true; rest = rest.slice(1); }
  const members: string[] = [];
  const marks: boolean[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '\\' && index + 1 < rest.length) { index += 1; members.push(rest[index]!); marks.push(false); }
    else { members.push(rest[index]!); marks.push(rest[index] === '-'); }
  }
  const items: (string | [string, string])[] = [];
  for (let index = 0; index < members.length; index += 1) {
    // `a-z` is a range when the dash sits between two members; a dash first or last is itself.
    if (marks[index + 1] && index + 2 < members.length) { items.push([members[index]!, members[index + 2]!]); index += 2; }
    else items.push(members[index]!);
  }
  return { kind: 'class', negated, items };
}

/** The pieces of one segment of a pattern. */
function piecesOf(segment: string): Piece[] {
  const chars = Array.from(segment);
  const pieces: Piece[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === '\\') { index += 1; pieces.push({ kind: 'char', char: index < chars.length ? chars[index]! : '\\' }); }
    else if (char === '*') { while (chars[index + 1] === '*') index += 1; if (pieces.at(-1)?.kind !== 'star') pieces.push({ kind: 'star' }); }
    else if (char === '?') pieces.push({ kind: 'any' });
    else if (char === '[') {
      const close = classEnd(chars, index);
      if (close === -1) pieces.push({ kind: 'char', char });
      else { pieces.push(classOf(chars.slice(index + 1, close))); index = close; }
    } else pieces.push({ kind: 'char', char });
  }
  return pieces;
}

function pieceMatches(piece: Piece, char: string): boolean {
  if (piece.kind === 'char') return piece.char === char;
  if (piece.kind === 'any') return true;
  if (piece.kind !== 'class') return false;
  const found = piece.items.some(item => (typeof item === 'string' ? item === char : item[0] <= char && char <= item[1]));
  return found !== piece.negated;
}

/** `*`, `?` and classes against one name, in time proportional to the name times the pattern (no backtracking blow-up). */
function nameMatches(pieces: Piece[], name: string): boolean {
  const chars = Array.from(name);
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < chars.length) {
    const piece = pieces[p];
    if (piece?.kind === 'star') { star = p; resume = n; p += 1; }
    else if (piece && pieceMatches(piece, chars[n]!)) { p += 1; n += 1; }
    else if (star !== -1) { p = star + 1; resume += 1; n = resume; }
    else return false;
  }
  while (pieces[p]?.kind === 'star') p += 1;
  return p === pieces.length;
}

/** The whole pattern against the segments of a path, with `**` taking zero or more of them (at least one when it is last). */
function segmentsMatch(segments: Segment[], path: string[]): boolean {
  const memo = new Map<number, boolean>();
  const at = (s: number, p: number): boolean => {
    const key = s * (path.length + 1) + p;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const segment = segments[s];
    let result: boolean;
    if (segment === undefined) result = p === path.length;
    else if (segment === 'globstar') {
      const last = s === segments.length - 1;
      result = last ? p < path.length : at(s + 1, p) || (p < path.length && at(s, p + 1));
    } else result = p < path.length && nameMatches(segment, path[p]!) && at(s + 1, p + 1);
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

/** Turns the text of a `.gitignore` into rules, in file order. Lines that cannot be read as a pattern are skipped. */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    if (rules.length >= maxRules) break;
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '' || line[0] === '#' || line.length > maxLineLength) continue;
    // Trailing spaces go away unless escaped with a backslash.
    while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1);
    const negated = line[0] === '!';
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line[0] === '/') line = line.slice(1);
    if (line === '') continue;
    const raws = line.split('/');
    const segments: Segment[] = [];
    for (const part of raws) {
      if (part === '') continue;
      // `**` is a whole segment only between slashes; alone in a pattern without a slash it is just a star.
      if (part === '**' && raws.length > 1) {
        if (segments.at(-1) !== 'globstar') segments.push('globstar');
      } else segments.push(piecesOf(part));
    }
    if (segments.length) rules.push({ negated, dirOnly, anchored, segments });
  }
  return rules;
}

/**
 * Whether `relativePath` (relative to the base, `/`-separated) is ignored. `layers` go from the outermost folder to the innermost, and
 * the last rule that matches wins, so a deeper `.gitignore` can re-include what a shallower one excluded. A path inside an ignored folder
 * is the caller's to skip: it must not descend into a folder this returns true for.
 */
export function isIgnored(layers: IgnoreLayer[], relativePath: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const { dir, rules } of layers) {
    let local = relativePath;
    if (dir !== '') {
      if (!relativePath.startsWith(`${dir}/`)) continue;
      local = relativePath.slice(dir.length + 1);
    }
    const path = local.split('/');
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) continue;
      const matches = rule.anchored ? segmentsMatch(rule.segments, path) : nameMatches(rule.segments[0] as Piece[], path.at(-1)!);
      if (matches) ignored = !rule.negated;
    }
  }
  return ignored;
}
