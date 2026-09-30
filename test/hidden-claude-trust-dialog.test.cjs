'use strict';

/**
 * A headless hidden session spawned in a cwd the CLI has never been trusted
 * in blocks on the first-run workspace-trust dialog forever: the boot-quiet
 * heuristic reads the rendered dialog as "ready for input" and sends the
 * prompt into a menu that never consumes it, so no transcript is ever
 * written. That reproduces as the generic 'no assistant response found in
 * transcript' abort — indistinguishable from a genuine transient race, and
 * worth retrying for. This dialog is NOT — every attempt hits the identical
 * menu and fails identically, so retrying just doubles the wasted cost.
 *
 * looksLikeTrustDialog() is what tells the two apart. The TUI renders the
 * dialog with absolute-column cursor moves (`\x1b[<n>G`) between words
 * instead of spaces, so a naive substring match against the raw PTY bytes
 * never fires — this is a real captured sample (spawned against an
 * unfamiliar cwd) confirming the detector actually works against what the
 * CLI really emits, not an idealized string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

loadTs.stub('node-pty', { spawn: () => { throw new Error('not used by this test'); } });
const { looksLikeTrustDialog } = loadTs('src/main/hiddenClaude.ts');

// Captured verbatim from a real `claude --permission-mode bypassPermissions`
// PTY spawn in a cwd it had not been trusted in.
const REAL_TRUST_DIALOG_SAMPLE =
  '\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h\x1b[<u\x1b[>5u\x1b[>4;2m\x1b[?2026h\r\n' +
  '\x1b[93m\x1b[1m\x1b[2GAccessing\x1b[12Gworkspace:\x1b[22m\x1b[39m\r\n\r\n' +
  '\x1b[2G\x1b[1m/some/unfamiliar/path\x1b[22m\r\n\r\n' +
  '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gtrust?\r\n\r\n' +
  '\x1b[2G\x1b[94m\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\n' +
  '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n\r\n' +
  '\x1b[2G\x1b[37mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G\xb7\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\r\n';

test('detects the real trust dialog despite per-word cursor-positioning escapes', () => {
  assert.equal(looksLikeTrustDialog(REAL_TRUST_DIALOG_SAMPLE), true);
});

test('a plain substring match would have missed it (regression guard for the fix itself)', () => {
  assert.equal(/trust this folder/i.test(REAL_TRUST_DIALOG_SAMPLE), false);
});

test('ordinary boot output (no dialog) is not misclassified', () => {
  const ordinary = '\x1b[2GWelcome\x1b[10Gto\x1b[13GClaude\x1b[20GCode\r\n' + 'some assistant text streaming in normally\r\n';
  assert.equal(looksLikeTrustDialog(ordinary), false);
});

test('empty or tiny output is not misclassified', () => {
  assert.equal(looksLikeTrustDialog(''), false);
  assert.equal(looksLikeTrustDialog('\x1b[2K\r'), false);
});
