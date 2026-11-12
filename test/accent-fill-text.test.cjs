'use strict';
/**
 * Text on a solid accent fill is set in --cth-on-accent.
 *
 * The accents are bright (they are meant to be seen at a glance), and the
 * primary text colour is near-white, so near-white text on an accent fill
 * reads at 1.05-2.95:1: badges, column headers and "on" chips went blank.
 * --cth-on-accent exists for exactly this and is held to 4.5:1 against every
 * accent by the palette tests, so every style object that paints a solid
 * accent behind its text must use it.
 *
 * The scan fails closed. A fill with no colour of its own inherits a pale
 * ink, so it fails; a conditional fill is paired with every branch of the
 * text colour that can be showing at the same time, and any branch that is
 * not the on-accent ink fails, even one that a reader can see is unreachable.
 * Rewrite such a colour on the same condition as its fill.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// Comments go, their line breaks stay, so a reported line is the file's own.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The innermost `{ ... }` object literal around every background declaration. */
function styleObjects(src) {
  const out = [];
  const re = /background(?:Color)?\s*:/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let start = -1;
    for (let i = m.index; i >= 0; i--) {
      if (src[i] === '}') depth++;
      else if (src[i] === '{') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start < 0) continue;
    depth = 0;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) { out.push({ at: start, body: src.slice(start, j + 1) }); break; }
    }
  }
  return out;
}

const ACCENT = '(?:coral|mint|sky|lemon|lilac|peach|gilt|status-[a-z]+)';
/** Chip paints its "on" tone through a variable; read where that variable is set. */
const CHIP = 'src/renderer/src/components/triggers/ui.tsx';

/** The value of `key` in an object body: everything up to the next key at the
 *  same level, so a ternary split over lines is read whole. */
function valueOf(own, key) {
  const m = new RegExp(`(?:^|[\\s,{])${key}\\s*:`).exec(own);
  if (!m) return null;
  const rest = own.slice(m.index + m[0].length);
  const next = /,\s*\n?\s*[A-Za-z]+\s*:/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
const ACCENT_LITERAL = new RegExp(`['"\`]var\\(--cth-${ACCENT}\\)['"\`]|\`var\\(--cth-\\$\\{[^}]+\\}\\)\`|\\bcol\\.accent\\b`);

/** Split `cond ? a : b` at its top level; null when the expression is not a
 *  ternary there. Brackets, strings and templates are skipped whole. */
function ternary(expr) {
  const s = expr.trim().replace(/,\s*$/, '');
  let depth = 0;
  let q = null;
  let question = -1;
  let nested = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && s[i + 1] !== '?' && s[i + 1] !== '.' && s[i - 1] !== '?') {
      if (question < 0) question = i;
      else nested++;
    } else if (depth === 0 && c === ':' && question >= 0) {
      if (nested > 0) nested--;
      else return { cond: s.slice(0, question).replace(/\s+/g, ' ').trim(), a: s.slice(question + 1, i).trim(), b: s.slice(i + 1).trim() };
    }
  }
  return null;
}

/** Every value an expression can take, each with the conditions that pick it. */
function leaves(expr, path = []) {
  const t = ternary(unwrap(expr));
  if (!t) return [{ path, value: expr.trim().replace(/,\s*$/, '') }];
  return [...leaves(t.a, [...path, `${t.cond}=1`]), ...leaves(t.b, [...path, `${t.cond}=0`])];
}

/** `(x)` -> `x` when the outer brackets enclose the whole expression. */
function unwrap(expr) {
  let s = expr.trim().replace(/,\s*$/, '');
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let whole = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) { whole = false; break; }
    }
    if (!whole) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Every text colour that can sit on one fill: each branch of the foreground
 *  that does not take the opposite side of a condition the fill was picked by.
 *  Conditions the two do not share are assumed independent, so a foreground
 *  written on other conditions is checked on all of its branches: the scan
 *  fails closed rather than guess that two different tests agree. */
