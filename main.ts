// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits). Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Files: lines, line break, final break (SPEC.md section 3)           */
/* ------------------------------------------------------------------ */

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC.md section 5)                   */
/* ------------------------------------------------------------------ */

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** All 0-based positions where `pat` occurs in `lines` at `tier` (overlaps count). */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0 || pat.length > lines.length) return out;
  const np = pat.map((l) => norm(l, tier));
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (norm(lines[i + j]!, tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

const TIERS = [0, 1, 2];

/** First tier (tier 0 only when strict) with an occurrence at or after `from`. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const tier of strict ? [0] : TIERS) {
    const occ = occurrences(lines, pat, tier).filter((i) => i >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of an old/new pair: `ctx` marks a context line (written as the file's own). */
interface ONLine {
  text: string;
  ctx: boolean;
}

/**
 * Build the replacement lines for an occurrence at `at`: context lines come from the
 * file itself, other lines of N are re-indented at tier 2 (SPEC.md section 5).
 */
function buildReplacement(fileLines: string[], at: number, o: ONLine[], n: ONLine[], tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((line, idx) => {
    if (line.ctx) oCtx.push(idx);
  });
  const f = leadingWs(fileLines[at] ?? '');
  const p = leadingWs(o.length > 0 ? o[0]!.text : '');
  const out: string[] = [];
  let k = 0;
  for (const line of n) {
    if (line.ctx) {
      out.push(fileLines[at + oCtx[k]!]!);
      k += 1;
    } else if (tier === 2) {
      const t = line.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(line.text);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9) — as the kit's starter has them       */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UniBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** The raw patch line, kept so trailing truly-empty lines can be told apart. */
  raw: string;
}

interface UniHunk {
  a: number;
  body: UniBodyLine[];
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: UniHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function isDiffGitLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed; /dev/null means no file. */
function headerPath(l: string): string | null {
  let rest = l.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function parseHunkHeader(l: string, idx: number): UniHunk {
  const m = HUNK_RE.exec(l);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return { a: Number(m[1]), body: [] };
}

/** Collect a hunk's body starting at `start`; returns the index after the body. */
function parseHunkBody(lines: string[], start: number, hunk: UniHunk): number {
  let j = start;
  const body: UniBodyLine[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (isDiffGitLine(l)) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '', raw: l });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ kind: c, text: l.slice(1), raw: l });
      j += 1;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: '\\', text: l, raw: l });
      j += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it (truly empty patch lines).
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  hunk.body = body;
  return j;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastCP(hunk: UniHunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    const b = hunk.body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      return hunk.body[k + 1]?.kind === '\\';
    }
  }
  return false;
}

/** Split a hunk/chunk body into its old lines O and new lines N (SPEC.md sections 5-8). */
function hunkON(body: UniBodyLine[]): { o: ONLine[]; n: ONLine[] } {
  const o: ONLine[] = [];
  const n: ONLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true });
    } else if (b.kind === '-') {
      o.push({ text: b.text, ctx: false });
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: false });
    }
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match', path). */
function applyHunks(text: string, hunks: UniHunk[], strict: boolean, path: string): string {
  const cur = parseFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = hunkON(hunk.body);
    const oTexts = o.map((l) => l.text);
    if (o.length > 0) {
      const found = findTier(cur.lines, oTexts, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const i of found.occ) {
        const dist = Math.abs(i - target);
        if (dist < bestDist) {
          best = i;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === cur.lines.length;
      const repl = buildReplacement(cur.lines, best, o, n, found.tier);
      cur.lines = [...cur.lines.slice(0, best), ...repl, ...cur.lines.slice(best + o.length)];
      if (atEnd) cur.final = !backslashAfterLastCP(hunk);
      d += n.length - o.length;
    } else {
      const idx = Math.min(Math.max(hunk.a + d, 0), cur.lines.length);
      const atEnd = idx === cur.lines.length;
      cur.lines = [...cur.lines.slice(0, idx), ...n.map((l) => l.text), ...cur.lines.slice(idx)];
      if (atEnd) cur.final = !backslashAfterLastCP(hunk);
      d += n.length;
    }
  }
  return serializeFile(cur);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let inHeader = false;
  const fresh = (): UniSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    isNew: false,
    isDeleted: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = fresh();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || !inHeader) {
        sec = fresh();
        sections.push(sec);
        inHeader = true;
      }
      sec.pairOld = headerPath(l);
      sec.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (sec !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        sec.pairNew = headerPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isNew = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDeleted = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const hunk = parseHunkHeader(l, i);
        inHeader = false;
        i = parseHunkBody(lines, i + 1, hunk);
        sec.hunks.push(hunk);
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk = parseHunkHeader(l, i);
      inHeader = false;
      i = parseHunkBody(lines, i + 1, hunk);
      sec.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return sections.map((s) => {
    const oldP = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
    const newP = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.diffNew;
    const hunks = s.hunks;
    if (oldP === undefined || newP === undefined) {
      return () => {
        throw new Fail('unsafe', '');
      };
    }
    const isCreate = oldP === null || s.isNew;
    const isDelete = !isCreate && (newP === null || s.isDeleted);
    if (isCreate) {
      const newPath = newP;
      return (tree) => {
        if (newPath === null) throw new Fail('unsafe', '');
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        let lastPlus: { hunk: UniHunk; k: number } | null = null;
        for (const hunk of hunks) {
          hunk.body.forEach((b, k) => {
            if (b.kind === '+') {
              plus.push(b.text);
              lastPlus = { hunk, k };
            }
          });
        }
        const noFinal = lastPlus !== null && lastPlus.hunk.body[lastPlus.k + 1]?.kind === '\\';
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      };
    }
    if (isDelete) {
      const oldPath = oldP;
      return (tree) => {
        if (oldPath === null) throw new Fail('unsafe', '');
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }
    const oldPath = oldP as string;
    const newPath = newP as string;
    if (oldPath !== newPath) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const cur = tree.get(oldPath);
        if (cur === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(cur, hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push({ old: oldPath, new: newPath });
      };
    }
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, applyHunks(cur, hunks, strict, oldPath));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      let eq = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(((p, oldL, newL) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (oldL.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
          return;
        }
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        const f = parseFile(cur);
        const found = findTier(f.lines, oldL, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.occ.length > 1) throw new Fail('ambiguous', p);
        const at = found.occ[0]!;
        const o: ONLine[] = oldL.map((t) => ({ text: t, ctx: false }));
        const n: ONLine[] = newL.map((t) => ({ text: t, ctx: false }));
        const repl = buildReplacement(f.lines, at, o, n, found.tier);
        f.lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldL.length)];
        tree.now.set(p, serializeFile(f));
      })(path, oldLines, newLines));
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: UniBodyLine[];
}

