'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, flatten } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { PixelPanel } = loadTs('src/renderer/src/components/PixelPanel.tsx');
const { PixelButton } = loadTs('src/renderer/src/components/PixelButton.tsx');
const { PixelBadge } = loadTs('src/renderer/src/components/PixelBadge.tsx');

const CASES = [
  ['PixelPanel', PixelPanel, { children: 'x' }, 'var(--cth-radius-panel)'],
  ['PixelButton', PixelButton, { children: 'x' }, 'var(--cth-radius-control)'],
  ['PixelBadge', PixelBadge, { status: 'idle' }, 'var(--cth-radius-badge)']
];

test('each primitive rounds its outer box through a radius token', () => {
  for (const [name, Component, props, token] of CASES) {
    const inst = mount(Component, props);
    const outer = flatten(inst.tree)[0].node;
    assert.equal(outer.props.style?.borderRadius, token,
      `${name}'s outer box does not read ${token}`);
  }
});

test('a caller can still override the radius', () => {
  // The token belongs in the base style, not after the spread — a call site
  // that passes its own borderRadius has to win, the way it does for every
  // other style these primitives set.
  const inst = mount(PixelPanel, { children: 'x', style: { borderRadius: 12 } });
  assert.equal(flatten(inst.tree)[0].node.props.style.borderRadius, 12);
});
