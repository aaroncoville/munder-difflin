#!/usr/bin/env node
'use strict';

/**
 * The keys the installed Claude Code CLI accepts under `sandbox` and `permissions` in a settings file, read from the
 * CLI's own settings schema.
 *
 * The CLI is a single executable that carries its JavaScript source, and with it the zod schema it validates settings
 * against: object literals such as `{enabled:M().optional().describe("…"),failIfUnavailable:…}`. The minified names
 * (M, u, Ja …) change from build to build, so this finds each schema object by key names it must hold (ANCHORS), keeps
 * only objects whose every property is optional or a lazily built sub-schema (as a settings schema's are, and runtime
 * objects with the same keys are not), and reads their property names, following inline sub-objects. Each anchored
 * object must be found, and every copy of it in the executable must list the same keys; otherwise the result is an
 * error, never a guess.
 *
 *   node tools/claude-settings-keys.cjs <path to the claude executable>   prints the key paths, one per line
 */

const fs = require('node:fs');

/** Each schema object, by the key names it must hold at its top level. The first is the one searched for. */
const ANCHORS = {
  sandbox: ['failIfUnavailable', 'enabled', 'excludedCommands', 'filesystem', 'network'],
  'sandbox.network': ['deniedDomains', 'allowedDomains'],
  'sandbox.filesystem': ['allowManagedReadPathsOnly', 'allowWrite', 'denyRead'],
  'sandbox.credentials': ['allowPlaintextInject', 'files', 'envVars'],
  permissions: ['blockWritesOutsideWorkingDirectories', 'allow', 'deny', 'additionalDirectories', 'defaultMode'],
};

const CLOSE = { '(': ')', '{': '}', '[': ']' };

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

/** The properties of the object literal between s[open] '{' and s[close] '}': name and the span of its value. */
function properties(s, open, close) {
  const parts = [];
  let start = open + 1;
  for (let j = open + 1; j < close; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { j = quoteEnd(s, j, close); if (j < 0) return null; }
    else if (CLOSE[c]) { j = matchEnd(s, j, close); if (j < 0) return null; }
    else if (c === ',') { parts.push([start, j]); start = j + 1; }
  }
  parts.push([start, close]);
  const out = [];
  for (const [a, b] of parts) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(s.slice(a, Math.min(b, a + 200)));
    if (m) out.push({ key: m[1], from: a + m[0].length, to: b });
  }
  return out;
}

/** Every schema-shaped object literal in `text` that holds all of `need` at its top level. */
function schemaObjects(text, need) {
  const found = [];
  const seen = new Set();
  const pattern = `${need[0]}:`;
  for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) {
    // The nearest '{' before the key whose object, read with strings skipped, encloses it and has it at its top level.
    let k = -1;
    let end = -1;
    let props = null;
    for (let c = at - 1; c >= 0 && c > at - 20000; c--) {
      if (text[c] !== '{') continue;
      const e = matchEnd(text, c, Math.min(text.length, at + 200000));
      if (e < at) continue;
      const ps = properties(text, c, e);
      if (ps && ps.some((p) => p.key === need[0] && p.from === at + pattern.length)) { k = c; end = e; props = ps; }
      break;
    }
    if (k < 0 || seen.has(k)) continue;
    const names = props.map((p) => p.key);
    const schemaLike = props.every((p) => {
      const v = text.slice(p.from, p.to);
      return /\.optional\(\)/.test(v) || /^\s*[\w$]+\(\)\s*$/.test(v);
    });
    if (schemaLike && need.every((n) => names.includes(n))) { seen.add(k); found.push(props); }
  }
  return found;
}

/** The key paths under `prefix` for these properties, following inline sub-objects (`name({…})…`) other than the
 *  anchored ones, which are read on their own. */
function pathsOf(text, prefix, props, out) {
  for (const p of props) {
    const at = `${prefix}.${p.key}`;
    out.add(at);
    const m = /^\s*[\w$]+\(\{/.exec(text.slice(p.from, p.to));
    if (!m || ANCHORS[at]) continue;
    const open = p.from + m[0].length - 1;
    const end = matchEnd(text, open, p.to);
    const inner = end < 0 ? null : properties(text, open, end);
    if (inner) pathsOf(text, at, inner, out);
  }
}

/** Every key path under sandbox and permissions the schema in `text` accepts, with the two roots, sorted; or why
 *  they could not be read. */
function settingsKeyPaths(text) {
  const out = new Set(['permissions', 'sandbox']);
  for (const [prefix, need] of Object.entries(ANCHORS)) {
    const objects = schemaObjects(text, need);
    if (objects.length === 0) return { error: `no settings schema object holding ${need.join(', ')} was found for ${prefix}` };
    const lists = objects.map((props) => { const s = new Set(); pathsOf(text, prefix, props, s); return [...s].sort(); });
    if (new Set(lists.map((l) => l.join('\n'))).size !== 1) return { error: `the copies of the ${prefix} schema list different keys` };
    for (const p of lists[0]) out.add(p);
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
