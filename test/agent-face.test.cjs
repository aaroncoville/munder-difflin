'use strict';
/**
 * The face on an assistant's card in the strip along the foot of the window.
 *
 * The Study replaced the pixel office floor under the occult theme, and the
 * assistants in it wear the licensed painted pack — but the strip beneath the
 * floor kept drawing the same people as recolored sprites, so the same
 * assistant had two faces at once, one above the other.
 *
 * The rule is the Study's, unchanged: an assistant named for a face wears it,
 * anyone else is dealt one from their id, and the orchestrator's own face is
 * reserved. Light and dark are untouched — the pixel cast is theirs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const FACE = 'src/renderer/src/components/AgentFace.tsx';

/** Load the face under one theme. The theme module reads localStorage as it is
 *  evaluated, so the world has to be standing before the import. */
function underTheme(theme) {
  global.window = {
    localStorage: { getItem: () => theme, setItem: () => {}, removeItem: () => {} }
  };
  global.document = { documentElement: { dataset: {} } };
  loadTs.reset?.();
  return loadTs(FACE).AgentFace;
}

/** Every element in the tree, including the ones only a component's own render
 *  produces. Each element is visited ONCE: an element passed as a child is
 *  reachable both through its parent's `children` and through what the parent
 *  renders — the same object twice, which would otherwise count as two. */
const all = (n, pred, out = [], seen = new Set()) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const k of n) all(k, pred, out, seen); return out; }
  if (seen.has(n)) return out;
  seen.add(n);
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) all(n.props.children, pred, out, seen);
  if (typeof n.type === 'function') {
    let r; try { r = n.type(n.props); } catch { return out; }
    all(r, pred, out, seen);
  }
  return out;
};

const face = (AgentFace, props) => {
  const inst = mount(AgentFace, { character: 'jim', scale: 2, ...props });
  const img = all(inst.tree, (n) => n.type === 'img')[0];
  return { tree: inst.tree, img };
};

test('under the painted theme an assistant named for a face wears it', () => {
  const AgentFace = underTheme('occult');
  const { PORTRAIT_NAMES, GOD_PORTRAIT, portraitNamed } =
    loadTs('src/renderer/src/scene/study/portraits.ts');
  const name = PORTRAIT_NAMES.find((n) => n !== GOD_PORTRAIT);
  const { img } = face(AgentFace, { id: 'w-1', name: name[0].toUpperCase() + name.slice(1) });
  assert.ok(img, 'no painting at all');
  assert.equal(img.props.src, portraitNamed(name),
    'the strip deals a face instead of using the one the name asks for');
});

test('the orchestrator wears the face reserved for it', () => {
  const AgentFace = underTheme('occult');
  const { GOD_PORTRAIT, portraitNamed } = loadTs('src/renderer/src/scene/study/portraits.ts');
  const { img } = face(AgentFace, { id: 'god-1', name: 'Michael', isGod: true });
  assert.equal(img.props.src, portraitNamed(GOD_PORTRAIT));
});

test('an assistant named nothing in the pack still gets a face, and keeps it', () => {
  const AgentFace = underTheme('occult');
  const a = face(AgentFace, { id: 'w-77', name: 'Nobody In The Pack' });
  const again = face(AgentFace, { id: 'w-77', name: 'Nobody In The Pack' });
  assert.ok(a.img, 'a stranger is left with no face');
  assert.equal(a.img.props.src, again.img.props.src, 'the strip reshuffles its cast');
  const other = face(AgentFace, { id: 'w-78', name: 'Nobody In The Pack' });
  assert.notEqual(a.img.props.src, other.img.props.src,
    'the deal is from the id, so two strangers are not one person twice');
});

test('light and dark keep the pixel cast, untouched', () => {
  const { SpritePortrait } = loadTs('src/renderer/src/components/SpritePortrait.tsx');
  for (const theme of ['light', 'dark']) {
    const AgentFace = underTheme(theme);
    const { PORTRAIT_NAMES, GOD_PORTRAIT } = loadTs('src/renderer/src/scene/study/portraits.ts');
    const named = PORTRAIT_NAMES.find((n) => n !== GOD_PORTRAIT);
    const { tree, img } = face(AgentFace, { id: 'w-1', name: named, character: 'dwight' });
    assert.equal(img, undefined, `${theme} started painting portraits`);
    const sprite = all(tree, (n) => n.type?.name === 'SpritePortrait'
      || n.type === SpritePortrait)[0];
    assert.ok(sprite, `${theme} lost the pixel cast`);
    assert.equal(sprite.props.character, 'dwight', `${theme} drew somebody else`);
    assert.equal(sprite.props.scale, 2, `${theme} redrew the sprite at another size`);
  }
});

test('the strip routes its cards through it', () => {
  const AgentFace = underTheme('occult');
  // The card watches its pty for an unsent draft, and that module pulls in
  // xterm, which wants a browser global before it will even parse. Stand in for
  // it — the draft is not what this case is about — so the REAL card can load.
  loadTs.stub('src/renderer/src/components/terminalPool.ts', {
    useHasTerminalDraft: () => false
  });
  const { AgentCard } = loadTs('src/renderer/src/components/AgentCard.tsx');
  const inst = mount(AgentCard, {
    id: 'w-1', name: 'Enid', character: 'jim', accent: 'sky', status: 'idle',
    project: 'p', progress: 0
  });
  const worn = all(inst.tree, (n) => n.type === AgentFace);
  assert.equal(worn.length, 1, 'the card in the strip does not use the shared face');
  assert.equal(worn[0].props.id, 'w-1', 'the face is dealt without knowing whose it is');
  assert.equal(worn[0].props.name, 'Enid');
});

test('nothing in the chrome draws a roster assistant as a pixel sprite', () => {
  // The strip along the foot of the window was the first surface to be fixed
  // and it was not the only one wearing the wrong cast: the avatar at the top
  // of the sidebar, the rows in the command center's own lists and the head of
  // the fullscreen terminal all drew the same assistants as office sprites
  // while their cards downstairs wore painted faces.
  //
  // The rule, rather than a list: a component handed a ROSTER assistant draws
  // its face through the shared component. A sprite drawn from a picker's cast
  // member (`character={c.name}` in the add- and edit-agent forms) is a
  // different thing — that is the pixel cast being chosen from, and choosing a
  // painted portrait has its own picker.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.resolve(__dirname, '..', 'src/renderer/src/components');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
    if (file === 'AgentFace.tsx') continue;
    // Comments stripped first: a call site that is commented out is not a call
    // site, and a rule that matches one is a rule that cannot fail.
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const m = src.match(/<SpritePortrait[^/>]*character=\{\s*(agent|a)\.character/);
    if (m) offenders.push(`${file}: ${m[0].trim()}`);
  }
  assert.deepEqual(offenders, [],
    `these draw an assistant from the roster as a sprite instead of through AgentFace:\n  `
    + offenders.join('\n  '));
});

test('the rule above is one the chrome can actually break', () => {
  // The check reads source, so it has to be shown finding something: a rule
  // that matches nothing would pass just as happily over a codebase where every
  // avatar had been switched back.
  const probe = 'const x = <SpritePortrait character={agent.character} scale={1} />;';
  assert.match(probe, /<SpritePortrait[^/>]*character=\{\s*(agent|a)\.character/);
  const picker = 'const x = <SpritePortrait character={c.name} scale={2} />;';
  assert.doesNotMatch(picker, /<SpritePortrait[^/>]*character=\{\s*(agent|a)\.character/);
});
