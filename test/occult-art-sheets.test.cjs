'use strict';
/**
 * The prompt sheets under `tools/occult-art/` are the only record of how the
 * Study's painted panels were made, and a record is worth exactly what it is
 * held to. Three ways it can rot silently:
 *
 *   - a panel is repainted and its sheet is not, so the sheet describes an
 *     image that is no longer in the tree;
 *   - a shipped panel is left with no sheet at all, or a sheet is added for a
 *     panel that is not in the tree. A painting the house owns but is not
 *     currently hanging keeps its sheet: the record of how it was made does not
 *     stop being true because it came off the wall, and the panel is still
 *     there to hang again;
 *   - the reference image the request carried inline is pasted back in. Each
 *     one is 170–410KB of base64 and there are eight of them; they belong
 *     outside the repository, identified by digest.
 *
 * The sheets are read here as text rather than through a YAML parser: the only
 * one on this machine is a transitive dependency nobody declared, and a test
 * that quietly stops running the day it is hoisted away is worse than none.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHEETS = path.join(ROOT, 'tools', 'occult-art');
const ASSETS = path.join(ROOT, 'src/renderer/src/scene/study/assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));

/** One sheet's top-level scalars, with its comment lines dropped first. */
function readSheet(file) {
  const body = fs.readFileSync(path.join(SHEETS, file), 'utf8');
  const lines = body.split('\n').filter((l) => !l.trimStart().startsWith('#'));
  const scalar = (re) => {
    const hit = lines.map((l) => re.exec(l)).find(Boolean);
    return hit ? hit[1].trim() : undefined;
  };
  return {
    body,
    panel: scalar(/^panel:\s*(.+)$/),
    model: scalar(/^model:\s*(.+)$/),
    prompt: lines.slice(lines.findIndex((l) => /^\s+prompt:/.test(l)) + 1)
      .filter((l) => /^\s{4}\S/.test(l)).join('\n').trim(),
    width: Number(scalar(/^\s{2}width:\s*(\d+)$/)),
    height: Number(scalar(/^\s{2}height:\s*(\d+)$/)),
    sha256: scalar(/^\s{2}sha256:\s*([0-9a-f]+)$/)
  };
}

const sheets = fs.readdirSync(SHEETS).filter((f) => f.endsWith('.yaml')).sort();

/**
 * The sheets that record a PANEL.
 *
 * There is a second kind of record here now — `book-turns.yaml`, which is one
 * file describing the short films the reading desks play rather than one file
 * per image. Splitting on whether a sheet names a panel keeps the panel rules
 * below exactly as strict as they were: a panel sheet that lost its `panel:`
 * key does not quietly reclassify itself as something else, because the only
 * sheet allowed not to have one is named here.
 */
const TURNS = 'book-turns.yaml';
const files = sheets.filter((f) => f !== TURNS);

test('every yaml here is a panel sheet or the one sheet of page turns', () => {
  for (const f of files) {
    assert.ok(readSheet(f).panel, `${f} names no panel, and is not the turns sheet`);
  }
  assert.ok(sheets.includes(TURNS), `${TURNS} is gone, and the clips it records are unexplained`);
});

test('every panel the house paints with has a sheet, and every sheet a panel', () => {
  assert.ok(files.length > 0, 'there are sheets to check');
  const claimed = new Set(files.map((f) => path.basename(readSheet(f).panel)));
  for (const room of manifest.rooms) {
    assert.ok(claimed.has(path.basename(room.image)),
      `${room.id} paints with ${room.image}, which no sheet accounts for`);
  }
  // The other direction is checked against the ASSETS, not against the
  // manifest: a painting the house is not currently hanging still exists, and
  // its sheet is still the record of how it was made. A sheet for a file that
  // is not in the tree at all is the rot this catches.
  const onDisk = new Set(fs.readdirSync(ASSETS).filter((f) => f.endsWith('.png')));
  for (const file of files) {
    const panel = path.basename(readSheet(file).panel);
    assert.ok(onDisk.has(panel), `${file} describes ${panel}, which is not in the tree`);
  }
});

test('a sheet describes a panel that is on disk at the size the sheet claims', () => {
  for (const file of files) {
    const sheet = readSheet(file);
    assert.match(sheet.panel, /^src\/renderer\/src\/scene\/study\/assets\//,
      `${file} points into the scene assets`);
    const png = path.join(ROOT, sheet.panel);
    assert.ok(fs.existsSync(png), `${file}'s panel ${sheet.panel} is on disk`);
    const head = fs.readFileSync(png).subarray(0, 24);
    assert.equal(head.readUInt32BE(16), sheet.width, `${file} declares the panel's width`);
    assert.equal(head.readUInt32BE(20), sheet.height, `${file} declares the panel's height`);
    assert.ok(sheet.model && sheet.model.includes('/'), `${file} names the model that made it`);
    assert.ok(sheet.prompt.length > 100, `${file} keeps the prompt it was made from`);
    assert.match(sheet.sha256, /^[0-9a-f]{64}$/, `${file} identifies its reference image`);
  }
});

