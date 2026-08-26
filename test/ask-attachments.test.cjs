'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { saveAskAttachment, MAX_ATTACHMENT_BYTES } = loadTs('src/main/askAttachments.ts');

// realpath'd: the guard returns CANONICAL paths, and $TMPDIR is itself a symlink
// on macOS, so a raw mkdtemp path would not be a prefix of anything written.
const hiveRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-ask-attach-')));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(16)
]);

test('writes a png under asks/attachments/<task>/ with a main-generated name', async () => {
  const root = hiveRoot();
  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: PNG });
  assert.equal(res.ok, true);
  const rel = path.relative(root, res.path);
  assert.equal(rel.split(path.sep).slice(0, 3).join('/'), 'asks/attachments/T-7');
  assert.match(path.basename(res.path), /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+\.png$/);
  assert.deepEqual([...fs.readFileSync(res.path)], [...PNG]);
});

test('accepts every supported image format and names the file by its sniffed type', async () => {
  const root = hiveRoot();
  for (const [bytes, ext] of [[JPG, 'jpg'], [GIF, 'gif'], [WEBP, 'webp']]) {
    const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes });
    assert.equal(res.ok, true, `${ext} should be accepted`);
    assert.equal(path.extname(res.path), `.${ext}`);
  }
});

test('two attachments in the same task never overwrite each other', async () => {
  const root = hiveRoot();
  const a = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: PNG, now: new Date('2026-01-02T03:04:05.678Z') });
  const b = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: PNG, now: new Date('2026-01-02T03:04:05.678Z') });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readdirSync(path.dirname(a.path)).length, 2);
});

test('rejects a non-image whatever its name claims — bytes are the only evidence', async () => {
  const root = hiveRoot();
  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: Buffer.from('this is a .png in name only\n') });
  assert.equal(res.ok, false);
  assert.match(res.error, /image/i);
  assert.equal(fs.existsSync(path.join(root, 'asks')), false);
});

test('rejects an image larger than the cap', async () => {
  const root = hiveRoot();
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: big });
  assert.equal(res.ok, false);
  assert.match(res.error, /10 ?MB|too large/i);
  assert.equal(fs.existsSync(path.join(root, 'asks')), false);
});

test('a task id cannot escape the attachments directory', async () => {
  const root = hiveRoot();
  const base = path.join(root, 'asks', 'attachments') + path.sep;
  for (const taskId of ['../../../../etc', 'a/../../b', '..', '/absolute', 'C:\\windows']) {
    const res = await saveAskAttachment({ hiveRoot: root, taskId, bytes: PNG });
    if (!res.ok) continue;
    assert.equal(res.path.startsWith(base), true, `${taskId} escaped to ${res.path}`);
    // exactly <dir>/<file> below the attachments root — no traversal, no nesting
    assert.equal(path.relative(base, res.path).split(path.sep).length, 2, `${taskId} nested to ${res.path}`);
  }
  assert.equal(fs.existsSync(path.join(root, 'etc')), false);
  assert.equal(fs.existsSync(path.join(root, 'asks', 'etc')), false);
});

test('rejects bytes that are not bytes at all', async () => {
  const root = hiveRoot();
  for (const bytes of [null, undefined, 'PNG', 42, {}]) {
    assert.equal((await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes })).ok, false);
  }
});

test('rejects a RIFF/WAVE payload — RIFF container with WAVE form type is not WEBP', async () => {
  const root = hiveRoot();
  const WAVE = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WAVE', 'latin1'), Buffer.alloc(16)]);
  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: WAVE });
  assert.equal(res.ok, false, 'RIFF/WAVE must be refused');
  assert.equal(fs.existsSync(path.join(root, 'asks')), false);
});

test('rejects a truncated RIFF payload — RIFF header with no form type at byte 8', async () => {
  const root = hiveRoot();
  const RIFF_ONLY = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0])]);
  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: RIFF_ONLY });
  assert.equal(res.ok, false, 'truncated RIFF must be refused');
  assert.equal(fs.existsSync(path.join(root, 'asks')), false);
});

/**
 * Containment, and why generating the path here is not enough on its own.
 *
 * The task folder is slugged and the file name is generated in the main
 * process, so no caller string can traverse out of the attachments tree. That
 * is string math, and string math knows nothing about symlinks: whatever plants
 * a link at `asks/attachments/<task>` — another agent writing into the shared
 * hive, a restored backup, a cloned tree — turns an in-root NAME into an
 * external DIRECTORY, and the mkdir/write that follows is resolved by the
 * kernel, which follows it. The image then lands outside the hive entirely.
 *
 * A dangling link is the sharper case: its target does not exist, so nothing
 * that merely canonicalizes the path can see where it goes, and the write
 * CREATES the external file.
 */
function plantedHive() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-ask-attach-plant-')));
  const root = path.join(dir, 'hive');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(root, 'asks', 'attachments'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { root, outside };
}

test('refuses a task folder symlinked to a directory outside the hive', async () => {
  const { root, outside } = plantedHive();
  const loot = path.join(outside, 'loot');
  fs.mkdirSync(loot);
  fs.symlinkSync(loot, path.join(root, 'asks', 'attachments', 'T-7'));

  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: PNG });

  assert.equal(res.ok, false, 'a task folder that leaves the hive must be refused');
  assert.deepEqual(fs.readdirSync(loot), [], 'nothing may be written outside the hive');
});

test('refuses a DANGLING task-folder symlink — mkdir through it creates the external target', async () => {
  const { root, outside } = plantedHive();
  const target = path.join(outside, 'not-yet');
  fs.symlinkSync(target, path.join(root, 'asks', 'attachments', 'T-7'));

  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: PNG });

  assert.equal(res.ok, false, 'a dangling task folder cannot be proven to land inside the hive');
  assert.equal(fs.existsSync(target), false, 'the external directory must not be created');
});

test('refuses a dangling symlink planted at the generated file name itself', async () => {
  const { root, outside } = plantedHive();
  const now = new Date('2026-01-02T03:04:05.678Z');
  const dir = path.join(root, 'asks', 'attachments', 'T-7');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(outside, 'planted.png');
  fs.symlinkSync(target, path.join(dir, '2026-01-02T03-04-05-678Z-1.png'));

  const res = await saveAskAttachment({ hiveRoot: root, taskId: 'T-7', bytes: PNG, now });

  assert.equal(fs.existsSync(target), false, 'the bytes must never reach the link’s external target');
  // Skipping the poisoned name for the next free one is fine; following it is not.
  if (res.ok) {
    assert.equal(res.path.startsWith(dir + path.sep), true, `escaped to ${res.path}`);
    assert.equal(fs.lstatSync(res.path).isSymbolicLink(), false, 'never write through a link');
  }
});
