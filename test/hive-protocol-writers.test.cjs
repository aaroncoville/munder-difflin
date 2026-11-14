'use strict';

/**
 * The generated PROTOCOL.md tells agents who writes the hive's shared files.
 *
 * tasks.json, board.md, spawn-requests/ and registry.json are written only by the god agent and the app. Every
 * other agent reads them and asks god for card changes by mail; its own files go under its own folder or evidence/.
 * A protocol that tells every agent to keep its task's status current in tasks.json invites concurrent writers to
 * one file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function protocol(t) {
  const base = codexTestBase(t, 'md-proto-');
  const home = path.join(base, 'home');
  const harness = path.join(base, 'h');
  for (const d of [home, harness]) fs.mkdirSync(d, { recursive: true });
  jailHome(t, home);
  const hive = new HiveManager(() => harness);
  hive.ensureHive();
  const text = fs.readFileSync(path.join(harness, 'hive', 'PROTOCOL.md'), 'utf8');
  const start = text.indexOf('## The work: board.md vs tasks.json');
  assert.notEqual(start, -1, 'the section on the shared work files is there');
  const end = text.indexOf('\n## ', start + 1);
  // Read as prose: where a sentence wraps is not part of what it says.
  return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
}

test('the protocol says only the god agent and the app write the shared work files', (t) => {
  const section = protocol(t);
  assert.match(section, /`tasks\.json`, `board\.md`, `spawn-requests\/` and `registry\.json` are written only by the god agent and the app/);
});

test('the protocol tells other agents to read tasks.json and ask god for card changes by mail', (t) => {
  const section = protocol(t);
  assert.match(section, /Other agents read them and never write them/);
  assert.match(section, /mail `god`/);
  assert.doesNotMatch(section, /Keep the task you're working reflected in its status/);
});

test('the protocol says where an agent\'s own files go', (t) => {
  const section = protocol(t);
  assert.match(section, /own folder \(`agents\/<your-id>\/`\) or `evidence\/`/);
});
