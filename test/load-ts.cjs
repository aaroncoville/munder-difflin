'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const cache = new Map();

function resolveTs(fromDir, request) {
  const base = request.startsWith('@shared/')
    ? path.resolve(__dirname, '..', 'src/shared', request.slice('@shared/'.length))
    : request.startsWith('@/')
      ? path.resolve(__dirname, '..', 'src/renderer/src', request.slice('@/'.length))
      : path.resolve(fromDir, request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadFile(filename) {
  const cached = cache.get(filename);
  if (cached) return cached.exports;
  // A `.json` import is data, not TypeScript. The bundler parses it (the app
  // compiles with resolveJsonModule); handing it to transpileModule instead
  // fails output generation outright, so parse it the same way here.
  if (filename.endsWith('.json')) {
    const json = { exports: JSON.parse(fs.readFileSync(filename, 'utf8')) };
    cache.set(filename, json);
    return json.exports;
  }
  // An asset import is a URL, not a module. Vite hands the component a string
  // and copies the file; handing the bytes to transpileModule instead produces
  // garbage that only explodes once the component renders. The path stands in
  // for the bundler's URL — nothing under test can dereference it anyway.
  if (/\.(png|jpe?g|gif|svg|webp|avif|woff2?)$/.test(filename)) {
    // __esModule matters: with esModuleInterop a default import of a module
    // without it compiles to `__importDefault(mod).default`, which wraps the
    // whole exports object — the component would then receive `{default: ...}`
    // where the bundler gives it a string.
    const asset = { exports: { __esModule: true, default: filename } };
    cache.set(filename, asset);
    return asset.exports;
  }
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      // Match tsconfig.node/tsconfig.web. Without it a default import of a CJS
      // builtin (`import path from 'node:path'`) compiles to `path_1.default`,
      // which is undefined at run time — the module loads fine and then explodes
      // on first use. Test harness only; no shipped code compiles through here.
      esModuleInterop: true,
      // .tsx files need a JSX emit or transpileModule chokes on the first `<`.
      // The AUTOMATIC runtime is deliberate: classic emit needs `React` in
      // scope, and these components do not need a React default import.
      // A test can therefore stub `react/jsx-runtime` and get a plain element
      // tree without pulling in react-dom.
      ...(filename.endsWith('.tsx') ? { jsx: ts.JsxEmit.ReactJSX } : {})
    },
    fileName: filename,
    reportDiagnostics: true
  });
  if (output.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n'
    }));
  }
  const mod = { exports: {} };
  cache.set(filename, mod);
  const localRequire = (request) => {
    if (request.startsWith('.') || request.startsWith('@shared/') || request.startsWith('@/')) {
      const resolved = resolveTs(path.dirname(filename), request);
      if (resolved) return loadFile(resolved);
    }
    return require(request);
  };
  const run = new Function('module', 'exports', 'require', '__filename', '__dirname', output.outputText);
  run(mod, mod.exports, localRequire, filename, path.dirname(filename));
  return mod.exports;
}

/** Load a TypeScript module and its local TypeScript imports for node:test. */
function loadTs(relativePath) {
  return loadFile(path.resolve(__dirname, '..', relativePath));
}

/**
 * Same, but re-evaluates the module even if it was loaded before. Modules with
 * load-time side effects (reading localStorage, stamping the document) need one
 * instance per case, which the shared cache would otherwise deny them.
 */
loadTs.fresh = function loadTsFresh(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  cache.delete(filename);
  return loadFile(filename);
};

/**
 * Forget every module loaded so far, so the next load re-evaluates from source.
 *
 * `fresh` is not enough on its own for a module that reads its state ONCE, as
 * it is evaluated — the app theme is read out of localStorage at that moment —
 * because the component under test reaches it through its own cached import.
 * Clearing the whole graph is what lets one case run under a second theme.
 */
loadTs.reset = function loadTsReset() {
  cache.clear();
};

/**
 * Stand a module in for one the harness cannot load.
 *
 * Not every module under `src/` is loadable outside a bundler: the office floor
 * pulls in Pixi and a handful of Vite `?url` asset imports, and requiring it
 * here fails before a single assertion runs. Seeding the cache lets a test load
 * the REAL module that imports it — which is the thing under test — while the
 * unloadable dependency is a component the test can recognise in the tree.
 *
 * `loadTs.fresh(relativePath)` puts the real module back.
 */
loadTs.stub = function loadTsStub(relativePath, exports) {
  cache.set(path.resolve(__dirname, '..', relativePath), { exports });
  return exports;
};

module.exports = loadTs;