test('no sheet carries the reference image back into the repository', () => {
  for (const file of files) {
    const { body } = readSheet(file);
    assert.equal(/base64,/.test(body), false, `${file} has no inline image data`);
    // 400KB of base64 with the marker filed off would still pass the check
    // above, so hold the size too: a sheet is prose about one image.
    assert.ok(body.length < 8 * 1024, `${file} is a prompt sheet, not a payload`);
  }
});

/* ---- the page turns: one sheet, one entry per desk that plays one --------- */

test('every page-turn clip has an entry, and every entry a clip on disk', () => {
  // The same rule the panels get, for the same reason: a clip nobody can
  // reproduce is a clip nobody can change, and an entry for a file that is not
  // there is a record of something the house does not do.
  const body = fs.readFileSync(path.join(SHEETS, TURNS), 'utf8');
  const entries = [...body.matchAll(/^ {4}clip: (\S+)$/gm)].map((m) => m[1]);
  assert.ok(entries.length > 0, 'the turns sheet records no clips at all');

  const shipped = fs.readdirSync(ASSETS).filter((f) => /^book-turn-.*\.mp4$/.test(f)).sort();
  assert.deepEqual(entries.map((e) => path.basename(e)).sort(), shipped,
    'the clips in the tree and the clips in the sheet are not the same set');
  for (const clip of entries) {
    assert.ok(fs.existsSync(path.join(ROOT, clip)), `${clip} is recorded but not in the tree`);
  }

  // And the berths agree: what the manifest asks a desk to play is what was
  // recorded as having been made for it.
  const asked = manifest.rooms
    .flatMap((r) => r.berths)
    .filter((b) => b.turn)
    .map((b) => path.basename(b.turn.clip))
    .sort();
  assert.deepEqual(asked, shipped, 'a desk plays a clip the sheet does not record making');
});

test('a page turn can actually be reproduced from what the sheet records', () => {
  // Unlike the panels, these CAN be remade byte-for-byte intent: the model
  // takes a seed. A sheet that recorded the crop but not the seed, or the seed
  // but not the crop, would be a recipe missing an ingredient.
  const body = fs.readFileSync(path.join(SHEETS, TURNS), 'utf8');
  assert.match(body, /^model: \S+$/m, 'the turns sheet names no model');
  assert.match(body, /^ {2}num_frames: \d+/m, 'no frame count');
  const berths = [...body.matchAll(/^ {2}(berth-\d+):$/gm)].map((m) => m[1]);
  assert.ok(berths.length > 0, 'no berths in the turns sheet');
  for (const b of berths) {
    const block = body.slice(body.indexOf(`  ${b}:`)).split(/\n {2}berth-/)[0];
    assert.match(block, /^ {4}crop: \{ x: \d+, y: \d+, w: \d+, h: \d+ \}/m,
      `${b} records no crop, so its clip cannot be cut again`);
    assert.match(block, /^ {4}seed: \d+$/m, `${b} records no seed, so its clip cannot be remade`);
  }
  // The crops are what keeps each room's candle out of frame, so they are not
  // all the same rectangle — a sheet that had drifted into one shared crop
  // would reproduce eight clips with a flame in half of them.
  const xs = new Set([...body.matchAll(/^ {4}crop: \{ x: (\d+)/gm)].map((m) => m[1]));
  assert.ok(xs.size > 1, 'every desk records the same crop, which no room can be true of');
});

test('the sheet’s berth headings are the manifest’s berth ids, both ways', () => {
  // The heading is what ties a seed and a crop to the desk they were chosen
  // for. Renaming one — or renaming a berth in the manifest — detaches a recipe
  // from the thing it makes without changing a single byte of either file's
  // other contents, and every other check here would stay green: the clips
  // would still all exist, and every entry would still name a file.
  const body = fs.readFileSync(path.join(SHEETS, TURNS), 'utf8');
  const heads = [...body.matchAll(/^ {2}(\S+):$/gm)].map((m) => m[1]).sort();
  const berths = manifest.rooms
    .flatMap((r) => r.berths)
    .filter((b) => b.turn)
    .map((b) => b.id)
    .sort();
  assert.ok(berths.length > 0, 'no berth in the manifest plays a turn');
  assert.deepEqual(heads, berths,
    'the sheet records recipes for desks the house does not have, or misses ones it does');

  // And each heading's own block names the clip that berth actually plays, so a
  // recipe cannot be filed under the right name and describe the wrong desk.
  for (const b of manifest.rooms.flatMap((r) => r.berths).filter((x) => x.turn)) {
    const block = body.slice(body.indexOf(`  ${b.id}:`)).split(/\n {2}\S+:$/m)[0];
    assert.ok(block.includes(path.basename(b.turn.clip)),
      `the ${b.id} block does not mention ${b.turn.clip}, which is what that desk plays`);
    const panel = manifest.rooms.find((r) => r.berths.some((x) => x.id === b.id)).image;
    assert.ok(block.includes(path.basename(panel)),
      `the ${b.id} block was cut from some panel other than ${panel}`);
  }
});

