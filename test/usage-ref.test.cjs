'use strict';
// Values the usage log may not write verbatim are written as a keyed digest: the
// same value always maps to the same short ref on this install, the text cannot
// be read back, and a dictionary guess needs the per-install secret.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { loadUsageSecret, usageRef } = loadTs('src/main/usageRef.ts');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-ref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the secret is created once, private, and reused', (t) => {
  const dir = tmp(t);
  const a = loadUsageSecret(dir);
  const b = loadUsageSecret(dir);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  const file = fs.readdirSync(dir).map((f) => path.join(dir, f))[0];
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a ref is 12 hex, stable for a value, and depends on the install', (t) => {
  const one = loadUsageSecret(tmp(t));
  const two = loadUsageSecret(tmp(t));
  const v = 'Owner-said-the-unreleased-project-is-ORCHID';
  assert.match(usageRef(one, v), /^[0-9a-f]{12}$/);
  assert.equal(usageRef(one, v), usageRef(one, v));
  assert.notEqual(usageRef(one, v), usageRef(two, v));
  assert.notEqual(usageRef(one, v), usageRef(one, `${v}.`));
});
