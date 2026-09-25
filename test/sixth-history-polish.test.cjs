'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('visible application chrome carries the Sixth History identity', () => {
  const app = read('src/renderer/src/App.tsx');
  const focus = read('src/renderer/src/components/FullscreenTerminal.tsx');
  const html = read('src/renderer/index.html');
  const main = read('src/main/index.ts');
  for (const [name, source] of Object.entries({ app, focus, html, main })) {
    assert.doesNotMatch(source, /MUNDER DIFFLIN/, `${name} still shows the upstream wordmark`);
  }
  assert.match(app, /assets\/sixth-history\/logo\.png/);
  assert.match(app, /alt="Sixth History"/);
  assert.match(focus, /SIXTH HISTORY · FOCUS MODE/);
  assert.match(html, /<title>Sixth History<\/title>/);
  assert.match(main, /Sixth History — Floor/);
});

test('the occult palette separates parchment text from ink surfaces without brown terminal panels', () => {
  const css = read('src/renderer/src/design/occult/occult-tokens.css');
  const terminal = read('src/renderer/src/design/occult/occultTerminal.ts');
  assert.match(css, /--cth-paper-100:\s*#352531/);
  assert.match(css, /--cth-paper-200:\s*#211923/);
  assert.match(terminal, /background:\s*'#352531'/);
  assert.match(terminal, /'editor\.background':\s*'#352531'/);
});

test('the orchestrator uses the Sixth History mark instead of a Michael portrait', () => {
  const portraits = read('src/renderer/src/scene/study/portraits.ts');
  assert.match(portraits, /sixthHistoryLogo/);
  assert.match(portraits, /if \(agent\.isGod\) return sixthHistoryLogo/);
});

test('packaged icon assets exist for every desktop target', () => {
  for (const file of ['build/icon.png', 'build/icon.icns', 'build/icon.ico']) {
    const stat = fs.statSync(path.resolve(__dirname, '..', file));
    assert.ok(stat.size > 1024, `${file} is missing or implausibly small`);
  }
});
