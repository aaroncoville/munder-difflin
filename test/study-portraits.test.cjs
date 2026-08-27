'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORTRAIT_DIR = path.join(ROOT, 'src/renderer/src/scene/study/assets/portraits');
const { assignPortrait, portraitFor, portraitNamed, GOD_PORTRAIT,
  PORTRAIT_FILES, PORTRAIT_NAMES } =
  loadTs('src/renderer/src/scene/study/portraits.ts');
/**
 * The spawner's name pool, when this checkout is sitting next to one.
 *
 * The pack's names double as the pool an assistant is summoned from, and the
 * two live in different repositories — so the cross-repository half of the
 * check is opt-in through this variable and the in-repository half below always
 * runs. Point it at a newline-separated list of names (`#` comments allowed).
 */
const POOL = process.env.STUDY_PORTRAIT_NAME_POOL;

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
    // Pam is not a face in the pack, so this one falls to the id hash — and
    // the hash keys on the id, which is what keeps the room from reshuffling
    // when somebody is renamed.
    assert.equal(got, portraitFor({ id: 'w-1', name: 'Someone Else' }),
      'the fallback keys on the id, not the display name');
  }
});

test('the index carries the portraits names beside their files', () => {
  // An import yields a fingerprinted URL; the filename is gone by the time the
  // app sees it. Without the names in the index, no rule can ever say "the
  // assistant called leo wears leo.png".
  assert.equal(PORTRAIT_NAMES.length, PORTRAIT_FILES.length, 'names and files are parallel');
  const onDisk = fs.readdirSync(PORTRAIT_DIR)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
    .map((f) => f.replace(/\.[^.]+$/, ''));
  assert.deepEqual([...PORTRAIT_NAMES].sort(), onDisk);
});

test('an assistant named for a portrait wears it, whatever its id', () => {
  // The whole point of the name pool: a worker is spawned with the name of the
  // face it will wear. A hash could match by luck for one id, so this asserts
  // across several — and asserts the file, not merely that something came back.
  const want = portraitNamed('leo');
  assert.ok(want, 'leo is in the shipped pack');
  for (const id of ['w-1', 'w-2', 'zzz', 'agent-0000']) {
    assert.equal(portraitFor({ id, name: 'leo' }), want, `id ${id} overrode the name`);
  }
  // Case and surrounding space are not part of somebody's name.
  assert.equal(portraitFor({ id: 'x', name: '  LEO ' }), want);
});

test('an assistant named for nothing in the pack still gets a face', () => {
  const got = portraitFor({ id: 'w-9', name: 'Nobody In The Pack' });
  assert.ok(PORTRAIT_FILES.includes(got), 'the hash fallback is gone');
  assert.equal(got, portraitFor({ id: 'w-9', name: 'Also Not In The Pack' }),
    'the fallback keys on the id, so a rename does not reshuffle the room');
});

test('the orchestrator has a face of its own', () => {
  // Reserved by Aaron: fascination is the god's portrait and no worker takes it.
  assert.equal(GOD_PORTRAIT, 'fascination');
  assert.ok(portraitNamed(GOD_PORTRAIT), 'the reserved portrait is not in the pack');
  assert.equal(portraitFor({ id: 'god-1', name: 'Michael', isGod: true }),
    portraitNamed(GOD_PORTRAIT), 'the god wears somebody else s face');
  // And it is reserved: a worker cannot be dealt it by the hash.
  const dealt = new Set(Array.from({ length: 400 }, (_, i) =>
    portraitFor({ id: `w-${i}`, name: `nameless-${i}` })));
  assert.ok(!dealt.has(portraitNamed(GOD_PORTRAIT)), 'a worker was dealt the god s portrait');
});

test('a worker named for the reserved face does not get it', () => {
  // The name rule is checked before the hash, so a worker literally named
  // `fascination` — nothing stops one being typed into the summon form — used
  // to match the reserved face by name and walk straight past the reservation.
  // The name lookup a worker goes through must not see the god's face at all.
  const god = portraitNamed(GOD_PORTRAIT);
  assert.ok(god, 'the reserved portrait is not in the pack');
  const got = portraitFor({ id: 'w-1', name: GOD_PORTRAIT, isGod: false });
  assert.notEqual(got, god, 'a worker wore the god s face by naming itself after it');
  // And it is dealt the same face it would have got with any other unknown
  // name: the reserved name falls through to the hash, it is not special-cased
  // into some second reserved portrait.
  assert.equal(got, portraitFor({ id: 'w-1', name: 'not in the pack at all' }),
    'the reserved name does not fall through to the ordinary deal');
  // Case and space are stripped before the lookup, so those spellings too.
  for (const spelling of ['  FASCINATION ', 'Fascination']) {
    assert.notEqual(portraitFor({ id: 'w-2', name: spelling }), god,
      `${spelling} slipped past the reservation`);
  }
});

test('the pack is people, and none of the iconography', () => {
  // The community pack also ships aspect, faction and element cards. They are
  // iconography, not portraits: an assistant wearing the Moth aspect card is
  // not a picture of anybody, so none of them may be in this directory.
  const ICONOGRAPHY = /^(cult|way|edge|forge|grail|heart|knock|lantern|moth|winter|dream|talk|time|study|explore|contentment|secrethistories|mansus|kleidouchos|echidna)/;
  assert.ok(PORTRAIT_NAMES.length > 20, 'the pack is suspiciously bare');
  assert.deepEqual(PORTRAIT_NAMES.filter((n) => ICONOGRAPHY.test(n)), []);
  // A name is what an assistant is summoned with, so it has to survive being
  // typed: lower case, no spaces, nothing a filename picked up on the way in.
  assert.deepEqual(PORTRAIT_NAMES.filter((n) => !/^[a-z0-9-]+$/.test(n)), [],
    'a portrait nobody can be named after');
});

test('the pack is the pool a worker is summoned from', (t) => {
  // The whole point of the naming rule: a worker is spawned with a name from
  // the pool and must find the matching face. The pool is checked in beside
  // the spawner rather than here, so this runs when it is pointed at one.
  if (!POOL || !fs.existsSync(POOL)) {
    t.skip('set STUDY_PORTRAIT_NAME_POOL to check the pack against the spawner s pool');
    return;
  }
  const pool = fs.readFileSync(POOL, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(pool.length >= 40, 'the pool is not the pool');
  const have = new Set(PORTRAIT_NAMES);
  assert.deepEqual(pool.filter((n) => !have.has(n)), [],
    'a spawnable name with no face behind it');
  // And nothing extra: the pack is the pool plus the one reserved face.
  const allowed = new Set([...pool, GOD_PORTRAIT]);
  assert.deepEqual(PORTRAIT_NAMES.filter((n) => !allowed.has(n)), [],
    'a face nobody can be summoned to wear');
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

test('every shipped portrait is recorded, because that is the licence', () => {
  // Obligation 6: only the community pack s art, and every file s provenance
  // written down. A portrait with no row has not been cleared, and this is
  // what stops one arriving without one.
  const doc = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md'), 'utf8');
  const rows = new Set([...doc.matchAll(/^\s*\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]));
  const onDisk = fs.readdirSync(PORTRAIT_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const unrecorded = onDisk.filter((f) => !rows.has(f));
  assert.deepEqual(unrecorded, [], 'portraits shipped with no provenance recorded');
  const phantom = [...rows].filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && !onDisk.includes(f));
  assert.deepEqual(phantom, [], 'rows for portraits that are not shipped');
});
