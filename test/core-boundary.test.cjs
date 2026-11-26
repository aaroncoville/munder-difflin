'use strict';

// src/core holds logic that must run without Electron, so it can be reused
// outside the app process. That only holds while nothing in it reaches back
// into the app: an import of src/main, src/preload or src/renderer, or of
// electron / node-pty, would drag the app (or a native module) along with it.
// Every module specifier is read with the TypeScript scanner, so static
// imports, re-exports, `import type`, dynamic import() and require() all count,
// and a specifier that only appears in a comment does not.
//
// src/core may import src/shared, so a shared file it imports is held to the
// same rule, and so is every shared file that one imports in turn: otherwise
// core -> shared -> electron would pass. Every script type is scanned
// (.ts .tsx .mts .cts .js .jsx .mjs .cjs), not only TypeScript.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const coreDir = path.join(root, 'src', 'core');
const sharedDir = path.join(root, 'src', 'shared');
const FORBIDDEN_DIRS = ['src/main', 'src/preload', 'src/renderer'].map((d) => path.join(root, d));
const FORBIDDEN_PACKAGES = ['electron', 'node-pty'];
const SCRIPT = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const inside = (dir, p) => p === dir || p.startsWith(dir + path.sep);
const rel = (p) => path.relative(root, p);

function scripts(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...scripts(full));
    else if (SCRIPT.test(e.name)) out.push(full);
  }
  return out;
}

/** Where a specifier points on disk, before resolution: null for a package. */
function target(file, spec) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(file), spec);
  // The path aliases (see electron.vite.config.ts).
  if (spec.startsWith('@/')) return path.join(root, 'src/renderer/src', spec.slice(2));
  if (spec.startsWith('@shared/')) return path.join(sharedDir, spec.slice('@shared/'.length));
  return null;
}

/** The script file a specifier loads, as the bundler would find it; null if none. */
function resolveFile(base) {
  const candidates = [base, ...EXTENSIONS.map((x) => base + x), ...EXTENSIONS.map((x) => path.join(base, 'index' + x))];
  return candidates.find((c) => SCRIPT.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

function violation(file, spec) {
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  if (FORBIDDEN_PACKAGES.includes(pkg)) return `${spec} is ${pkg}`;
  const t = target(file, spec);
  if (t === null) return null;
  const hit = FORBIDDEN_DIRS.find((d) => inside(d, t));
  return hit ? `${spec} resolves into ${rel(hit)}` : null;
}

function specifiers(file) {
  return ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles.map((i) => i.fileName);
}

/** Every forbidden import reachable from `file`, following imports into src/shared. */
function offendersFrom(file, chain, seen, offenders) {
  for (const spec of specifiers(file)) {
    const why = violation(file, spec);
    if (why) { offenders.push(`${[...chain, rel(file)].join(' -> ')}: ${why}`); continue; }
    const t = target(file, spec);
    const next = t && inside(sharedDir, t) ? resolveFile(t) : null;
    if (next && !seen.has(next)) {
      seen.add(next);
      offendersFrom(next, [...chain, rel(file)], seen, offenders);
    }
  }
  return offenders;
}

test('src/core imports nothing from the app or from Electron, directly or through src/shared', () => {
  const files = scripts(coreDir);
  assert.ok(files.length > 0, 'src/core has no script files to check');
  const offenders = [];
  for (const file of files) offendersFrom(file, [], new Set(), offenders);
  assert.deepEqual(offenders, []);
});
