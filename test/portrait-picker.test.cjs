'use strict';
/**
 * Choosing a face when summoning an assistant.
 *
 * Under the office themes the add-agent screen picks a pixel CAST MEMBER, and
 * clicking one sets the agent's name to that character's. Under the occult
 * theme the cast is a wall of painted portraits, so the same control shows
 * those instead — and choosing one names the assistant after the portrait,
 * which is the same interaction and is what makes the name rule in
 * `portraits.ts` reach the assistant it applies to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { PortraitPicker } = loadTs('src/renderer/src/components/PortraitPicker.tsx');
const { PORTRAIT_NAMES, GOD_PORTRAIT } =
  loadTs('src/renderer/src/scene/study/portraits.ts');

const all = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const k of n) all(k, pred, out); return out; }
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) all(n.props.children, pred, out);
  if (typeof n.type === 'function') {
    let r; try { r = n.type(n.props); } catch { return out; }
    all(r, pred, out);
  }
  return out;
};
const tiles = (tree) => all(tree, (n) => n.props?.['data-portrait'] !== undefined);

test('every face a worker can be summoned with is on the wall', () => {
  const inst = mount(PortraitPicker, { selected: undefined, onPick: () => {} });
  const names = tiles(inst.tree).map((t) => t.props['data-portrait']);
  // The orchestrator's own face is reserved and is not somebody you summon.
  const offered = PORTRAIT_NAMES.filter((n) => n !== GOD_PORTRAIT);
  assert.deepEqual(names, offered);
  assert.ok(names.length > 20, 'the wall is suspiciously bare');
  assert.ok(!names.includes(GOD_PORTRAIT), 'the reserved face is on offer');
});

test('a tile shows the portrait, not a placeholder for it', () => {
  const inst = mount(PortraitPicker, { selected: undefined, onPick: () => {} });
  for (const tile of tiles(inst.tree).slice(0, 5)) {
    const img = all(tile, (n) => n.type === 'img')[0];
    assert.ok(img, 'a tile with no image on it');
    assert.ok(String(img.props.src).length > 0, 'an image with no source');
    assert.equal(img.props.alt, '', 'the name is the label; the image is decoration');
  }
});

test('choosing a face hands back the name it belongs to', () => {
  // This is the whole point of the control: the portrait names the assistant,
  // so the assistant then wears that portrait in the Study.
  const picked = [];
  const inst = mount(PortraitPicker, { selected: undefined, onPick: (n) => picked.push(n) });
  const wall = tiles(inst.tree);
  wall[3].props.onClick();
  // The name, not a file or an index into the wall — how it is capitalised is
  // the next test's business.
  assert.equal(picked.length, 1);
  assert.equal(picked[0].toLowerCase(), wall[3].props['data-portrait']);
});

test('the chosen face is the one that looks chosen', () => {
  const name = PORTRAIT_NAMES.find((n) => n !== GOD_PORTRAIT);
  const inst = mount(PortraitPicker, { selected: name, onPick: () => {} });
  const chosen = tiles(inst.tree).filter((t) => t.props['aria-pressed'] === true);
  assert.equal(chosen.length, 1, 'no face, or every face, reads as chosen');
  assert.equal(chosen[0].props['data-portrait'], name);
});

test('the add-agent screen swaps the cast for the wall, and only under occult', () => {
  const src = strip(read('src/renderer/src/components/AddAgentModal.tsx'));
  assert.match(src, /PortraitPicker/, 'the picker is never mounted');
  assert.match(src, /useAppTheme\(\)\s*===\s*'occult'/, 'it is not gated on the theme');
  // The pixel cast must still be there for light and dark — this milestone
  // changes what the occult theme shows, not what anybody else sees.
  assert.match(src, /OFFICE_CAST/, 'the pixel cast was removed rather than switched');
  // Choosing a portrait names the assistant, the same as clicking a character
  // tile already does. Without this the name rule never reaches the agent.
  assert.match(src, /setName\(/, 'choosing a face does not name the assistant');
});

test('the accent colour default is left exactly where it was', () => {
  // Explicitly out of scope: the summoning screen keeps its existing default.
  const src = strip(read('src/renderer/src/components/AddAgentModal.tsx'));
  assert.match(src, /ACCENTS\.includes\(a as AccentColorName\) \? \(a as AccentColorName\) : 'sky'/,
    'the default accent moved');
});

test('a face is offered, and hands back, the name written the way a name is', () => {
  // The pack's files are lower case because files are, and the picker was
  // handing that straight to the roster — so an assistant summoned from the
  // wall was called `leo` while every one summoned from the pixel cast was
  // called Jim. The file name is a file name; what goes in the roster is a
  // person's name.
  const inst = mount(PortraitPicker, { selected: undefined, onPick: () => {} });
  const wall = tiles(inst.tree);
  for (const tile of wall.slice(0, 6)) {
    const shown = all(tile, (n) => typeof n.props?.children === 'string')
      .map((n) => n.props.children).join('');
    const file = tile.props['data-portrait'];
    assert.equal(shown, file[0].toUpperCase() + file.slice(1),
      `the wall offers ${file} under the name ${shown}`);
  }

  const picked = [];
  const chooser = mount(PortraitPicker, { selected: undefined, onPick: (n) => picked.push(n) });
  const tile = tiles(chooser.tree)[3];
  const file = tile.props['data-portrait'];
  tile.props.onClick();
  assert.deepEqual(picked, [file[0].toUpperCase() + file.slice(1)]);
});

test('a capitalised name wears the face, and so does the lower-case one it replaces', () => {
  // The capital is a display decision, so it must not be a matching one: the
  // workers already on the floor were summoned before it and are named in
  // lower case. Both spellings have to land on the same painting.
  const { portraitFor } = loadTs('src/renderer/src/scene/study/portraits.ts');
  const name = PORTRAIT_NAMES.find((n) => n !== GOD_PORTRAIT);
  const capital = name[0].toUpperCase() + name.slice(1);
  const face = portraitFor({ id: 'w-1', name: capital });
  assert.ok(face, `${capital} wears no face at all`);
  assert.equal(face, portraitFor({ id: 'w-2', name }),
    'the same face, whichever way the name is written');
  assert.equal(face, portraitFor({ id: 'w-3', name: `  ${capital.toUpperCase()} ` }),
    'and however it is spaced or shouted');
});
