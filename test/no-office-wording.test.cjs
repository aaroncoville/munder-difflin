'use strict';
/**
 * The app no longer draws a pixel office, so nothing it shows or tells an
 * agent may describe the floor as one.
 *
 * Onboarding still greeted a first run with "Meet your office" and "Eleven
 * engines, one office", in every language, and the guide the orchestrator is
 * given for spawning workers still said `character` picks "how the worker
 * looks on the office floor" and that naming a worker after "a cast member"
 * gives it that avatar. Neither has been true since the office was removed:
 * the field is accepted and ignored.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LOCALES = 'src/renderer/src/i18n/locales';

/** Every string in a locale file, with its key. */
function strings(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...strings(v, key));
    else if (typeof v === 'string') out.push([key, v]);
  }
  return out;
}

// The word for an office in each locale. Arabic's "desktop" (سطح المكتب) is
// built on the same word and is not an office.
const OFFICE = {
  'en.json': /\boffice\b/i,
  'en-SH.json': /\boffice\b/i,
  'zh-CN.json': /办公室/,
  'ar.json': /(?<!سطح ال)مكتب/
};

test('no locale calls the floor an office', () => {
  const files = fs.readdirSync(path.join(ROOT, LOCALES)).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files.sort(), Object.keys(OFFICE).sort(), 'a locale was added or removed: name its word for an office here');
  const hits = [];
  for (const f of files) {
    for (const [key, text] of strings(JSON.parse(read(`${LOCALES}/${f}`)))) {
      if (OFFICE[f].test(text)) hits.push(`${f} ${key}: ${text.slice(0, 80)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the spawn guide does not offer a cast member or an office floor', () => {
  const hive = read('src/main/hive.ts');
  const start = hive.indexOf('You can start an ephemeral worker yourself.');
  assert.ok(start > 0, 'the spawn guide is no longer in hive.ts');
  const guide = hive.slice(start, hive.indexOf('**It can be switched off.**', start));
  assert.ok(guide.length > 200, 'the spawn guide could not be found whole');
  assert.doesNotMatch(guide, /office floor/i);
  assert.doesNotMatch(guide, /cast member/i);
  assert.doesNotMatch(guide, /"character":/, 'the example request still sets a character');
});

test('no code the app runs calls the floor an office', () => {
  // Comments may say what the code replaced; text the app shows a person or
  // hands an agent may not.
  const { execFileSync } = require('node:child_process');
  const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(ts|tsx|cjs|mjs|js)$/.test(f));
  assert.ok(files.length > 200, `only ${files.length} files scanned`);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  // The 0.4.4 release page is the record of what that release changed, office
  // and all; it is shown as history, not as a description of the app.
  const historical = (f, text, at) => f === 'src/shared/releaseDrop.ts'
    && at > text.indexOf('export const DEFAULT_DROP_HTML') && at < text.indexOf('export function buildDropSrcDoc');
  const hits = [];
  for (const f of files) {
    const text = strip(read(f));
    for (const m of text.matchAll(/\boffice\b/gi)) {
      if (historical(f, text, m.index)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${f}:${line}: ${text.split('\n')[line - 1].trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the harness deck describes the floor the app draws now', () => {
  const deck = read('docs/harness-engineering-deck.html');
  assert.doesNotMatch(deck, /office floor|Michael's office/i);
  assert.doesNotMatch(deck, /class="chip[^"]*">Pixi\.js</, 'the deck lists a renderer the app no longer uses');
});
