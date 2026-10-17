/* Reads `.gitignore` files without running Git, so a recursive walk can leave ignored files and folders out before it touches them.
 *
 * Runs as-is on Node (type stripping): keep the syntax erasable (no enums, namespaces or
 * parameter properties) and import siblings with the .ts extension.
 *
 * Follows gitignore(5): blank lines and `#` comments, `!` negation, a trailing `/` for folders only, a leading or inner `/` anchors
 * the pattern to the folder of the file, `*`, `?`, `[...]` (with POSIX classes such as `[:digit:]`), `\\` escapes and `**` as a whole
 * path segment. Matching is case sensitive and works on bytes, like Git. `.git/info/exclude` and the user-level ignore file are not
 * read: they belong to one clone or one person, not to the repository.
 *
 * Wherever this reader and Git could disagree, it excludes less: a pattern Git would reject never matches, and a file that is too
 * big or too costly to evaluate excludes nothing. Excluding more would drop files from a hash that Git still counts.
 * Patterns are matched segment by segment with no regular expressions, so a hostile `.gitignore` cannot make a match slow.
 */

type Item = number | [number, number] | string;

type Piece =
  | { kind: 'char'; byte: number }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'class'; negated: boolean; items: Item[] };

/** One path segment of a pattern: its pieces, or a `**` that stands for any number of folders. */
type Segment = Piece[] | 'globstar';

export interface IgnoreRule {
  negated: boolean;
  /** The pattern ended with `/`: it only applies to folders. */
  dirOnly: boolean;
  /** The pattern held a slash: it matches from the folder of its `.gitignore`, not at any depth. */
  anchored: boolean;
  segments: Segment[];
  /** A plain name with no wildcard, at any depth: compared byte for byte, the cheapest and most common rule. */
  literal?: Buffer;
}

/** The rules of one `.gitignore`, and the folder it sits in (relative to the base, `/`-separated; empty for the base itself). */
export interface IgnoreLayer {
  dir: string;
  /** How many folders `dir` has (0 for the base). */
  depth: number;
  rules: IgnoreRule[];
}

/** The layer for the `.gitignore` with this text, in `dir` (relative to the base, `/`-separated). */
export function layerOf(dir: string, text: string): IgnoreLayer {
  return { dir, depth: dir === '' ? 0 : dir.split('/').length, rules: parseIgnore(text) };
}

const maxLineLength = 1024;
const maxRules = 2_000;
/** Pieces over the whole file: bounds the work of matching one name against every rule. */
const maxPieces = 20_000;

const BACKSLASH = 0x5c;
const posix: Record<string, (byte: number) => boolean> = {
  alpha: byte => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a),
  digit: byte => byte >= 0x30 && byte <= 0x39,
  alnum: byte => posix.alpha!(byte) || posix.digit!(byte),
  upper: byte => byte >= 0x41 && byte <= 0x5a,
  lower: byte => byte >= 0x61 && byte <= 0x7a,
  space: byte => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d),
  blank: byte => byte === 0x20 || byte === 0x09,
  punct: byte => (byte >= 0x21 && byte <= 0x2f) || (byte >= 0x3a && byte <= 0x40) || (byte >= 0x5b && byte <= 0x60) || (byte >= 0x7b && byte <= 0x7e),
  xdigit: byte => posix.digit!(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66),
  cntrl: byte => byte < 0x20 || byte === 0x7f,
  graph: byte => byte >= 0x21 && byte <= 0x7e,
  print: byte => byte >= 0x20 && byte <= 0x7e,
};

const code = (char: string) => char.charCodeAt(0);

