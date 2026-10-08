'use strict';

/**
 * The model a narrow helper agent (triage, routing, verification, formatting)
 * gets by default. It has to be one the app ships in its catalog: the settings
 * picker can only show what the catalog lists, and an id the CLI has never
 * shipped fails every turn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { modelForRole } = loadTs('src/main/config.ts');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/shared/modelCatalog.json'), 'utf8'));

test('a narrow helper defaults to Haiku 5.5', () => {
  for (const role of ['triage', 'router', 'verifier', 'formatter', 'summarizer', 'classifier', 'labeler']) {
    assert.equal(modelForRole({ role }), 'claude-haiku-5-5', role);
  }
});

test('the helper default is a model the catalog lists', () => {
  const helper = modelForRole({ role: 'triage' });
  assert.ok(catalog.providers.claude.some((m) => m.id === helper), helper);
});
