#!/usr/bin/env node
'use strict';

/**
 * The keys the installed Claude Code CLI accepts under `sandbox` and `permissions` in a settings file, read from the
 * CLI's own settings schema.
 *
 * The CLI is a single executable that carries its JavaScript as bundled modules (each starting `// @bun`), and with it
 * the zod schema it validates settings against: object literals such as
 * `u({enabled:M().optional().describe("…"),network:Ja(),…})`, where the zod builders (u, M, P …) are imported from
 * another chunk and sub-schemas such as `Ja=p(()=>u({…}))` are defined in the same module. The minified names change
 * from build to build, so:
 *  - the `sandbox` and `permissions` objects are found by key names they must hold (ANCHORS), keeping only objects
 *    whose every property is optional or a sub-schema built elsewhere, as a settings schema's are and runtime objects
 *    with the same keys are not; each must be found once (or every copy must agree);
 *  - everything else is resolved inside the module that holds the object, by its imports and definitions. A
 *    property's value is an inline object (descended), a call to an imported builder (a leaf: a boolean, a list, an
 *    enum …, whose elements are not keys), a reference to a schema defined in the module (resolved, and descended when
 *    it is an object), or a local variable of the definition it is in (resolved the same way). A spread of another
 *    schema object adds that object's keys; a quoted key is a key.
 * Anything it cannot resolve (an unknown name, a call to a local function, a shorthand or computed property) is an
 * error, never a guess or a silent skip.
 *
 *   node tools/claude-settings-keys.cjs <path to the claude executable>   prints the key paths, one per line
 */

const fs = require('node:fs');

/** The two schema objects, by key names each must hold at its top level. The first is the one searched for. */
const ANCHORS = {
  sandbox: ['failIfUnavailable', 'enabled', 'excludedCommands', 'filesystem', 'network'],
  permissions: ['blockWritesOutsideWorkingDirectories', 'allow', 'deny', 'additionalDirectories', 'defaultMode'],
};

const CLOSE = { '(': ')', '{': '}', '[': ']' };

class Unresolved extends Error {}

/** The end of a quoted string or template literal that starts at s[i], or -1. */
function quoteEnd(s, i, limit) {
  const q = s[i];
  for (let j = i + 1; j < limit; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (q === '`' && s[j] === '$' && s[j + 1] === '{') { j = matchEnd(s, j + 1, limit); if (j < 0) return -1; continue; }
    if (s[j] === q) return j;
  }
  return -1;
}

/** The index of the bracket that closes the one at s[i], skipping strings and template literals; -1 when unbalanced. */
function matchEnd(s, i, limit = s.length) {
  const stack = [];
  for (let j = i; j < limit; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { j = quoteEnd(s, j, limit); if (j < 0) return -1; }
    else if (CLOSE[c]) stack.push(CLOSE[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return j;
    }
  }
  return -1;
}

/** The comma-separated parts of s[from..to), at bracket depth 0. */
function split(s, from, to) {
  const parts = [];
  let start = from;
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { j = quoteEnd(s, j, to); if (j < 0) return null; }
    else if (CLOSE[c]) { j = matchEnd(s, j, to); if (j < 0) return null; }
    else if (c === ',') { parts.push([start, j]); start = j + 1; }
  }
  parts.push([start, to]);
  return parts.filter(([a, b]) => s.slice(a, b).trim() !== '');
}

/** The parts of the object literal between s[open] '{' and s[close] '}': a property (its name and the span of its
 *  value), a spread (the span of its expression), or, for anything else, the text that could not be read. */
function members(s, open, close) {
  const parts = split(s, open + 1, close);
  if (!parts) return null;
  return parts.map(([a, b]) => {
    const head = s.slice(a, Math.min(b, a + 300));
    let m = /^\s*\.\.\./.exec(head);
    if (m) return { spread: true, from: a + m[0].length, to: b };
    m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(head) ?? /^\s*"([^"\\]+)"\s*:/.exec(head) ?? /^\s*'([^'\\]+)'\s*:/.exec(head);
    if (m) return { key: m[1], from: a + m[0].length, to: b };
    return { bad: head.trim().slice(0, 60) };
  });
}

/** A bundled module of the executable: its text, what it imports from the chunk the zod builders come from, and
 *  where each of its own names is defined. */
function moduleAround(text, at, builder) {
  const start = Math.max(0, text.lastIndexOf('// @bun', at));
  const next = text.indexOf('// @bun', at);
  const src = text.slice(start, next < 0 ? text.length : next);
  const imports = new Map();
  for (const m of src.matchAll(/import\{([^}]*)\}from"([^"]+)"/g)) {
    const names = m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split(/\s+as\s+/).pop().trim());
    for (const n of names) imports.set(n, m[2]);
  }
  const zod = imports.get(builder);
  if (!zod) throw new Unresolved(`the object builder ${builder} is not imported in the module that holds the schema`);
  const builders = new Set([...imports].filter(([, from]) => from === zod).map(([n]) => n));
  return { src, offset: start, builders };
}