/** Index of the `]` that closes the class opened at `open`, or -1. A `]` right after the opening (and any `!` or `^`) is a member. */
function classEnd(bytes: number[], open: number): number {
  let index = open + 1;
  if (bytes[index] === code('!') || bytes[index] === code('^')) index += 1;
  if (bytes[index] === code(']')) index += 1;
  for (; index < bytes.length; index += 1) {
    if (bytes[index] === BACKSLASH) index += 1;
    else if (bytes[index] === code('[') && bytes[index + 1] === code(':')) {
      // `[:name:]` holds a `]` of its own.
      let end = index + 2;
      while (end < bytes.length - 1 && !(bytes[end] === code(':') && bytes[end + 1] === code(']'))) end += 1;
      if (end < bytes.length - 1) index = end + 1;
    } else if (bytes[index] === code(']')) return index;
  }
  return -1;
}

/** The members of a class, or undefined when Git would reject it (an unknown `[:name:]`). */
function classOf(body: number[]): Piece | undefined {
  let negated = false;
  let rest = body;
  if (rest[0] === code('!') || rest[0] === code('^')) { negated = true; rest = rest.slice(1); }
  const members: (number | string)[] = [];
  const dashes: boolean[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const byte = rest[index]!;
    if (byte === BACKSLASH && index + 1 < rest.length) { index += 1; members.push(rest[index]!); dashes.push(false); }
    else if (byte === code('[') && rest[index + 1] === code(':')) {
      let end = index + 2;
      while (end < rest.length - 1 && !(rest[end] === code(':') && rest[end + 1] === code(']'))) end += 1;
      if (end >= rest.length - 1) { members.push(byte); dashes.push(false); continue; }
      const name = Buffer.from(rest.slice(index + 2, end)).toString('latin1');
      if (!Object.hasOwn(posix, name)) return undefined;
      members.push(name);
      dashes.push(false);
      index = end + 1;
    } else { members.push(byte); dashes.push(byte === code('-')); }
  }
  const items: Item[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const from = members[index]!;
    const to = members[index + 2];
    // `a-z` is a range when the dash sits between two single members; a dash first or last is itself.
    if (dashes[index + 1] && typeof from === 'number' && typeof to === 'number') {
      if (from > to) return undefined;
      items.push([from, to]);
      index += 2;
    } else items.push(from);
  }
  return { kind: 'class', negated, items };
}

/** The pieces of one segment of a pattern, or undefined when Git would reject it (so the rule never matches). */
function piecesOf(segment: string): Piece[] | undefined {
  const bytes = Array.from(Buffer.from(segment, 'utf8'));
  const pieces: Piece[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === BACKSLASH) {
      index += 1;
      if (index >= bytes.length) return undefined;
      pieces.push({ kind: 'char', byte: bytes[index]! });
    } else if (byte === code('*')) {
      while (bytes[index + 1] === code('*')) index += 1;
      if (pieces.at(-1)?.kind !== 'star') pieces.push({ kind: 'star' });
    } else if (byte === code('?')) pieces.push({ kind: 'any' });
    else if (byte === code('[')) {
      const close = classEnd(bytes, index);
      if (close === -1) return undefined;
      const piece = classOf(bytes.slice(index + 1, close));
      if (!piece) return undefined;
      pieces.push(piece);
      index = close;
    } else pieces.push({ kind: 'char', byte });
  }
  return pieces;
}

function pieceMatches(piece: Piece, byte: number): boolean {
  if (piece.kind === 'char') return piece.byte === byte;
  if (piece.kind === 'any') return true;
  if (piece.kind !== 'class') return false;
  const found = piece.items.some(item => (typeof item === 'number' ? item === byte : typeof item === 'string' ? posix[item]!(byte) : item[0] <= byte && byte <= item[1]));
  return found !== piece.negated;
}

/** `*`, `?` and classes against one name, in time proportional to the name times the pattern (no backtracking blow-up). */
function nameMatches(pieces: Piece[], name: Buffer): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    const piece = pieces[p];
    if (piece?.kind === 'star') { star = p; resume = n; p += 1; }
    else if (piece && pieceMatches(piece, name[n]!)) { p += 1; n += 1; }
    else if (star !== -1) { p = star + 1; resume += 1; n = resume; }
    else return false;
  }
  while (pieces[p]?.kind === 'star') p += 1;
  return p === pieces.length;
}

