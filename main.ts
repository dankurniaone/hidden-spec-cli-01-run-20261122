// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the
// lines each edit names at the first of three matching tiers, and writes
// every change or none. Node 22, standard library alone; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; `line` is the patch line to name. */
class ParseError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** One edit failed; `code` is the SPEC.md failure code, `path` the file it concerns. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed each. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or .. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileParts {
  br: string;
  lines: string[];
  finalBr: boolean;
}

/** A file's lines under its own line break (SPEC.md section 3). */
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const lines = text.split(br);
  if (finalBr) lines.pop();
  return { br, lines, finalBr };
}

/** The text of a file from its lines, its break and whether it ends with one. */
function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.finalBr ? p.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly origCache = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p) as string | null;
  }
  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

type EditFn = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Matching (SPEC.md section 5)                                        */
/* ------------------------------------------------------------------ */

/** One line normalised at a tier: 0 exact, 1 no trailing spaces/tabs, 2 no leading or trailing. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where `old` occurs at `tier`. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const want = old.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j] as string, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs at least once, with its positions, or null. */
function findTier(
  lines: string[],
  old: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A new line re-indented at tier 2: its leading P replaced by F, unless it is blank or starts elsewhere. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a hunk or chunk: context, old, new, or a backslash marker line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

function bodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '' };
  if (line.startsWith(' ')) return { kind: 'ctx', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'old', text: line.slice(1) };
  if (line.startsWith('+')) return { kind: 'new', text: line.slice(1) };
  return { kind: 'mark', text: line.slice(1) };
}

/**
 * The new lines for a matched block: context lines are the file's own matched
 * lines, other lines are re-indented at tier 2 and written as they are otherwise.
 */
function buildNew(
  body: BodyLine[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const o: { text: string; ctx: boolean }[] = [];
  const n: { text: string; ctx: boolean; oPos: number }[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const p = o.length;
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true, oPos: p });
    } else if (b.kind === 'old') {
      o.push({ text: b.text, ctx: false });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oPos: -1 });
    }
  }
  const pfx = o.length > 0 ? leadingWs(o[0].text) : '';
  const ffx = leadingWs(fileLines[pos] as string);
  return n.map((it) => {
    if (it.ctx) return fileLines[pos + it.oPos] as string;
    if (tier === 2) return reindent(it.text, pfx, ffx);
    return it.text;
  });
}

/** Whether a backslash line follows the body's last context or new line. */
function noEolAfter(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1].kind === 'mark';
}

/** The old lines of a body (context and old lines, in order). */
function oldLinesOf(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld: string | undefined;
  pairNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0].trim();
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** Apply a section's hunks in order to a file's text, returning the new text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const o = oldLinesOf(h.body);
    const noEol = noEolAfter(h.body);
    if (o.length > 0) {
      const found = findTier(f.lines, o, 0, strict);
      if (found === null) throw new EditFailure('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0] as number;
      let best = Math.abs(pos - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          pos = p;
          best = dist;
        }
      }
      const repl = buildNew(h.body, f.lines, pos, found.tier);
      const touchesEnd = pos + o.length === f.lines.length;
      f.lines.splice(pos, o.length, ...repl);
      if (touchesEnd) f.finalBr = !noEol;
      d += repl.length - o.length;
    } else {
      const at = Math.min(h.a + d, f.lines.length);
      const wasEnd = at === f.lines.length;
      const ins = h.body.filter((b) => b.kind === 'new').map((b) => b.text);
      f.lines.splice(at, 0, ...ins);
      if (wasEnd) f.finalBr = !noEol;
      d += ins.length;
    }
  }
  return joinFile(f);
}

