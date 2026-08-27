'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORTRAIT_DIR = path.join(ROOT, 'src/renderer/src/scene/study/assets/portraits');
const { assignPortrait, portraitFor, PORTRAIT_FILES } =
  loadTs('src/renderer/src/scene/study/portraits.ts');

test('the same assistant always gets the same portrait', () => {
  const files = ['a.png', 'b.png', 'c.png'];
  for (const id of ['w-1', 'w-2', 'god', 'a-really-long-agent-id-0000']) {
    assert.equal(assignPortrait(id, files), assignPortrait(id, files), `${id} is stable`);
    assert.ok(files.includes(assignPortrait(id, files)), `${id} picked one of the files`);
  }
});

test('the assignment does not collapse every assistant onto one portrait', () => {
  const files = ['a.png', 'b.png', 'c.png', 'd.png'];
  const ids = Array.from({ length: 40 }, (_, i) => `worker-${i}`);
  const used = new Set(ids.map((id) => assignPortrait(id, files)));
  assert.equal(used.size, files.length, 'all four portraits are in play');
});

test('adding a portrait does not silently keep the old answer', () => {
  // A hash that ignored the file list would be stable across a growing pack —
  // which reads as "deterministic" and is in fact broken.
  const before = ['a.png', 'b.png'];
  const after = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'];
  const moved = Array.from({ length: 20 }, (_, i) => `w-${i}`)
    .filter((id) => assignPortrait(id, before) !== assignPortrait(id, after));
  assert.ok(moved.length > 0, 'the pack size is part of the assignment');
});

test('an empty portrait pack yields no portrait at all', () => {
  assert.equal(assignPortrait('w-1', []), undefined);
  assert.equal(assignPortrait('', ['a.png']), undefined, 'an agent with no id has no portrait');
});

test('portraitFor consumes the shipped pack', () => {
  const got = portraitFor({ id: 'w-1', name: 'Pam' });
  if (PORTRAIT_FILES.length === 0) {
    assert.equal(got, undefined, 'no pack, no portrait — the card falls back to a monogram');
  } else {
    assert.ok(PORTRAIT_FILES.includes(got), 'portraitFor returns a file from the pack');
    assert.equal(got, portraitFor({ id: 'w-1', name: 'Someone Else' }),
      'the assignment keys on the id, not the display name');
  }
});

test('the shipped index lists exactly the portraits on disk', () => {
  // A generated index that nothing re-generates is worse than no index: a file
  // dropped into the pack would simply never appear, silently.
  const onDisk = fs.existsSync(PORTRAIT_DIR)
    ? fs.readdirSync(PORTRAIT_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
    : [];
  const indexed = PORTRAIT_FILES.map((f) => path.basename(f)).sort();
  assert.deepEqual(indexed, onDisk,
    'run assets/portraits/make-portrait-index.cjs after changing the pack');
});

test('the attribution file states where portraits may come from', () => {
  const doc = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md'), 'utf8');
  assert.match(doc, /portraits/i, 'the portrait pack rule is recorded');
  assert.match(doc, /scene\/study\/assets\/portraits/, 'and it names the directory it governs');
});
