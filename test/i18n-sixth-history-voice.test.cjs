'use strict';
/**
 * The Study's own voice — the `en-SH` locale and the rule that selects it.
 *
 * Two things are under test and they are separable on purpose: the locale is a
 * data file, and *when the app speaks it* is a pure function. Neither needs a
 * running i18next to check.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const at = (p) => path.resolve(__dirname, '..', p);
const read = (p) => fs.readFileSync(at(p), 'utf8');
const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));

const flatten = (o, prefix = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v]]);

const enKeys = new Map(flatten(en));

test('the house locale is a partial overlay of English, never a fork of it', () => {
  const sh = JSON.parse(read('src/renderer/src/i18n/locales/en-SH.json'));
  const shEntries = flatten(sh);
  assert.ok(shEntries.length > 0, 'the locale says nothing');

  // A key the base does not declare is a key nothing will ever read: i18next
  // resolves from the call site's key, so an invented one is dead weight that
  // looks like coverage.
  const stray = shEntries.map(([k]) => k).filter((k) => !enKeys.has(k));
  assert.deepEqual(stray, [], 'keys with no English original');

  // Shapes have to match too — a string where English has an array (the office
  // banter) would render as nothing at the call site that maps over it.
  for (const [k, v] of shEntries) {
    assert.equal(typeof v, typeof enKeys.get(k), `${k} changed shape`);
  }

  // Every interpolation the English string promises has to survive the
  // re-voicing, or the sentence renders with a hole in it.
  for (const [k, v] of shEntries) {
    if (typeof v !== 'string') continue;
    const vars = (s) => new Set([...String(s).matchAll(/{{\s*([\w.]+)\s*}}/g)].map((m) => m[1]));
    const want = vars(enKeys.get(k));
    const got = vars(v);
    for (const name of want) assert.ok(got.has(name), `${k} dropped {{${name}}}`);
  }
});

test('the glossary the spec fixed actually landed', () => {
  const sh = JSON.parse(read('src/renderer/src/i18n/locales/en-SH.json'));
  const flat = new Map(flatten(sh));
  // The kanban's four columns are the spec's own example of the register, and
  // they are the wording a reviewer will look for first.
  for (const [key, word] of [
    ['kanban.colTodo', 'INTENDED'],
    ['kanban.colDoing', 'UNDERWAY'],
    ['kanban.colBlocked', 'IMPEDED'],
    ['kanban.colDone', 'CONCLUDED']
  ]) {
    assert.equal(flat.get(key), word, `${key} is not in the house register`);
  }
  // The nouns the glossary names, each at a place the user actually reads it.
  assert.match(String(flat.get('agentStrip.addAgent')), /summon/i);
  assert.match(String(flat.get('addAgent.title')), /SUMMON/i);
  assert.match(String(flat.get('common.tokens')), /essence/i);
  assert.match(String(flat.get('commandCenter.agents')), /ASSISTANTS/);
});

test('the voice follows the theme without ever overwriting a chosen language', () => {
  const { voiceFor } = loadTs('src/renderer/src/i18n/useThemeVoice.ts');

  assert.equal(voiceFor('occult', 'en'), 'en-SH', 'the house takes its own voice');
  assert.equal(voiceFor('dark', 'en-SH'), 'en', 'leaving the house gives it back');
  assert.equal(voiceFor('light', 'en-SH'), 'en');

  // The register is a voice of ENGLISH. Somebody reading the app in Arabic did
  // not ask for it in English, and a theme change must never be able to take
  // their language away from them.
  for (const lng of ['zh-CN', 'ar']) {
    assert.equal(voiceFor('occult', lng), null, `${lng} was overwritten`);
    assert.equal(voiceFor('light', lng), null);
  }

  // Nothing to do is null, not a redundant changeLanguage — which would emit a
  // languageChanged event and re-render the whole tree on every theme read.
  assert.equal(voiceFor('occult', 'en-SH'), null);
  assert.equal(voiceFor('light', 'en'), null);
});

/**
 * An i18next stand-in: just enough of the instance for the watcher, and it
 * records every language it was asked to change to so an update loop shows up
 * as a growing list rather than as a stack overflow.
 */
