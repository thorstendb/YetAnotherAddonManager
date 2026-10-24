// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Byte-exact reader for ESO SavedVariables files, built for removing entries.
 *
 * The game writes these files as indented Lua tables with CRLF line endings;
 * some tools (the TTC client, profile importers) rewrite them compactly on a
 * single line.  Both are plain Lua table constructors, so this parser reads
 * Lua table syntax instead of relying on the game's layout.
 *
 * Nothing is ever re-serialized.  Each entry records its byte range, and
 * removing entries cuts exactly those ranges out of the original buffer — every
 * byte that is not removed stays identical by construction.  The parser works
 * on bytes, not decoded text: SavedVariables may hold arbitrary (even invalid)
 * UTF-8 inside strings, and a decode/encode round trip would silently alter it.
 * All syntax characters are ASCII, and UTF-8 continuation bytes are >= 0x80,
 * so they can never be mistaken for a quote or a backslash.
 */

export interface SvNode {
  /** String keys unescaped (raw bytes as UTF-8); numeric keys and positional
   *  entries as their literal text / 1-based index */
  key: string;
  keyIsString: boolean;
  /** First byte of the entry: the '[' of the key, an identifier key, or a positional value */
  start: number;
  /** Byte just past the entry, including a following ',' or ';' */
  end: number;
  /** Entries of a table value */
  children?: SvNode[];
  /** Raw text of a scalar value (strings keep their quotes) */
  value?: string;
}

export class SvParseError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(`${message} at byte ${offset}`);
  }
}

const QUOTE = 0x22, APOS = 0x27, BACKSLASH = 0x5c, LBRACE = 0x7b, RBRACE = 0x7d;
const LBRACKET = 0x5b, RBRACKET = 0x5d, EQUALS = 0x3d, COMMA = 0x2c, SEMICOLON = 0x3b;
const CR = 0x0d, LF = 0x0a;

const isWs = (b: number) => b === 0x20 || b === 0x09 || b === CR || b === LF;
const isIdentStart = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f;
const isIdentPart = (b: number) => isIdentStart(b) || (b >= 0x30 && b <= 0x39);
/** Ends a bare scalar (number, true/false/nil, or oddities like 1.#INF) */
const isDelimiter = (b: number) => isWs(b) || b === COMMA || b === SEMICOLON || b === RBRACE || b === RBRACKET;

class Parser {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  parseFile(): SvNode[] {
    const vars: SvNode[] = [];
    this.skipWs();
    while (this.pos < this.buf.length) {
      const start = this.pos;
      if (!isIdentStart(this.buf[this.pos])) throw new SvParseError('Expected a variable name', this.pos);
      const name = this.readIdent();
      this.skipWs();
      this.expect(EQUALS, "'='");
      this.skipWs();
      const node: SvNode = { key: name, keyIsString: true, start, end: 0 };
      this.readValue(node);
      node.end = this.pos;
      vars.push(node);
      this.skipWs();
    }
    return vars;
  }

  private readValue(node: SvNode): void {
    const b = this.buf[this.pos];
    if (b === LBRACE) {
      node.children = this.readTable();
    } else if (b === QUOTE || b === APOS) {
      const start = this.pos;
      this.readString();
      node.value = this.text(start, this.pos);
    } else if (b !== undefined && !isDelimiter(b) && b !== EQUALS) {
      const start = this.pos;
      while (this.pos < this.buf.length && !isDelimiter(this.buf[this.pos])) this.pos++;
      node.value = this.text(start, this.pos);
    } else {
      throw new SvParseError('Expected a value', this.pos);
    }
  }

  private readTable(): SvNode[] {
    this.expect(LBRACE, "'{'");
    const entries: SvNode[] = [];
    let positional = 0;
    for (;;) {
      this.skipWs();
      if (this.pos >= this.buf.length) throw new SvParseError('Unterminated table', this.pos);
      if (this.buf[this.pos] === RBRACE) {
        this.pos++;
        return entries;
      }
      const start = this.pos;
      let node: SvNode;
      if (this.buf[this.pos] === LBRACKET) {
        this.pos++;
        this.skipWs();
        const keyStart = this.pos;
        let key: string;
        let keyIsString: boolean;
        if (this.buf[this.pos] === QUOTE || this.buf[this.pos] === APOS) {
          key = this.readString();
          keyIsString = true;
        } else {
          while (this.pos < this.buf.length && !isDelimiter(this.buf[this.pos])) this.pos++;
          if (this.pos === keyStart) throw new SvParseError('Empty key', this.pos);
          key = this.text(keyStart, this.pos);
          keyIsString = false;
        }
        this.skipWs();
        this.expect(RBRACKET, "']'");
        this.skipWs();
        this.expect(EQUALS, "'='");
        this.skipWs();
        node = { key, keyIsString, start, end: 0 };
        this.readValue(node);
      } else if (isIdentStart(this.buf[this.pos]) && this.identFollowedByEquals()) {
        const key = this.readIdent();
        this.skipWs();
        this.expect(EQUALS, "'='");
        this.skipWs();
        node = { key, keyIsString: true, start, end: 0 };
        this.readValue(node);
      } else {
        positional++;
        node = { key: String(positional), keyIsString: false, start, end: 0 };
        this.readValue(node);
      }
      node.end = this.pos;
      // The separator belongs to the entry, so removing it leaves valid syntax
      let look = this.pos;
      while (look < this.buf.length && isWs(this.buf[look])) look++;
      if (this.buf[look] === COMMA || this.buf[look] === SEMICOLON) {
        this.pos = look + 1;
        node.end = this.pos;
      } else if (this.buf[look] !== RBRACE) {
        throw new SvParseError("Expected ',' or '}'", look);
      }
      entries.push(node);
    }
  }

