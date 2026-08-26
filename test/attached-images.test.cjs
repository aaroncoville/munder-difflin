'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { withAttachedImages } = loadTs('src/shared/attachedImages.ts');

test('appends one block listing every image path', () => {
  assert.equal(
    withAttachedImages('looks like this', ['/hive/asks/attachments/T-7/a.png', '/hive/asks/attachments/T-7/b.jpg']),
    'looks like this\n\nAttached images:\n- /hive/asks/attachments/T-7/a.png\n- /hive/asks/attachments/T-7/b.jpg'
  );
});

test('leaves the answer untouched when nothing is attached', () => {
  assert.equal(withAttachedImages('plain answer', []), 'plain answer');
  assert.equal(withAttachedImages('plain answer', undefined), 'plain answer');
});

test('an attachment-only answer still carries the paths', () => {
  assert.equal(withAttachedImages('', ['/x/a.png']), '\n\nAttached images:\n- /x/a.png');
});

test('the same path is only listed once', () => {
  assert.equal(withAttachedImages('a', ['/x/a.png', '/x/a.png']), 'a\n\nAttached images:\n- /x/a.png');
});
