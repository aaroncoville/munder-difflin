'use strict';
// A scheduled task's definition, in the store's import format (test/fixtures/scheduler/daily-task.json is one), and
// the slots its schedule makes. Import is a pure function: it parses and checks the definition and returns it, or
// refuses it naming the field at fault; it writes nothing. A task whose cap is above the floor-wide ceiling is refused
// at import. A slot is named by the schedule (the day and the scheduled time), never by the moment it was computed, so
// every look at the clock inside one slot names the same slot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { floor, at } = require('./scheduler-fixtures.cjs');

const T = loadTs('src/core/scheduler/task.ts');
const S = loadTs('src/core/scheduler/store.ts');

const FIXTURE = path.join(__dirname, 'fixtures', 'scheduler', 'daily-task.json');

test('Given the task file, when it is imported and stored, then the stored definition equals the file', (t) => {
  const f = floor(t);
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const def = T.importTaskDefinition(text);
  assert.deepEqual(def, JSON.parse(text));
  const store = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
  t.after(() => store.close());
  store.putTask(def, at(0, 6));
  assert.deepEqual(store.getTask(def.id), JSON.parse(text));
});

test('Given the task file, when it is imported, then nothing is written', (t) => {
  const f = floor(t);
  const before = fs.readdirSync(f.base).sort();
  T.importTaskDefinition(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(fs.readdirSync(f.base).sort(), before);
});

const good = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const MALFORMED = [
  ['id', (d) => { delete d.id; }],
  ['id', (d) => { d.id = '../x'; }],
  ['agentId', (d) => { d.agentId = 7; }],
  ['prompt', (d) => { d.prompt = '   '; }],
  ['schedule', (d) => { d.schedule = '07:19'; }],
  ['schedule.daily', (d) => { d.schedule = { daily: '7:19am' }; }],
  ['schedule.daily', (d) => { d.schedule = { daily: '24:00' }; }],
  ['model', (d) => { delete d.model; }],
  ['maxBudgetUsd', (d) => { d.maxBudgetUsd = 0; }],
  ['maxBudgetUsd', (d) => { d.maxBudgetUsd = '5'; }],
  ['outputFile', (d) => { d.outputFile = 'digest.md'; }],
  ['cwd', (d) => { d.cwd = 'relative/folder'; }],
  ['roots', (d) => { d.roots = ['relative']; }],
  ['timeoutMs', (d) => { d.timeoutMs = -1; }],
  ['surprise', (d) => { d.surprise = true; }],
];

for (const [field, spoil] of MALFORMED) {
  test(`Given a task file whose ${field} is malformed, when it is imported, then it is refused naming ${field}`, () => {
    const d = good();
    spoil(d);
    assert.throws(() => T.importTaskDefinition(JSON.stringify(d)), (e) => {
      assert.ok(e instanceof T.TaskDefinitionInvalid, `a TaskDefinitionInvalid, got ${e}`);
      assert.equal(e.field, field);
      assert.ok(e.message.includes(field), e.message);
      return true;
    });
  });
}

test('Given a task file that is not JSON, when it is imported, then it is refused saying so', () => {
  assert.throws(() => T.importTaskDefinition('{ "id": '), (e) => e instanceof T.TaskDefinitionInvalid && /JSON/.test(e.message));
});

test('Given a task whose cap is above the floor-wide ceiling, when it is imported, then it is refused naming maxBudgetUsd and the ceiling', () => {
  const d = good();
  d.maxBudgetUsd = 12;
  assert.throws(() => T.importTaskDefinition(JSON.stringify(d), { ceilingUsd: 10 }), (e) => {
    assert.equal(e.field, 'maxBudgetUsd');
    assert.match(e.message, /12.*ceiling.*10/);
    return true;
  });
  d.maxBudgetUsd = 10;
  assert.equal(T.importTaskDefinition(JSON.stringify(d), { ceilingUsd: 10 }).maxBudgetUsd, 10);
});

test('Given a daily schedule, when the slot at or before a moment is asked for, then it is named by the schedule, not by the moment', () => {
  const daily = { daily: '07:19' };
  const a = T.slotAtOrBefore(daily, at(1, 7, 19));
  const b = T.slotAtOrBefore(daily, at(1, 23, 59) + 59_999);
  assert.equal(a.key, '2026-11-21T07:19');
  assert.equal(b.key, a.key, 'every moment in one slot names that slot');
  assert.equal(a.at, at(1, 7, 19));
  assert.equal(T.slotAtOrBefore(daily, at(1, 7, 18)).key, '2026-11-20T07:19', 'before the time, the slot is the day before');
});