type V4AEditDef =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    const raw: Array<{ text: string; idx: number }> = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k]!, idx: k });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aSectionEdit(l, raw, i, strict));
    i = j;
  }
  return edits;
}

function v4aSectionEdit(header: string, raw: Array<{ text: string; idx: number }>, headerIdx: number, strict: boolean): Edit {
  if (header.startsWith('*** Add File:')) {
    const def: V4AEditDef = { kind: 'add', path: header.slice(13).trim(), lines: [] };
    for (const r of raw) {
      if (r.text.startsWith('+')) def.lines.push(r.text.slice(1));
      else if (r.text === '') def.lines.push('');
      else throw new Exit2(`error: parse ${r.idx + 1}`);
    }
    return (tree) => {
      if (!safe(def.path)) throw new Fail('unsafe', def.path);
      if (tree.get(def.path) !== null) throw new Fail('exists', def.path);
      tree.now.set(def.path, def.lines.length === 0 ? '' : def.lines.join('\n') + '\n');
    };
  }
  if (header.startsWith('*** Delete File:')) {
    const def: V4AEditDef = { kind: 'delete', path: header.slice(16).trim() };
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
    return (tree) => {
      if (!safe(def.path)) throw new Fail('unsafe', def.path);
      if (tree.get(def.path) === null) throw new Fail('missing', def.path);
      tree.now.set(def.path, null);
    };
  }
  // Update File
  const path = header.slice(16).trim();
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    moveTo = raw[0]!.text.slice(12).trim();
    k = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let chunkStarted = false;
  for (; k < raw.length; k++) {
    const r = raw[k]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
      chunkStarted = true;
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (!chunkStarted) {
          cur = { anchor: null, eof: false, body: [] };
          chunkStarted = true;
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      if (l === '') cur.body.push({ kind: ' ', text: '', raw: l });
      else cur.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1), raw: l });
    } else {
      throw new Exit2(`error: parse ${r.idx + 1}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
  const def: V4AEditDef = { kind: 'update', path, moveTo, chunks };
  return (tree) => {
    if (!safe(def.path)) throw new Fail('unsafe', def.path);
    if (def.moveTo !== null && !safe(def.moveTo)) throw new Fail('unsafe', def.moveTo);
    const curText = tree.get(def.path);
    if (curText === null) throw new Fail('missing', def.path);
    if (def.moveTo !== null && tree.get(def.moveTo) !== null) throw new Fail('exists', def.moveTo);
    const f = parseFile(curText);
    let cursor = 0;
    for (const chunk of def.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let foundAt: number | null = null;
        for (const tier of strict ? [0] : TIERS) {
          for (let j = cursor; j < f.lines.length; j++) {
            if (norm(f.lines[j]!, tier) === norm(chunk.anchor!, tier)) {
              foundAt = j;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', def.path);
        cursor = foundAt + 1;
      }
      const { o, n } = hunkON(chunk.body);
      const oTexts = o.map((x) => x.text);
      if (o.length === 0) {
        const idx = chunk.eof ? f.lines.length : cursor;
        f.lines.splice(idx, 0, ...n.map((x) => x.text));
        cursor = idx + n.length;
      } else {
        let picked: { tier: number; at: number } | null = null;
        for (const tier of strict ? [0] : TIERS) {
          const occ = occurrences(f.lines, oTexts, tier).filter(
            (pos) => pos >= cursor && (!chunk.eof || pos + o.length === f.lines.length),
          );
          if (occ.length > 0) {
            picked = { tier, at: occ[0]! };
            break;
          }
        }
        if (picked === null) throw new Fail('no-match', def.path);
        const repl = buildReplacement(f.lines, picked.at, o, n, picked.tier);
        f.lines.splice(picked.at, o.length, ...repl);
        cursor = picked.at + repl.length;
      }
    }
    const out = serializeFile(f);
    if (def.moveTo !== null) {
      tree.now.set(def.path, null);
      tree.now.set(def.moveTo, out);
      tree.moves.push({ old: def.path, new: def.moveTo });
    } else {
      tree.now.set(def.path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Command line, output and exit codes (SPEC.md sections 1, 2 and 10)  */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