function fakeI18n(language) {
  const listeners = new Set();
  return {
    language,
    changes: [],
    changeLanguage(lng) {
      this.language = lng;
      this.changes.push(lng);
      for (const fn of [...listeners]) fn(lng);
    },
    on(_event, fn) { listeners.add(fn); },
    off(_event, fn) { listeners.delete(fn); },
    listenerCount: () => listeners.size
  };
}

test('choosing English inside the house is answered with the house register', () => {
  // The theme is not the only thing that moves. A reader can pick their
  // language in Settings while standing in the Study, and the rule has to run
  // then too — reacting to the theme alone left them in plain English until
  // something happened to re-run the effect.
  const { watchVoice } = loadTs('src/renderer/src/i18n/useThemeVoice.ts');

  const i18n = fakeI18n('ar');
  const stop = watchVoice('occult', i18n);
  assert.equal(i18n.language, 'ar', 'Arabic was overwritten on subscribe');

  i18n.changeLanguage('en');
  assert.equal(i18n.language, 'en-SH', 'English under the occult theme stayed plain');

  stop();
});

test('a language that is not English is left alone, theme or no theme', () => {
  const { watchVoice } = loadTs('src/renderer/src/i18n/useThemeVoice.ts');

  for (const lng of ['ar', 'zh-CN']) {
    const i18n = fakeI18n('en-SH');
    const stop = watchVoice('occult', i18n);
    i18n.changeLanguage(lng);
    assert.equal(i18n.language, lng, `${lng} was taken away by the house`);
    stop();
  }
});

test('answering a language change does not start one', () => {
  // The watcher reacts to languageChanged by calling changeLanguage, which
  // emits languageChanged. That terminates only because the rule returns null
  // once the language is already right — so count the hops, do not trust it.
  const { watchVoice } = loadTs('src/renderer/src/i18n/useThemeVoice.ts');

  const i18n = fakeI18n('en');
  const stop = watchVoice('occult', i18n);
  assert.deepEqual(i18n.changes, ['en-SH'], 'subscribing did not settle in one hop');

  i18n.changes.length = 0;
  i18n.changeLanguage('en');
  assert.deepEqual(i18n.changes, ['en', 'en-SH'],
    'the answer to a language change provoked another one');

  stop();
});

test('the watcher lets go when the app does', () => {
  // The hook re-subscribes on every theme change. A listener that outlives its
  // effect would apply a stale theme's rule forever after.
  const { watchVoice } = loadTs('src/renderer/src/i18n/useThemeVoice.ts');

  const i18n = fakeI18n('en');
  const stop = watchVoice('light', i18n);
  assert.equal(i18n.listenerCount(), 1);
  stop();
  assert.equal(i18n.listenerCount(), 0, 'the watcher is still listening');

  i18n.changeLanguage('en');
  assert.equal(i18n.language, 'en', 'a released watcher still spoke');
});

test('the hook is the watcher, not a second copy of the rule', () => {
  // The rule above is only worth testing if the hook is what runs it. A hook
  // that re-implemented `voiceFor` in its own effect would pass every test on
  // this page while reacting to nothing but the theme.
  const { activeSource, boundedSlice } = require('./source-assert.cjs');
  const body = boundedSlice(
    activeSource('src/renderer/src/i18n/useThemeVoice.ts'),
    'export function useThemeVoice', '\n}');
  assert.match(body, /watchVoice\(/, 'the hook does not use the watcher');
});

test('the locale is registered, or nothing above it can resolve', () => {
  const index = read('src/renderer/src/i18n/index.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(index, /['"]en-SH['"]\s*:\s*{\s*translation:/, 'not in resources');
  assert.match(index, /supportedLngs:[^\]]*['"]en-SH['"]/, 'not in supportedLngs');
  // fallbackLng is what makes a PARTIAL locale legal — without it every key the
  // overlay does not declare renders as the raw key.
  assert.match(index, /fallbackLng:\s*['"]en['"]/, 'the fallback rule is gone');
});

test('the app actually asks the voice to follow the theme', () => {
  // A hook nothing calls is the "written to disk and never read" defect: the
  // rule would be correct, tested, and inert.
  const app = read('src/renderer/src/App.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(app, /useThemeVoice\(\)/, 'App.tsx never calls useThemeVoice');
});
