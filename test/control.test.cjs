'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ControlRegistry } = loadTs('src/main/control.ts');

test('auto-delivery pause is independent from tool pause and halt', () => {
  const control = new ControlRegistry();
  control.pauseAutoDelivery('dev1', true);

  assert.equal(control.isAutoDeliveryPaused('dev1'), true);
  assert.equal(control.snapshot('dev1').autoDeliveryPaused, true);
  assert.equal(control.snapshot('dev1').paused, false);
  assert.equal(control.snapshot('dev1').halted, false);

  control.resume('dev1');
  assert.equal(control.isAutoDeliveryPaused('dev1'), true, 'normal resume must not spend queued work');
  control.pauseAutoDelivery('dev1', false);
  assert.equal(control.isAutoDeliveryPaused('dev1'), false);
});

test('persisted delivery pauses replace stale in-memory state', () => {
  const control = new ControlRegistry();
  control.pauseAutoDelivery('old', true);
  control.replaceAutoDeliveryPauses(['dev2', 'dev3']);

  assert.equal(control.isAutoDeliveryPaused('old'), false);
  assert.equal(control.isAutoDeliveryPaused('dev2'), true);
  assert.equal(control.isAutoDeliveryPaused('dev3'), true);
});

test('steer queue is capped so a stalled agent cannot accumulate unbounded notes', () => {
  const control = new ControlRegistry();
  for (let i = 1; i <= 25; i++) control.steer('dev9', `note ${i}`);

  // Only the cap is retained, never all 25.
  assert.equal(control.snapshot('dev9').pendingSteers, 20);

  // FIFO + drop-oldest: the oldest notes are shed, so the survivors start at
  // note 6 and the newest (note 25) is the last one delivered.
  assert.equal(control.takeSteer('dev9'), 'note 6');
  let last = '';
  for (let i = 0; i < 19; i++) last = control.takeSteer('dev9'); // notes 7..25
  assert.equal(last, 'note 25');
  assert.equal(control.takeSteer('dev9'), undefined, 'queue fully drained');
});

test('whitespace-only steers are ignored and never fill the queue', () => {
  const control = new ControlRegistry();
  control.steer('dev9', '   ');
  control.steer('dev9', '');
  control.steer('dev9', 'real guidance');
  assert.equal(control.snapshot('dev9').pendingSteers, 1);
  assert.equal(control.takeSteer('dev9'), 'real guidance');
});

// T-047: Hindsight MCP destructive tools must be denied even for an agent that has
// NO control entry yet — the default-ALLOW hole that the module-level MCP_DENY set closes.
test('toolDecision denies Hindsight destructive MCP tools for an agent with no control entry', () => {
  const control = new ControlRegistry();
  // This agent id has never been seen — map.get returns undefined.
  const deleteBank = control.toolDecision('brand-new-agent', 'mcp__munder_hive_memory__delete_bank');
  assert.equal(deleteBank.deny, true, 'delete_bank must be denied even with no control entry');
  assert.ok(deleteBank.reason, 'a reason string must accompany the denial');

  const clearMems = control.toolDecision('brand-new-agent', 'mcp__munder_hive_memory__clear_memories');
  assert.equal(clearMems.deny, true, 'clear_memories must be denied even with no control entry');

  const deleteDoc = control.toolDecision('brand-new-agent', 'mcp__munder_hive_memory__delete_document');
  assert.equal(deleteDoc.deny, true, 'delete_document must be denied even with no control entry');

  // Sanity: a safe read tool on the same agent must still be ALLOWED (no control entry → no deny).
  const search = control.toolDecision('brand-new-agent', 'mcp__munder_hive_memory__search');
  assert.equal(search.deny, false, 'read-only hive-memory tools must not be caught by the deny set');

  // T-047 — the gate must not depend on how Claude Code normalises `-` in the server
  // segment. Asserting only the spelling the implementation happens to use would pass
  // trivially and still ship a gate that never fires in production, so assert BOTH.
  const hyphenated = control.toolDecision('brand-new-agent', 'mcp__munder-hive-memory__delete_bank');
  assert.equal(hyphenated.deny, true, 'hyphenated server segment must also be denied');
  const hyphenClear = control.toolDecision('brand-new-agent', 'mcp__munder-hive-memory__clear_memories');
  assert.equal(hyphenClear.deny, true, 'hyphenated clear_memories must also be denied');
  const hyphenSearch = control.toolDecision('brand-new-agent', 'mcp__munder-hive-memory__search');
  assert.equal(hyphenSearch.deny, false, 'hyphenated read tool must still not be denied');

  // Guard against an over-broad matcher: a same-named tool on a DIFFERENT server is
  // not ours to block, and blanket-denying by bare tool name would break other servers.
  const otherServer = control.toolDecision('brand-new-agent', 'mcp__munder-filesystem__delete_document');
  assert.equal(otherServer.deny, false, 'delete_document on another server must not be denied');
  const bareName = control.toolDecision('brand-new-agent', 'delete_bank');
  assert.equal(bareName.deny, false, 'unqualified tool name must not be denied');

  // Review of PR #2: the first version folded `-` to `_` across the WHOLE name, so
  // it normalised the tool segment too. `delete-bank` is a DIFFERENT tool from
  // `delete_bank`; denying it would block something we were never asked to block.
  // Segments are matched exactly now — only the two server spellings are accepted.
  const hyphenTool = control.toolDecision('brand-new-agent', 'mcp__munder-hive-memory__delete-bank');
  assert.equal(hyphenTool.deny, false, 'a distinct hyphenated TOOL name must not be swept up');
  const hyphenTool2 = control.toolDecision('brand-new-agent', 'mcp__munder-hive-memory__clear-memories');
  assert.equal(hyphenTool2.deny, false, 'clear-memories is not clear_memories');
  // ...while the real names still are, in both server spellings.
  for (const server of ['munder-hive-memory', 'munder_hive_memory']) {
    for (const tool of ['delete_bank', 'clear_memories', 'delete_document']) {
      assert.equal(control.toolDecision('brand-new-agent', `mcp__${server}__${tool}`).deny, true,
        `mcp__${server}__${tool} must still be denied`);
    }
  }
});
