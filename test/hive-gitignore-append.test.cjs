'use strict';

// ensureHive keeps a list of rules in the hive's .gitignore. When some are missing it appends them after the
// file's existing bytes, which it leaves exactly as they were (comments, blank lines, line endings), and a rule
// already there on a CRLF line counts as present.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-gitignore-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { hive, file: path.join(hive.root(), '.gitignore') };
}

test('rules missing from an edited .gitignore are appended after its bytes, which are kept exactly', (t) => {
  const { hive, file } = floor(t);
  const full = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  // An owner's file: their own groups, separated by blank lines, holding all but the last two rules.
  const owner = `# mine\nnode_modules/\n\n\n# the app's\n${full.slice(0, -2).join('\n')}\n\n`;
  fs.writeFileSync(file, owner);
  hive.ensureHive();
  assert.equal(fs.readFileSync(file, 'utf8'), `${owner}${full.slice(-2).join('\n')}\n`);
});

test('a .gitignore with no final newline gets one before the appended rules', (t) => {
  const { hive, file } = floor(t);
  const full = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const owner = full.slice(0, -1).join('\n');
  fs.writeFileSync(file, owner);
  hive.ensureHive();
  assert.equal(fs.readFileSync(file, 'utf8'), `${owner}\n${full.at(-1)}\n`);
});

test('a .gitignore with CRLF line endings that holds every rule is left alone', (t) => {
  const { hive, file } = floor(t);
  const crlf = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).join('\r\n') + '\r\n';
  fs.writeFileSync(file, crlf);
  hive.ensureHive();
  assert.equal(fs.readFileSync(file, 'utf8'), crlf);
});

test('rules missing from a CRLF .gitignore are appended with CRLF endings', (t) => {
  const { hive, file } = floor(t);
  const full = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const crlf = full.slice(0, -1).join('\r\n') + '\r\n';
  fs.writeFileSync(file, crlf);
  hive.ensureHive();
  assert.equal(fs.readFileSync(file, 'utf8'), `${crlf}${full.at(-1)}\r\n`);
});