/** The whole pattern against the segments of a path, with `**` taking zero or more of them (at least one when it is last). */
function segmentsMatch(segments: Segment[], path: Buffer[]): boolean {
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

/** Trailing spaces go away unless escaped: a space is escaped when an odd number of backslashes precede it. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    let slashes = 0;
    while (end - 2 - slashes >= 0 && line[end - 2 - slashes] === '\\') slashes += 1;
    if (slashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

/**
 * Turns the text of a `.gitignore` into rules, in file order. A line Git would reject (an unclosed `[`, a lone trailing backslash,
 * an empty segment such as `a//b`) never matches. A file with a line over 1024 characters, more than 2000 rules or too many pieces
 * is not read at all: it excludes nothing, rather than a truncated part of it excluding too much.
 */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  let pieces = 0;
  // Git drops a UTF-8 byte order mark before the first rule.
  for (const raw of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n')) {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > maxLineLength) return [];
    if (line === '' || line[0] === '#') continue;
    line = trimTrailingSpaces(line);
    const negated = line[0] === '!';
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line[0] === '/') line = line.slice(1);
    if (line === '') continue;
    const parts = line.split('/');
    const segments: Segment[] = [];
    let valid = true;
    for (const part of parts) {
      // `**` is a whole segment only between slashes; alone in a pattern without a slash it is just a star.
      if (part === '**' && parts.length > 1) {
        if (segments.at(-1) !== 'globstar') segments.push('globstar');
        continue;
      }
      const made = part === '' ? undefined : piecesOf(part);
      if (!made) { valid = false; break; }
      pieces += made.length;
      segments.push(made);
    }
    if (pieces > maxPieces) return [];
    if (valid && segments.length) {
      const only = segments[0];
      const rule: IgnoreRule = { negated, dirOnly, anchored, segments };
      if (!anchored && Array.isArray(only) && only.every(piece => piece.kind === 'char')) rule.literal = Buffer.from(only.map(piece => (piece as { byte: number }).byte));
      rules.push(rule);
    }
    if (rules.length > maxRules) return [];
  }
  return rules;
}

function apply(layer: IgnoreLayer, parts: Buffer[], isDirectory: boolean, ignored: boolean): boolean {
  let result = ignored;
  let local: Buffer[] | undefined;
  for (const rule of layer.rules) {
    if (rule.dirOnly && !isDirectory) continue;
    let matches: boolean;
    if (rule.literal) matches = parts[parts.length - 1]!.equals(rule.literal);
    else if (rule.anchored) { local ??= layer.depth === 0 ? parts : parts.slice(layer.depth); matches = segmentsMatch(rule.segments, local); }
    else matches = nameMatches(rule.segments[0] as Piece[], parts[parts.length - 1]!);
    if (matches) result = !rule.negated;
  }
  return result;
}

/**
 * Whether the path made of `parts` (the names from the base down, as bytes) is ignored by `layers`, which must all be folders on the
 * way to it, outermost first. The last rule that matches wins, so a deeper `.gitignore` can re-include what a shallower one excluded.
 * A path inside an ignored folder is the caller's to skip: it must not descend into a folder this returns true for.
 */
export function isIgnoredParts(layers: IgnoreLayer[], parts: Buffer[], isDirectory: boolean): boolean {
  let ignored = false;
  for (const layer of layers) ignored = apply(layer, parts, isDirectory, ignored);
  return ignored;
}

/** Same as `isIgnoredParts`, for a `/`-separated path relative to the base; layers of folders that are not above the path are skipped. */
export function isIgnored(layers: IgnoreLayer[], relativePath: string, isDirectory: boolean): boolean {
  const parts = relativePath.split('/').map(part => Buffer.from(part, 'utf8'));
  return isIgnoredParts(layers.filter(layer => layer.dir === '' || relativePath.startsWith(`${layer.dir}/`)), parts, isDirectory);
}
