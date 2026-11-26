'use strict';

// src/core holds logic that must run without Electron, so it can be reused
// outside the app process. The rule is an allowlist, so a new way of reaching
// out of the folder fails by default:
//
//  - a relative or aliased import from a src/core file must land in src/core or
//    src/shared; from a src/shared file it must land in src/shared. Anything
//    else (src/main, src/preload, src/renderer, the @/ renderer alias, a folder
//    elsewhere in the repository) is refused, and so is one that resolves to no
//    file at all. The file is judged where it really is, symlinks resolved, so a
//    linked folder inside src/core that points at src/main does not count as
//    src/core;
//  - a bare import must be a Node builtin or one of the npm packages listed in
//    PACKAGES below, so adding a package to core is a deliberate edit here: a
//    package that wraps Electron need not be named electron-*. electron, an
//    electron-* package, an @electron/* package and node-pty (or a subpath of
//    one, such as electron/main) are named as such in the failure;
//  - no file may use createRequire (from 'module' / 'node:module', in any
//    form: named, renamed, through a namespace or default import, destructured
//    from require, or as a computed key that folds to the name, such as
//    ['create' + 'Require']). It builds a require() whose specifiers the
//    scanner cannot see, so createRequire(import.meta.url)('electron') would
//    otherwise pass;
//  - require may only be called directly, as require('<literal>'). Any other
//    use of it ((require)('x'), (0, require)('x'), require?.('x'),
//    require.call(…), const r = require) hides its specifier from the scanner.
//
// src/core may import src/shared, so every shared file it reaches is held to the
// same rule, transitively: otherwise core -> shared -> electron would pass.
// Every script type is scanned (.ts .tsx .mts .cts .js .jsx .mjs .cjs), and
// every specifier is read with the TypeScript scanner, so static imports,
// re-exports, `import type`, dynamic import() and require() all count, and a
// specifier that only appears in a comment does not.
//
// Not closable by a static scan: a computed specifier (require(name)),
// module.require and process.mainModule.require, and starting a main-process
// file by path (child_process.fork, a Worker).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const ts = require('typescript');

/** The folders the rule is about, in the repository whose root is `root`. */
function treeAt(root) {
  return { root, coreDir: path.join(root, 'src', 'core'), sharedDir: path.join(root, 'src', 'shared') };
}
const SCRIPT = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// An ESM-style specifier names the emitted file; the source has the TS extension.
const TS_FOR_JS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

// The npm packages src/core and the src/shared files it reaches may import.
const PACKAGES = new Set(['smol-toml']);

const inside = (dir, p) => p === dir || p.startsWith(dir + path.sep);
const real = (p) => fs.realpathSync(p);
const rel = (tree, p) => path.relative(tree.root, p);

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
function target(tree, file, spec) {
  if (spec.startsWith('.') || path.isAbsolute(spec)) return path.resolve(path.dirname(file), spec);
  // The path aliases (see electron.vite.config.ts).
  if (spec.startsWith('@/')) return path.join(tree.root, 'src/renderer/src', spec.slice(2));
  if (spec.startsWith('@shared/')) return path.join(tree.sharedDir, spec.slice('@shared/'.length));
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
function judge(tree, file, spec) {
  const t = target(tree, file, spec);
  if (t === null) {
    if (spec.startsWith('node:') || builtinModules.includes(spec)) return {};
    const pkg = packageOf(spec);
    if (forbiddenPackage(pkg)) return { why: `${spec} is the forbidden package ${pkg}` };
    return PACKAGES.has(pkg) ? {} : { why: `${spec} is the package ${pkg}, which is not on the allowlist of packages core may use` };
  }
  const zones = inside(tree.coreDir, file) ? [tree.coreDir, tree.sharedDir] : [tree.sharedDir];
  const named = zones.map((z) => rel(tree, z)).join(' and ');
  if (!zones.some((z) => inside(z, t))) {
    return { why: `${spec} resolves to ${rel(tree, t)}, outside ${named}` };
  }
  const resolved = resolveFile(t);
  if (!resolved) return { why: `${spec} resolves to no file` };
  const where = real(resolved);
  if (!zones.some((z) => inside(real(z), where))) {
    return { why: `${spec} resolves through a symlink to ${where}, outside ${named}` };
  }
  return { follow: inside(tree.sharedDir, resolved) && SCRIPT.test(resolved) ? resolved : null };
}

function specifiers(file) {
  return ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles.map((i) => i.fileName);
}

const SCRIPT_KIND = { '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX };

/** The value of a string expression built only from literals ('a', `a`, 'a' + 'b', (…)), else undefined. */
function constantString(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left);
    const right = constantString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const part = constantString(span.expression);
      if (part === undefined) return undefined;
      text += part + span.literal.text;
    }
    return text;
  }
  return undefined;
}

/** The names a member is declared or reached by: `x.require`, `{ require: … }`, a class or interface member. */
function isMemberName(node) {
  const p = node.parent;
  return !!p && p.name === node && (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)
    || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p));
}

/** require('<literal>'): the only use of require whose specifier the scanner reads. */
function isDirectRequireCall(node) {
  const call = node.parent;
  return !!call && ts.isCallExpression(call) && call.expression === node && !call.questionDotToken
    && call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0]);
}

/**
 * Where `file` reaches a loader the scanner cannot follow: createRequire named as an identifier or as an
 * element key that folds to 'createRequire', and require used other than as require('<literal>').
 */
function loaderOffences(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    SCRIPT_KIND[path.extname(file)] ?? ts.ScriptKind.JS);
  const found = new Map();
  const at = (node, what) => found.set(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`, true);
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'createRequire') at(node, 'uses createRequire');
    if (ts.isElementAccessExpression(node) && constantString(node.argumentExpression) === 'createRequire') at(node, 'uses createRequire');
    if (ts.isIdentifier(node) && node.text === 'require' && !isMemberName(node) && !isDirectRequireCall(node)) {
      at(node, "uses require other than as require('<literal>')");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found.keys()];
}

/** Every offence reachable from `file`, following imports into src/shared. */
function offendersFrom(tree, file, chain, seen, offenders) {
  const here = [...chain, rel(tree, file)].join(' -> ');
  for (const offence of loaderOffences(file)) offenders.push(`${here}:${offence}`);
  for (const spec of specifiers(file)) {
    const { why, follow } = judge(tree, file, spec);
    if (why) offenders.push(`${[...chain, rel(tree, file)].join(' -> ')}: ${why}`);
    else if (follow && !seen.has(follow)) {
      seen.add(follow);
      offendersFrom(tree, follow, [...chain, rel(tree, file)], seen, offenders);
    }
  }
  return offenders;
}

/** Every offence in the src/core of the repository whose root is `root`. */
function boundaryOffenders(root) {
  const tree = treeAt(root);
  const files = scripts(tree.coreDir);
  assert.ok(files.length > 0, 'src/core has no script files to check');
  const offenders = [];
  for (const file of files) offendersFrom(tree, file, [], new Set(), offenders);
  return offenders;
}

test('src/core reaches only src/core, src/shared, Node builtins and non-Electron packages, directly or through src/shared', () => {
  assert.deepEqual(boundaryOffenders(path.join(__dirname, '..')), []);
});
