'use strict';
/**
 * A fresh install names its orchestrator "Librarian".
 *
 * The orchestrator used to be called Michael by default, and that name leaked
 * past the one constant that holds it: the voice persona said "You are
 * Michael" whatever the orchestrator was called, the voice action resolver
 * treated "michael" as a fixed alias for the orchestrator, a handful of
 * prompts and messages spelled the name out, and four translation keys were
 * named after it.
 *
 * What must hold:
 *   - with nothing saved, the orchestrator is the Librarian;
 *   - a floor that already saved a name (every floor whose orchestrator ever
 *     started has one in its registry) keeps it, Michael included;
 *   - everything that speaks for or about the orchestrator uses its actual
 *     name, so a renamed orchestrator is never called by another one;
 *   - a worker who happens to be named Michael is reachable by voice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handlers = new Map();
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir() },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} }
  }
};

const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const LOCALES = ['en', 'en-SH', 'ar', 'zh-CN'];
const locale = (l) => JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`));

// ─── the name ────────────────────────────────────────────────────────────────

test('with nothing saved, the orchestrator is the Librarian', () => {
  const { DEFAULT_GOD_NAME, resolveGodName } = loadTs('src/shared/godIdentity.ts');
  assert.equal(DEFAULT_GOD_NAME, 'Librarian');
  assert.equal(resolveGodName(undefined), 'Librarian');
  assert.equal(resolveGodName('  '), 'Librarian');
});

test('a floor that saved the old default keeps it', () => {
  const { resolveGodName } = loadTs('src/shared/godIdentity.ts');
  assert.equal(resolveGodName('Michael'), 'Michael');
});

// ─── translation keys ────────────────────────────────────────────────────────

const RENAMED = {
  'commandCenter.dispatchViaMichael': 'commandCenter.dispatchViaOrchestrator',
  'commandCenter.michaelDecides': 'commandCenter.orchestratorDecides',
  'commandCenter.sentToMichael': 'commandCenter.sentToOrchestrator',
  'setupPanel.askMichael': 'setupPanel.askOrchestrator'
};
const at = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

test('no locale names a translation key after the old default', () => {
  for (const l of LOCALES) {
    const cat = locale(l);
    for (const [gone, kept] of Object.entries(RENAMED)) {
      assert.equal(at(cat, gone), undefined, `${l}: ${gone} is still there`);
      if (l === 'en-SH' && at(cat, kept) === undefined) continue; // en-SH overrides only what it rewords
      assert.equal(typeof at(cat, kept), 'string', `${l}: ${kept} is missing`);
      assert.match(at(cat, kept), /\{\{godName\}\}/, `${l}: ${kept} does not name the orchestrator`);
    }
  }
});

test('the dispatch box and the setup button read the renamed keys', () => {
  const center = strip(read('src/renderer/src/components/CommandCenterPanel.tsx'));
  for (const k of ['dispatchViaOrchestrator', 'orchestratorDecides', 'sentToOrchestrator']) {
    assert.match(center, new RegExp(`t\\('commandCenter\\.${k}'`), `CommandCenterPanel does not read ${k}`);
  }
  assert.match(strip(read('src/renderer/src/components/SetupPanel.tsx')), /t\('setupPanel\.askOrchestrator'\)/);
});

// ─── the voice ───────────────────────────────────────────────────────────────

test('the voice persona and its greetings carry the orchestrator\'s own name', () => {
  const { voicePersona, voiceGreetings } = loadTs('src/renderer/src/realtime/persona.ts');
  for (const name of ['Librarian', 'Savvas']) {
    const persona = voicePersona(name);
    assert.match(persona, new RegExp(`^You are ${name} `));
    assert.doesNotMatch(persona, /\bMichael\b/);
    const greetings = voiceGreetings(name);
    assert.ok(greetings.length > 1);
    for (const g of greetings) assert.doesNotMatch(g, /\bMichael\b/, g);
  }
});

test('the voice session takes its name and persona from the orchestrator', () => {
  const src = strip(read('src/renderer/src/realtime/session.ts'));
  assert.doesNotMatch(src, /\bMichael\b/, 'session.ts still speaks as Michael');
  assert.match(src, /instructions:\s*voicePersona\(/);
});

function voiceRig(agents) {
  handlers.clear();
  const sent = [];
  const reg = { godId: 'god', agents };
  const base = {
    hiveEnabled: () => true,
    hiveRegistry: () => reg,
    hiveSend: (m, from) => { sent.push({ ...m, from }); return m; },
    hiveLog: () => {}
  };
  const deps = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => null) });
  loadTs.fresh('src/main/realtimeActions.ts').registerRealtimeActionIpc(deps);
  const act = (payload) => handlers.get('realtime:action')({}, payload);
  return { act, sent };
}

test('a worker named Michael is reachable by voice', async () => {
  const { act, sent } = voiceRig({
    god: { name: 'Librarian', isGod: true },
    'michael-x1': { name: 'Michael' }
  });
  const res = await act({ verb: 'ping', target: 'Michael', message: 'hi' });
  assert.equal(res.ok, true, res.spoken);
  assert.equal(sent[0].to, 'michael-x1', 'the ping went to the orchestrator instead');
});

test('the orchestrator answers to "god" and to its own name', async () => {
  for (const target of ['god', 'Librarian']) {
    const { act, sent } = voiceRig({ god: { name: 'Librarian', isGod: true }, w: { name: 'Pam' } });
    const res = await act({ verb: 'ping', target, message: 'hi' });
    assert.equal(res.ok, true, res.spoken);
    assert.equal(sent[0].to, 'god', `${target} did not reach the orchestrator`);
  }
});

// ─── prompts and messages ────────────────────────────────────────────────────

test('nothing the app says or sends spells out the old default', () => {
  for (const rel of [
    'src/renderer/src/hooks/useHive.ts',
    'src/renderer/src/components/OnboardingWizard.tsx',
    'src/shared/engineAvailability.ts',
    'src/main/index.ts'
  ]) {
    assert.doesNotMatch(strip(read(rel)), /\bMichael\b/, `${rel} still says Michael`);
  }
});

test('the engine message names no one in particular', () => {
  const { engineAvailabilityMessage } = loadTs('src/shared/engineAvailability.ts');
  const msg = engineAvailabilityMessage({ state: 'not-installable' }, 'Crush');
  assert.ok(msg);
  assert.doesNotMatch(msg, /\bMichael\b/);
});
