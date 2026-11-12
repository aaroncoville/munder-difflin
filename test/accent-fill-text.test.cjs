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

test('no text sits in the primary ink on a solid accent fill', () => {
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
      if (SOLID_ACCENT.test(own) && INK_TEXT.test(own)) {
        hits.push(`${f}:${src.slice(0, o.at).split('\n').length}`);
      }
    }
  }
  assert.deepEqual([...new Set(hits)], []);
});

test('an "on" chip in the triggers tab is lettered for its fill', () => {
  const src = strip(fs.readFileSync(path.join(ROOT, CHIP), 'utf8'));
  const chip = src.slice(src.indexOf('export function Chip'), src.indexOf('export function Chip') + 600);
  assert.match(chip, /'var\(--cth-lemon\)'/, 'the chip no longer fills its "on" tone');
  assert.doesNotMatch(chip, /color:\s*'var\(--cth-ink-900\)'/, 'the "on" chip letters lemon in near-white');
});
