'use strict';
/**
 * Renders the REAL primitives through the test harness and drops their output
 * into a page that links the REAL stylesheets, so a screenshot shows the actual
 * component markup under the actual tokens rather than a redrawn mock.
 */
const fs = require('node:fs');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
const { mount } = require('../test/render-hooks.cjs');
const loadTs = require('../test/load-ts.cjs');

global.window = { localStorage: { getItem: () => 'occult', setItem: () => {} } };
global.document = { documentElement: { dataset: {} } };

const { PixelPanel } = loadTs('src/renderer/src/components/PixelPanel.tsx');
const { PixelButton } = loadTs('src/renderer/src/components/PixelButton.tsx');
const { PixelBadge } = loadTs('src/renderer/src/components/PixelBadge.tsx');
// Absent before this branch; the page renders the same without it, which is
// what makes the light/dark shots comparable across the two trees.
let SixthHistoryCredit = () => null;
try {
  ({ SixthHistoryCredit } = loadTs('src/renderer/src/components/SixthHistoryCredit.tsx'));
} catch { /* pre-branch tree */ }

const VOID = new Set(['img', 'br', 'hr', 'input']);
const dashed = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const styleAttr = (s) => Object.entries(s)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${dashed(k)}:${typeof v === 'number' ? v + 'px' : v}`).join(';');

function html(node) {
  if (node == null || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(html).join('');
  if (typeof node !== 'object') return String(node);
  const { type, props } = node;
  if (typeof type === 'function') return html(type(props));
  const attrs = [];
  if (props.style) attrs.push(`style="${styleAttr(props.style)}"`);
  if (props.src) attrs.push(`src="${props.src}"`);
  if (props.alt) attrs.push(`alt="${props.alt}"`);
  const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  if (VOID.has(type)) return open;
  return `${open}${html(props.children)}</${type}>`;
}

const render = (C, props) => html(mount(C, props).tree);

const STATUSES = ['idle', 'thinking', 'working', 'waiting', 'blocked', 'success',
  'ghost', 'compacting', 'looping', 'typing'];

const body = `
<div class="grid">
  ${render(PixelPanel, { title: 'THE STUDY', children:
      `<p style="margin:0 0 10px">Body text is Inter and does not change with the dress. `
    + `The display face, the corner, the hairline and the ground all do.</p>`
    + `<input value="an input, with a caret and an I-beam" style="width:100%;padding:6px;background:var(--cth-paper-100);color:var(--cth-ink-900);border:none;box-shadow:inset 0 0 0 1px var(--cth-ink-300);border-radius:var(--cth-radius-control)">` })}
  ${render(PixelPanel, { variant: 'dialog', title: 'DIALOG', children:
      `<div style="display:flex;gap:8px;flex-wrap:wrap">`
    + ['primary', 'secondary', 'ghost', 'destructive']
        .map((v) => render(PixelButton, { variant: v, children: v })).join('')
    + `</div>` })}
  ${render(PixelPanel, { variant: 'inset', title: 'STATUS', children:
      `<div style="display:flex;gap:6px;flex-wrap:wrap">`
    + STATUSES.map((s) => render(PixelBadge, { status: s })).join('')
    + `</div>` })}
  ${render(PixelPanel, { variant: 'terminal', title: 'TERMINAL', children:
      `<pre style="margin:0;font-family:var(--cth-font-mono);font-size:var(--cth-text-mono-sm);color:var(--cth-ink-900)">`
    + `$ npm run test:focused\n# pass 907\n# fail 0</pre>` })}
</div>
<div class="footer">${render(SixthHistoryCredit, {})}</div>`;

const page = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="../src/renderer/src/design/global.css">
<style>
  body { padding: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 900px; }
  h1 { font-family: var(--cth-font-display); font-size: var(--cth-text-display-lg);
       line-height: var(--cth-lh-display-lg); margin: 0 0 4px; }
  .sub { font-size: var(--cth-text-body-sm); color: var(--cth-ink-500); margin: 0 0 20px; }
  /* The credit is theme-gated in the component; this page renders its markup
     once, so the same gate is restated here for the specimen. */
  .footer { display: none; margin-top: 20px; padding: 10px 0;
            border-top: 1px solid var(--cth-ink-300); max-width: 900px; }
  :root[data-cth-theme='occult'] .footer { display: flex; }
</style></head>
<body>
<h1>MUNDER DIFFLIN — CHROME SPECIMEN</h1>
<p class="sub">Real PixelPanel / PixelButton / PixelBadge / SixthHistoryCredit output, real design/*.css.</p>
${body}
</body></html>`;

fs.writeFileSync(path.join(__dirname, 'specimen.html'), page);
console.log('wrote evidence/specimen.html');
