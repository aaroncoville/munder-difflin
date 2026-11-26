'use strict';

// src/core holds logic that must run without Electron, so it can be reused
// outside the app process. That only holds while nothing in it reaches back
// into the app: an import of src/main, src/preload or src/renderer, or of
// electron / node-pty, would drag the app (or a native module) along with it.
// Every module specifier is read with the TypeScript scanner, so static
// imports, re-exports, `import type`, dynamic import() and require() all count,
// and a specifier that only appears in a comment does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const coreDir = path.join(root, 'src', 'core');
const FORBIDDEN_DIRS = ['src/main', 'src/preload', 'src/renderer'].map((d) => path.join(root, d));
const FORBIDDEN_PACKAGES = ['electron', 'node-pty'];

function coreFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...coreFiles(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

function violation(file, spec) {
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  if (FORBIDDEN_PACKAGES.includes(pkg)) return `${spec} is ${pkg}`;
  let target = null;
  if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
  // The renderer's path alias (see electron.vite.config.ts).
  else if (spec.startsWith('@/')) target = path.join(root, 'src/renderer/src', spec.slice(2));
  if (target === null) return null;
  const hit = FORBIDDEN_DIRS.find((d) => target === d || target.startsWith(d + path.sep));
  return hit ? `${spec} resolves into ${path.relative(root, hit)}` : null;
}

test('src/core imports nothing from the app or from Electron', () => {
  const files = coreFiles(coreDir);
  assert.ok(files.length > 0, 'src/core has no TypeScript files to check');
  const offenders = [];
  for (const file of files) {
    const { importedFiles } = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
    for (const { fileName: spec } of importedFiles) {
      const why = violation(file, spec);
      if (why) offenders.push(`${path.relative(root, file)}: ${why}`);
    }
  }
  assert.deepEqual(offenders, []);
});