/** Where `name` is assigned in the module (`name=` not after a dot or another identifier character), once. */
function definitionOf(mod, name) {
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}=(?!=)`, 'g');
  const found = [...mod.src.matchAll(re)];
  if (found.length !== 1) throw new Unresolved(`${name} is defined ${found.length} times in the module`);
  return found[0].index + found[0][0].length;
}

/** The end of the expression that starts at src[i]: the first ',' ';' or unmatched closing bracket at depth 0. */
function exprEnd(src, i) {
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = quoteEnd(src, j, src.length); if (j < 0) return -1; }
    else if (CLOSE[c]) { j = matchEnd(src, j); if (j < 0) return -1; }
    else if (c === ',' || c === ';' || c === ')' || c === '}' || c === ']') return j;
  }
  return src.length;
}

/**
 * What the expression src[from..to) is, as a schema: { object: [open, close], scope } for an object built with the
 * builder (with the local variables its values may name), or { leaf: true }. `scope` maps the local variables of the definition the expression is in to their expressions.
 */
function schemaOf(mod, from, to, scope, builder, depth = 0) {
  if (depth > 20) throw new Unresolved('the schema refers to itself');
  const src = mod.src;
  const text = src.slice(from, to);
  const lead = text.length - text.trimStart().length;
  const at = from + lead;
  // A lazily built schema: wrapper(()=>BODY). The body is an expression or a block that returns one.
  let m = /^([\w$]+)\(\(\)=>/.exec(src.slice(at, at + 80));
  if (m) {
    const open = at + m[1].length;
    const close = matchEnd(src, open);
    if (close < 0 || close > to) throw new Unresolved('an unbalanced lazy schema');
    const body = open + 1 + m[0].length - m[1].length - 1;
    if (src[body] === '{') return blockReturn(mod, body, builder, depth);
    return schemaOf(mod, body, close, scope, builder, depth + 1);
  }
  m = /^([\w$]+)\(/.exec(src.slice(at, at + 80));
  if (m) {
    const name = m[1];
    const open = at + name.length;
    const close = matchEnd(src, open);
    if (close < 0 || close > to) throw new Unresolved(`an unbalanced call to ${name}`);
    if (name === builder && src[open + 1] === '{') return { object: [open + 1, matchEnd(src, open + 1)], scope };
    if (mod.builders.has(name)) {
      // A leaf, unless its arguments build an object schema inline (a union or a wrapper of one), whose keys would
      // be settings keys this reader cannot place.
      const objectIn = new RegExp(`(^|[^\\w$])${builder.replace(/\$/g, '\\$')}\\(\\{`);
      if (objectIn.test(src.slice(open + 1, close))) throw new Unresolved(`a call to ${name} whose arguments build an object schema`);
      return { leaf: true };
    }
    if (close !== open + 1) throw new Unresolved(`a call to ${name}, which is neither a builder nor a schema defined in the module`);
    return schemaOf(mod, definitionOf(mod, name), mod.src.length, new Map(), builder, depth + 1);
  }
  m = /^([A-Za-z_$][\w$]*)/.exec(src.slice(at, at + 80));
  if (m && scope.has(m[1])) {
    const [a, b] = scope.get(m[1]);
    return schemaOf(mod, a, b, new Map(), builder, depth + 1);
  }
  if (m && mod.builders.has(m[1])) return { leaf: true };
  if (m) {
    // A schema defined in the module and used by name, without a call (as a spread names one).
    const def = definitionOf(mod, m[1]);
    return schemaOf(mod, def, exprEnd(mod.src, def), new Map(), builder, depth + 1);
  }
  throw new Unresolved(`an expression it cannot read: ${text.trim().slice(0, 60)}`);
}

/** The schema a block body `{let e=…;return EXPR}` returns, with its `let`/`const` variables in scope. */
function blockReturn(mod, open, builder, depth) {
  const src = mod.src;
  const close = matchEnd(src, open);
  if (close < 0) throw new Unresolved('an unbalanced block');
  const scope = new Map();
  let j = open + 1;
  while (j < close) {
    const rest = src.slice(j, j + 20);
    const decl = /^\s*(?:let|const|var)\s+/.exec(rest);
    if (decl) {
      j += decl[0].length;
      for (;;) {
        const nm = /^([A-Za-z_$][\w$]*)=/.exec(src.slice(j, j + 80));
        if (!nm) throw new Unresolved('a declaration it cannot read in a schema block');
        const a = j + nm[0].length;
        const b = exprEnd(src, a);
        if (b < 0) throw new Unresolved('an unbalanced declaration in a schema block');
        scope.set(nm[1], [a, b]);
        j = b;
        if (src[j] === ',') { j++; continue; }
        break;
      }
      if (src[j] === ';') j++;
      continue;
    }
    const ret = /^\s*return\s+/.exec(rest);
    if (ret) {
      const a = j + ret[0].length;
      return schemaOf(mod, a, exprEnd(src, a), scope, builder, depth + 1);
    }
    throw new Unresolved('a statement it cannot read in a schema block');
  }
  throw new Unresolved('a schema block that returns nothing');
}

/** The key paths under `prefix` of the object literal at src[open..close], following its sub-schemas and spreads. */
function pathsOf(mod, prefix, open, close, scope, builder, out, depth = 0) {
  if (depth > 20) throw new Unresolved('the schema nests too deeply');
  const ms = members(mod.src, open, close);
  if (!ms) throw new Unresolved(`an object it cannot split under ${prefix}`);
  for (const p of ms) {
    if (p.bad !== undefined) throw new Unresolved(`a part it cannot read under ${prefix}: ${p.bad}`);
    if (p.spread) {
      // `...X`, `...X.shape` or `...X().shape`: the keys of another schema object.
      const expr = mod.src.slice(p.from, p.to).trim().replace(/\.shape$/, '');
      const s = schemaOf(mod, p.from, p.from + mod.src.slice(p.from, p.to).indexOf(expr) + expr.length, scope, builder);
      if (!s.object) throw new Unresolved(`a spread under ${prefix} that is not a schema object`);
      pathsOf(mod, prefix, s.object[0], s.object[1], s.scope, builder, out, depth + 1);
      continue;
    }
    const at = `${prefix}.${p.key}`;
    out.add(at);
    const s = schemaOf(mod, p.from, p.to, scope, builder);
    if (s.object) pathsOf(mod, at, s.object[0], s.object[1], s.scope, builder, out, depth + 1);
  }
}

/** Every schema-shaped object literal in `text` that holds all of `need` at its top level: where its '{' is. */
function schemaObjects(text, need) {
  const found = [];
  const seen = new Set();
  const pattern = `${need[0]}:`;
  for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) {
    // The nearest '{' before the key whose object, read with strings skipped, encloses it and has it at its top level.
    let k = -1;
    let props = null;
    for (let c = at - 1; c >= 0 && c > at - 20000; c--) {
      if (text[c] !== '{') continue;
      const e = matchEnd(text, c, Math.min(text.length, at + 200000));
      if (e < at) continue;
      const ms = members(text, c, e);
      if (ms && ms.some((p) => p.key === need[0] && p.from === at + pattern.length)) { k = c; props = { ms, close: e }; }
      break;
    }
    if (k < 0 || seen.has(k)) continue;
    const names = props.ms.filter((p) => p.key !== undefined).map((p) => p.key);
    const schemaLike = props.ms.every((p) => {
      if (p.key === undefined) return true;
      const v = text.slice(p.from, p.to);
      return /\.optional\(\)/.test(v) || /^\s*[\w$]+\(\)\s*$/.test(v);
    });
    const builder = /([\w$]+)\($/.exec(text.slice(Math.max(0, k - 40), k));
    if (schemaLike && builder && need.every((n) => names.includes(n))) { seen.add(k); found.push({ open: k, close: props.close, builder: builder[1] }); }
  }
  return found;
}

/** Every key path under sandbox and permissions the schema in `text` accepts, with the two roots, sorted; or why
 *  they could not be read. */
function settingsKeyPaths(text) {
  const out = new Set();
  try {
    for (const [prefix, need] of Object.entries(ANCHORS)) {
      const objects = schemaObjects(text, need);
      if (objects.length === 0) return { error: `no settings schema object holding ${need.join(', ')} was found for ${prefix}` };
      const lists = objects.map((o) => {
        const mod = moduleAround(text, o.open, o.builder);
        const s = new Set([prefix]);
        pathsOf(mod, prefix, o.open - mod.offset, o.close - mod.offset, new Map(), o.builder, s);
        return [...s].sort();
      });
      if (new Set(lists.map((l) => l.join('\n'))).size !== 1) return { error: `the copies of the ${prefix} schema list different keys` };
      for (const p of lists[0]) out.add(p);
    }
  } catch (e) {
    if (e instanceof Unresolved) return { error: e.message };
    throw e;
  }
  return { paths: [...out].sort() };
}

/** settingsKeyPaths of an executable file, read as bytes (latin1 keeps every byte one character). */
function settingsKeyPathsOfFile(file) {
  let text;
  try { text = fs.readFileSync(file).toString('latin1'); } catch (e) { return { error: `could not read ${file}: ${e.message}` }; }
  return settingsKeyPaths(text);
}

module.exports = { ANCHORS, settingsKeyPaths, settingsKeyPathsOfFile };

if (require.main === module) {
  const r = settingsKeyPathsOfFile(process.argv[2] ?? '');
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(r.paths.join('\n'));
}