function foregroundsFor(fg, fillPath) {
  const flip = (p) => (p.endsWith('=1') ? p.slice(0, -1) + '0' : p.slice(0, -1) + '1');
  return leaves(fg).filter((o) => !o.path.some((p) => fillPath.includes(flip(p)))).map((o) => o.value);
}

/** True when the JSX element a `style={{ ... }}` belongs to closes with `/>`,
 *  i.e. has no children and so no text. `end` is just past the object. */
function childless(src, end) {
  // Just past the object sits the `}` that closes `style={...}`; from there
  // to the tag's own `>` are the remaining attributes, braces balanced.
  let depth = 0;
  let q = null;
  for (let i = end; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === -1) return src[i - 1] === '/';
  }
  return false;
}

test('every text colour that can sit on a solid accent fill is the on-accent ink', () => {
  const files = execFileSync('git', ['ls-files', 'src/renderer/src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx?$/.test(f));
  const hits = [];
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const o of styleObjects(src)) {
      const own = o.body.slice(1, -1).replace(/(?<!\$)\{[^{}]*\}/g, '{}');
      const bg = valueOf(own, 'background(?:Color)?');
      if (!bg) continue;
      const where = `${f}:${src.slice(0, o.at).split('\n').length}`;
      // A style attribute on an element with no children has no text to read.
      if (/^\s*\}/.test(src.slice(o.at + o.body.length)) && childless(src, o.at + o.body.length)) continue;
      const fg = valueOf(own, 'color');
      for (const fill of leaves(bg)) {
        if (!ACCENT_LITERAL.test(fill.value)) continue;
        // No colour of its own: the text inherits whatever its parent has,
        // which on this palette is a pale ink.
        if (!fg) { hits.push(`${where} inherits its text colour`); continue; }
        for (const text of foregroundsFor(fg, fill.path)) {
          if (!/^['"`]var\(--cth-on-accent\)['"`]$/.test(text)) hits.push(`${where} ${text} on ${fill.value}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(hits)], []);
});

test('the quiet status colours are never a fill behind text', () => {
  // --cth-on-accent is held to 4.5:1 on the accents only: on idle and ghost it
  // reads below that, so those two may colour a dot or an outline, never a
  // box with text in it. A status fill is only allowed on an element with no
  // children.
  const files = execFileSync('git', ['ls-files', 'src/renderer/src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx$/.test(f));
  const STATUS_FILL = /background(?:Color)?\s*:\s*(?:[^,}\n]*var\(--cth-status-(?:idle|ghost)\)|colorByStatus\[|STATUS_COLOR\[)/g;
  const hits = [];
  let seen = 0;
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const m of src.matchAll(STATUS_FILL)) {
      seen++;
      // The style attribute closes with `}}`; what follows is `/>` for an
      // element with no children.
      const close = src.indexOf('}}', m.index);
      if (!/^\s*\/>/.test(src.slice(close + 2))) hits.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.ok(seen >= 2, `found only ${seen} status fills; the scan no longer sees them`);
  assert.deepEqual(hits, []);
});

test('a stylesheet hover that fills an accent sets the text for it', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/src/design/global.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const misses = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (new RegExp(`background(?:-color)?:\\s*var\\(--cth-${ACCENT}\\)`).test(m[2]) &&
        !/(^|[;\s])color:\s*var\(--cth-on-accent\)/.test(m[2])) misses.push(m[1].trim());
  }
  assert.deepEqual(misses, []);
});

test('an "on" chip in the triggers tab is lettered for its fill', () => {
  const src = strip(fs.readFileSync(path.join(ROOT, CHIP), 'utf8'));
  const chip = src.slice(src.indexOf('export function Chip'), src.indexOf('export function Chip') + 600);
  assert.match(chip, /'var\(--cth-lemon\)'/, 'the chip no longer fills its "on" tone');
  assert.doesNotMatch(chip, /color:\s*'var\(--cth-ink-900\)'/, 'the "on" chip letters lemon in near-white');
});
