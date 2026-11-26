'use strict';

// src/core holds logic that must run without Electron, so it can be reused
// outside the app process. The rule is an allowlist, so a new way of reaching
// out of the folder fails by default:
//
//  - a relative or aliased import from a src/core file must land in src/core or
//    src/shared; from a src/shared file it must land in src/shared. Anything
//    else (src/main, src/preload, src/renderer, the @/ renderer alias, a folder
//    elsewhere in the repository) is refused, and so is one that resolves to no
//    file at all;
//  - a bare import must be a Node builtin or an npm package, and never electron,
//    an electron-* package, an @electron/* package, or node-pty (nor a subpath
//    of one, such as electron/main).
//
// src/core may import src/shared, so every shared file it reaches is held to the
// same rule, transitively: otherwise core -> shared -> electron would pass.
// Every script type is scanned (.ts .tsx .mts .cts .js .jsx .mjs .cjs), and
// every specifier is read with the TypeScript scanner, so static imports,
// re-exports, `import type`, dynamic import() and require() all count, and a
// specifier that only appears in a comment does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const coreDir = path.join(root, 'src', 'core');
const sharedDir = path.join(root, 'src', 'shared');
const SCRIPT = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// An ESM-style specifier names the emitted file; the source has the TS extension.
const TS_FOR_JS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

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

/** The package a bare specifier names: `@scope/name` or `name`, without any subpath. */
function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function forbiddenPackage(pkg) {
  return pkg === 'electron' || pkg.startsWith('electron-') || pkg.startsWith('@electron/') || pkg === 'node-pty';
}

/** Where a relative or aliased specifier points on disk; null for a bare one. */
function target(file, spec) {
  if (spec.startsWith('.') || path.isAbsolute(spec)) return path.resolve(path.dirname(file), spec);
  // The path aliases (see electron.vite.config.ts).
  if (spec.startsWith('@/')) return path.join(root, 'src/renderer/src', spec.slice(2));
  if (spec.startsWith('@shared/')) return path.join(sharedDir, spec.slice('@shared/'.length));
  return null;
}

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

/** The file a specifier loads, as the bundler would find it; null if none. */
function resolveFile(base) {
  if (isFile(base)) return base;
  const ext = path.extname(base);
  const tsFirst = (TS_FOR_JS[ext] || []).map((x) => base.slice(0, -ext.length) + x);
  const candidates = [...tsFirst, ...EXTENSIONS.map((x) => base + x), ...EXTENSIONS.map((x) => path.join(base, 'index' + x))];
  return candidates.find(isFile) || null;
}

/** Why `spec`, imported by `file`, breaks the boundary (null if it does not), and the shared file to follow. */
function judge(file, spec) {
  const t = target(file, spec);
  if (t === null) {
    if (spec.startsWith('node:') || builtinModules.includes(spec)) return {};
    const pkg = packageOf(spec);
    return forbiddenPackage(pkg) ? { why: `${spec} is the forbidden package ${pkg}` } : {};
  }
  const zones = inside(coreDir, file) ? [coreDir, sharedDir] : [sharedDir];
  if (!zones.some((z) => inside(z, t))) {
    return { why: `${spec} resolves to ${rel(t)}, outside ${zones.map(rel).join(' and ')}` };
  }
  const resolved = resolveFile(t);
  if (!resolved) return { why: `${spec} resolves to no file` };
  return { follow: inside(sharedDir, resolved) && SCRIPT.test(resolved) ? resolved : null };
}

function specifiers(file) {
  return ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles.map((i) => i.fileName);
}

/** Every offence reachable from `file`, following imports into src/shared. */
function offendersFrom(file, chain, seen, offenders) {
  for (const spec of specifiers(file)) {
    const { why, follow } = judge(file, spec);
    if (why) offenders.push(`${[...chain, rel(file)].join(' -> ')}: ${why}`);
    else if (follow && !seen.has(follow)) {
      seen.add(follow);
      offendersFrom(follow, [...chain, rel(file)], seen, offenders);
    }
  }
  return offenders;
}

test('src/core reaches only src/core, src/shared, Node builtins and non-Electron packages, directly or through src/shared', () => {
  const files = scripts(coreDir);
  assert.ok(files.length > 0, 'src/core has no script files to check');
  const offenders = [];
  for (const file of files) offendersFrom(file, [], new Set(), offenders);
  assert.deepEqual(offenders, []);
});