function unifiedSectionEdit(sec: Section, strict: boolean): EditFn {
  const oldP = sec.pairOld ?? sec.renameFrom ?? sec.gitOld ?? '';
  const newP = sec.pairNew ?? sec.renameTo ?? sec.gitNew ?? '';
  const isCreate = oldP === '/dev/null' || sec.newFile;
  const isDelete = !isCreate && (newP === '/dev/null' || sec.deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (!safePath(newP)) throw new EditFailure('unsafe', newP);
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      }
      let finalBr = true;
      // The created file ends with a line break unless a backslash line follows
      // its last + line: the last hunk holding one decides.
      let decided = false;
      for (let hi = sec.hunks.length - 1; hi >= 0 && !decided; hi--) {
        const h = sec.hunks[hi] as Hunk;
        let at = -1;
        for (let i = 0; i < h.body.length; i++) if (h.body[i].kind === 'new') at = i;
        if (at >= 0) {
          finalBr = !(h.body[at + 1] !== undefined && h.body[at + 1].kind === 'mark');
          decided = true;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (!safePath(oldP)) throw new EditFailure('unsafe', oldP);
      if (tree.get(oldP) === null) throw new EditFailure('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safePath(oldP)) throw new EditFailure('unsafe', oldP);
    if (isMove && !safePath(newP)) throw new EditFailure('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new EditFailure('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new EditFailure('exists', newP);
    const out = applyHunks(before, sec.hunks, strict, oldP);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let sec: Section | null = null;
  let mode: 'outside' | 'header' | 'after' = 'outside';
  const blankSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const finish = (): void => {
    if (sec !== null) edits.push(unifiedSectionEdit(sec, strict));
    sec = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseError(i + 1);
      finish();
      sec = blankSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      mode = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = stripAB(headerPath(line));
      const newP = stripAB(headerPath(lines[i + 1] as string));
      if (mode === 'header' && sec !== null) {
        sec.pairOld = oldP;
        sec.pairNew = newP;
      } else {
        finish();
        sec = blankSection();
        sec.pairOld = oldP;
        sec.pairNew = newP;
        mode = 'header';
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (mode === 'header') throw new ParseError(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('+++ ') && mode === 'header' && sec !== null) {
      sec.pairNew = stripAB(headerPath(line));
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseError(i + 1);
      if (mode === 'outside' || sec === null) throw new ParseError(i + 1);
      const hunk: Hunk = { a: parseInt(m[1] as string, 10), body: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i] as string;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          hunk.body.push(bodyLine(b));
          i++;
          continue;
        }
        break;
      }
      while (
        hunk.body.length > 0 &&
        hunk.body[hunk.body.length - 1].kind === 'ctx' &&
        hunk.body[hunk.body.length - 1].text === ''
      ) {
        hunk.body.pop();
      }
      sec.hunks.push(hunk);
      mode = 'after';
      continue;
    }
    if (mode === 'header' && sec !== null) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) sec.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) sec.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  finish();
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, old: string[], fresh: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new EditFailure('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.now.set(path, fresh.length === 0 ? '' : fresh.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, old, 0, strict);
    if (found === null) throw new EditFailure('no-match', path);
    if (found.occ.length > 1) throw new EditFailure('ambiguous', path);
    const pos = found.occ[0] as number;
    const pfx = leadingWs(old[0] as string);
    const ffx = leadingWs(f.lines[pos] as string);
    const repl = fresh.map((l) => (found.tier === 2 ? reindent(l, pfx, ffx) : l));
    f.lines.splice(pos, old.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j--) {
      const t = (lines[j] as string).trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseError(searchAt + 1);
    }
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      if ((lines[j] as string).trimEnd() === '=======') {
        eq = j;
        break;
      }
      if ((lines[j] as string).trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new ParseError(searchAt + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if ((lines[j] as string).trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new ParseError(searchAt + 1);
    const old = lines.slice(searchAt + 1, eq);
    const fresh = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, old, fresh, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) !== null) throw new EditFailure('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) === null) throw new EditFailure('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new EditFailure('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const found = findTier(f.lines, [chunk.anchor], cursor, strict);
        if (found === null) throw new EditFailure('no-match', path);
        cursor = (found.occ[0] as number) + 1;
      }
      const o = oldLinesOf(chunk.body);
      if (o.length > 0) {
        const found = findTier(f.lines, o, cursor, strict);
        if (found === null) throw new EditFailure('no-match', path);
        let pos = found.occ[0] as number;
        if (chunk.eof) {
          const atEnd = found.occ.filter((p) => p + o.length === f.lines.length);
          if (atEnd.length === 0) throw new EditFailure('no-match', path);
          pos = atEnd[0] as number;
        }
        const repl = buildNew(chunk.body, f.lines, pos, found.tier);
        f.lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      } else {
        const at = chunk.eof ? f.lines.length : cursor;
        const ins = chunk.body.filter((b) => b.kind === 'new').map((b) => b.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      i++;
      while (i < last) {
        const x = lines[i] as string;
        if (isV4aSectionStart(x)) break;
        if (isBlank(x)) {
          fileLines.push('');
          i++;
          continue;
        }
        if (x.startsWith('+')) {
          fileLines.push(x.slice(1));
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const x = lines[i] as string;
        if (isV4aSectionStart(x)) break;
        if (isBlank(x)) {
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstLine = true;
      while (i < last) {
        const x = lines[i] as string;
        if (isV4aSectionStart(x)) break;
        if (isBlank(x)) {
          if (cur !== null) cur.body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        if (firstLine && x.startsWith('*** Move to: ')) {
          moveTo = x.slice('*** Move to: '.length).trim();
          firstLine = false;
          i++;
          continue;
        }
        firstLine = false;
        if (x.startsWith('@@')) {
          cur = { anchor: x.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          i++;
          continue;
        }
        if (x.trim() === '*** End of File') {
          if (cur === null) throw new ParseError(i + 1);
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(bodyLine(x));
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1] as V4aChunk;
        while (
          tail.body.length > 0 &&
          tail.body[tail.body.length - 1].kind === 'ctx' &&
          tail.body[tail.body.length - 1].text === ''
        ) {
          tail.body.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(updateLine);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new ParseError(i + 1);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safePath(p)) throw new EditFailure('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (atLine < 0 || atLine > f.lines.length) throw new EditFailure('no-match', p);
      f.lines.splice(atLine, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  const edits: EditFn[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseError(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(idx + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseError(1);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // The changed paths, with a move's delete and create folded into one R line.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && o.now === null && n !== undefined && n.was === null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      changed.delete(oldP);
      changed.delete(newP);
    }
  }
  for (const [p, c] of changed) {
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    // Deletes first (so a path a file vacates can become a directory), then writes.
    for (const p of tree.now.keys()) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (now === null || was === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out };
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
