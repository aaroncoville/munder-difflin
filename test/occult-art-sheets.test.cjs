'use strict';
/**
 * The prompt sheets under `tools/occult-art/` are the only record of how the
 * Study's painted panels were made, and a record is worth exactly what it is
 * held to. Three ways it can rot silently:
 *
 *   - a panel is repainted and its sheet is not, so the sheet describes an
 *     image that is no longer in the tree;
 *   - a sheet is added for a panel that was never shipped, or a shipped panel
 *     is left with no sheet at all;
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

const files = fs.readdirSync(SHEETS).filter((f) => f.endsWith('.yaml')).sort();

test('every painted panel the house names has a sheet, and every sheet a panel', () => {
  assert.ok(files.length > 0, 'there are sheets to check');
  const painted = [...new Set(manifest.rooms.map((r) => path.basename(r.image)))].sort();
  const claimed = files.map((f) => path.basename(readSheet(f).panel)).sort();
  assert.deepEqual(claimed, painted,
    'the sheets and the panels the manifest paints with are the same set');
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
