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
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

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
/** A background that is a solid accent: a named accent, the per-agent accent
 *  template, a kanban column's accent, or a ternary whose filled branch is one. */
const SOLID_ACCENT = new RegExp(
  'background(?:Color)?\\s*:\\s*(?:' +
    `[\`'"]var\\(--cth-${ACCENT}\\)[\`'"]` +
    '|`var\\(--cth-\\$\\{[^}]+\\}\\)`' +
    '|col\\.accent\\b' +
    '|accent\\s*\\?\\s*`var\\(--cth-\\$\\{accent\\}\\)`' +
    `|on\\s*\\?\\s*'var\\(--cth-${ACCENT}\\)'` +
    ')'
);
/** Any pale ink, in any quote style: the primary, secondary and hint inks are
 *  all near-white on this palette and all vanish on a bright accent. */
const INK_TEXT = /(^|[^-\w])color\s*:\s*['"`]var\(--cth-ink-(?:900|700|500)\)['"`]/;

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
const PALE_INK = /var\(--cth-ink-(?:900|700|500)\)/;

test('no text sits in a pale ink on a solid accent fill', () => {
  const files = execFileSync('git', ['ls-files', 'src/renderer/src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx?$/.test(f));
  assert.ok(files.length > 100, `only ${files.length} files scanned`);
  const hits = [];
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const o of styleObjects(src)) {
      // Only the object's own keys: a nested object styles another element.
      // A template's `${...}` is not an object and must survive, or the
      // per-agent accent fill would be invisible to the scan.
      const own = o.body.slice(1, -1).replace(/(?<!\$)\{[^{}]*\}/g, '{}');
      const bg = valueOf(own, 'background(?:Color)?');
      const fg = valueOf(own, 'color');
      if (!bg || !fg || !ACCENT_LITERAL.test(bg)) continue;
      // Flag when every colour the text can take is a pale ink: a ternary
      // that puts the on-accent ink on its accent branch passes.
      const refs = [...fg.matchAll(/var\(--cth-[\w-]+\)/g)].map((r) => r[0]);
      if (refs.length && refs.every((r) => PALE_INK.test(r))) {
        hits.push(`${f}:${src.slice(0, o.at).split('\n').length}`);
      }
    }
  }
  assert.deepEqual([...new Set(hits)], []);
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