  /** Returns the unescaped content; leaves pos after the closing quote */
  private readString(): string {
    const quote = this.buf[this.pos++];
    const contentStart = this.pos;
    let escaped = false;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos];
      if (b === BACKSLASH) {
        escaped = true;
        this.pos += 2;
        continue;
      }
      if (b === quote) {
        const raw = this.text(contentStart, this.pos);
        this.pos++;
        return escaped ? unescapeLua(raw) : raw;
      }
      if (b === LF || b === CR) throw new SvParseError('Line break in string', this.pos);
      this.pos++;
    }
    throw new SvParseError('Unterminated string', contentStart - 1);
  }

  private readIdent(): string {
    const start = this.pos;
    while (this.pos < this.buf.length && isIdentPart(this.buf[this.pos])) this.pos++;
    return this.text(start, this.pos);
  }

  private identFollowedByEquals(): boolean {
    let p = this.pos;
    while (p < this.buf.length && isIdentPart(this.buf[p])) p++;
    while (p < this.buf.length && isWs(this.buf[p])) p++;
    return this.buf[p] === EQUALS && this.buf[p + 1] !== EQUALS;
  }

  private expect(byte: number, what: string): void {
    if (this.buf[this.pos] !== byte) throw new SvParseError(`Expected ${what}`, this.pos);
    this.pos++;
  }

  private skipWs(): void {
    while (this.pos < this.buf.length && isWs(this.buf[this.pos])) this.pos++;
  }

  private text(from: number, to: number): string {
    return Buffer.from(this.buf.buffer, this.buf.byteOffset + from, to - from).toString('utf-8');
  }
}

function unescapeLua(raw: string): string {
  return raw.replace(/\\(\d{1,3}|.)/g, (_m, c: string) => {
    if (/^\d/.test(c)) return String.fromCharCode(parseInt(c, 10));
    return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? c;
  });
}

/** Parse a SavedVariables file into its top-level variables. Throws SvParseError. */
export function parseSavedVars(buf: Uint8Array): SvNode[] {
  return new Parser(buf).parseFile();
}

/**
 * The byte range removing `node` actually cuts: the entry itself, widened to
 * whole lines when it occupies its lines alone (the game's indented layout),
 * so no blank, whitespace-only line is left behind.
 */
export function removalRange(buf: Uint8Array, node: SvNode): [number, number] {
  let from = node.start;
  while (from > 0 && (buf[from - 1] === 0x20 || buf[from - 1] === 0x09)) from--;
  const atLineStart = from === 0 || buf[from - 1] === LF;
  let to = node.end;
  while (to < buf.length && (buf[to] === 0x20 || buf[to] === 0x09)) to++;
  if (atLineStart && (buf[to] === CR || buf[to] === LF)) {
    if (buf[to] === CR) to++;
    if (buf[to] === LF) to++;
    return [from, to];
  }
  return [node.start, node.end];
}

/**
 * Remove entries from a SavedVariables buffer.  Entries nested inside another
 * removed entry are skipped.  The result is parsed again before it is
 * returned, so a cut that would leave invalid syntax throws instead of
 * producing a file the game cannot load.
 */
export function removeEntries(buf: Uint8Array, nodes: SvNode[]): { output: Buffer; removedBytes: number; removedEntries: number } {
  const ranges = nodes.map((n) => removalRange(buf, n)).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept: [number, number][] = [];
  for (const r of ranges) {
    const last = kept[kept.length - 1];
    if (last && r[0] < last[1]) continue; // inside an entry already removed
    kept.push(r);
  }
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let removedBytes = 0;
  for (const [from, to] of kept) {
    parts.push(buf.subarray(cursor, from));
    removedBytes += to - from;
    cursor = to;
  }
  parts.push(buf.subarray(cursor));
  const output = Buffer.concat(parts);
  parseSavedVars(output);
  return { output, removedBytes, removedEntries: kept.length };
}

/** Depth-first walk with the chain of ancestors (outermost first) */
export function walkSavedVars(
  nodes: SvNode[],
  visit: (node: SvNode, ancestors: SvNode[]) => boolean | void,
  ancestors: SvNode[] = []
): void {
  for (const node of nodes) {
    // Returning true prunes the subtree
    if (visit(node, ancestors) === true || !node.children) continue;
    walkSavedVars(node.children, visit, [...ancestors, node]);
  }
}

/**
 * Entries along a key path; '*' matches any key.  The first element names the
 * top-level variable.
 */
export function selectPath(roots: SvNode[], path: string[]): SvNode[] {
  let level = roots.filter((n) => path[0] === '*' || n.key === path[0]);
  for (const key of path.slice(1)) {
    level = level.flatMap((n) => (n.children ?? []).filter((c) => key === '*' || c.key === key));
  }
  return level;
}
