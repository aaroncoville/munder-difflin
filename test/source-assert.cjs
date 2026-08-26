'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function activeSource(filePath) {
  const ts = require('typescript');
  const raw = fs.readFileSync(path.resolve(ROOT, filePath), 'utf8');

  // Use the TypeScript parser to find comment ranges precisely. The naive
  // regex approach treats // and /* */ tokens inside string literals, template
  // literals, and regex literals as comments — blanking executable code.
  // Example: `const url = "https://x.io"; call();` would be truncated at the
  // // inside the string, deleting `call()` from the assertion surface.
  const sf = ts.createSourceFile('__sa__.ts', raw, ts.ScriptTarget.Latest, true);
  const rangeMap = new Map();

  function collect(pos) {
    const lc = ts.getLeadingCommentRanges(raw, pos);
    if (lc) for (const r of lc) rangeMap.set(r.pos, r.end);
    const tc = ts.getTrailingCommentRanges(raw, pos);
    if (tc) for (const r of tc) rangeMap.set(r.pos, r.end);
  }

  function visit(node) {
    collect(node.getFullStart());
    collect(node.getEnd());
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // Replace each comment character with a space. This preserves string
  // positions so that any index-based slice on the returned value stays valid
  // (raw and activeSource output are always the same length).
  const chars = raw.split('');
  for (const [pos, end] of rangeMap) {
    for (let i = pos; i < end; i++) chars[i] = ' ';
  }
  return chars.join('');
}

function boundedSlice(src, startAnchor, endAnchor) {
  const start = src.indexOf(startAnchor);
  if (start === -1) throw new Error(`boundedSlice: startAnchor not found: ${JSON.stringify(startAnchor)}`);
  const end = src.indexOf(endAnchor, start);
  if (end === -1) throw new Error(`boundedSlice: endAnchor not found after start: ${JSON.stringify(endAnchor)}`);
  if (end <= start) throw new Error(`boundedSlice: endAnchor position (${end}) is not after startAnchor (${start})`);
  return src.slice(start, end);
}

module.exports = { activeSource, boundedSlice };
