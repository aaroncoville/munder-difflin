'use strict';

/**
 * MemoryReflector (the janitor's missing CONDENSE half).
 *
 * Production logs show the great majority of condense attempts abort without
 * ever shrinking memory.md, each one still spending a Haiku hidden-session
 * call. The abort reasons break down into five classes:
 *   - summarize-failed: no assistant response found in transcript
 *   - not-smaller (old vs new within a few %)
 *   - summarize-failed: response contained no parseable JSON
 *   - hidden session timed out
 *   - recent-count-mismatch
 *
 * Each test below reproduces one class against a realistic memory.md shape,
 * then proves the fix. hiddenClaude.ts is stubbed (it pulls in node-pty,
 * which a hidden Haiku session can't run in a test) — the LLM call is the
 * only non-deterministic step, and reflect.ts takes it through one seam
 * (`runHiddenClaude`), so stubbing that module is the whole mock surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const HIDDEN = 'src/main/hiddenClaude.ts';

// hiddenClaude.ts pulls in node-pty (a native PTY addon) purely to spawn the
// real interactive session — nothing under test needs a real process, and the
// addon has no place in a unit test. Stub it up front so every `loadTs(...)`
// of reflect.ts below — including the pure-helper tests, which never touch
// the LLM call — resolves './hiddenClaude' to this instead of the real module.
loadTs.stub(HIDDEN, { runHiddenClaude: async () => ({ ok: false, error: 'unstubbed call' }) });

/** Install a fresh runHiddenClaude stub and return {calls, reflectorModule}.
 *  Re-stubs + reloads reflect.ts fresh each time so tests never share the
 *  module-level `require` cache (and thus never share a MemoryReflector's
 *  per-instance backoff state by accident). */
function loadReflectWithStub(handler) {
  const calls = [];
  loadTs.reset();
  loadTs.stub(HIDDEN, {
    runHiddenClaude: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return handler(calls.length, prompt, opts);
    }
  });
  const mod = loadTs('src/main/reflect.ts');
  return { ...mod, calls };
}

const DEFAULT_SETTINGS = {
  enabled: true, intervalMs: 1_800_000,
  byteTriggerPct: 0, sectionTrigger: 50, recentKeep: 12, minBytes: 50,
  keepBudgetPct: 25
};

function settings(over = {}) { return { ...DEFAULT_SETTINGS, ...over }; }

/** A fresh temp hive home with `hive/agents/<id>/memory.md` written out. */
function homeWith(id, content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reflect-'));
  const dir = path.join(home, 'hive', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  const mem = path.join(dir, 'memory.md');
  fs.writeFileSync(mem, content, 'utf8');
  return { home, mem };
}

function makeReflector(mod, home, over = {}) {
  return new mod.MemoryReflector(
    () => home,
    () => 'claude',
    () => ({}),
    () => settings(over),
    () => {} // log sink — assertions read the returned ReflectResult instead
  );
}

const pad = (label, bytes) => `${label}${'x'.repeat(Math.max(0, bytes - label.length))}`;

function section(heading, bodyBytes, tag = 'body') {
  return `## ${heading}\n${pad(tag, bodyBytes)}\n`;
}

function fixture({ pinned = 'fact one\nfact two', condensed = null, sections: secs }) {
  const header = '# Memory — test agent\n\n_Append durable facts below._\n';
  const parts = [header, `## 📌 Durable facts (pinned — never condensed)\n\n${pinned}\n`];
  if (condensed !== null) parts.push(`## 🗜 Condensed history\n\n${condensed}\n`);
  parts.push('## Recent\n');
  parts.push(...secs);
  return parts.join('\n');
}

const okJson = (condensed, hoist = []) => ({ ok: true, text: JSON.stringify({ condensed, hoist }) });

// ── pure helpers ──────────────────────────────────────────────────────────

test('selectKeep: byte budget evicts beyond the section-count limit', () => {
  const { selectKeep } = loadTs('src/main/reflect.ts');
  const recent = [
    { heading: '## a', body: 'x'.repeat(800) },
    { heading: '## b', body: 'x'.repeat(800) },
    { heading: '## c', body: 'x'.repeat(800) },
    { heading: '## d', body: 'x'.repeat(800) }
  ];
  // All 4 fit comfortably under recentKeep=12 (the OLD behavior: keep all 4,
  // evict nothing — exactly the "not-smaller" shape: nothing to summarize).
  const { keep: keepAll, evict: evictNone } = selectKeep(recent, 12, 1_000_000);
  assert.equal(keepAll.length, 4);
  assert.equal(evictNone.length, 0);

  // A tight byte budget forces eviction of the older sections even though
  // all 4 are within the count limit — this is the root-cause fix.
  const { keep, evict } = selectKeep(recent, 12, 1_500);
  assert.ok(keep.length < 4, 'byte budget must evict something the count limit alone would keep');
  assert.ok(evict.length > 0);
  // Newest-first eviction order preserved: kept sections are always the tail.
  assert.equal(keep[keep.length - 1].heading, '## d');
});

test('selectKeep: never evicts the single newest section, even over budget', () => {
  const { selectKeep } = loadTs('src/main/reflect.ts');
  const recent = [{ heading: '## only', body: 'x'.repeat(50_000) }];
  const { keep, evict } = selectKeep(recent, 12, 100);
  assert.equal(keep.length, 1);
  assert.equal(evict.length, 0);
});

test('demoteEmbeddedHeadings: only the exact "## " marker is demoted', () => {
  const { demoteEmbeddedHeadings } = loadTs('src/main/reflect.ts');
  const out = demoteEmbeddedHeadings(
    ['## Sneaky Header', '### already deeper', 'plain text', '##no-space-not-a-heading'].join('\n')
  );
  const lines = out.split('\n');
  assert.equal(lines[0], '### Sneaky Header');   // demoted one level
  assert.equal(lines[1], '### already deeper');  // untouched
  assert.equal(lines[2], 'plain text');           // untouched
  assert.equal(lines[3], '##no-space-not-a-heading'); // untouched (not a heading per parseMemory either)
});

test('parseSummary: plain JSON and start/end-anchored fence still work (regression)', () => {
  const { parseSummary } = loadTs('src/main/reflect.ts');
  assert.deepEqual(parseSummary('{"condensed":"c","hoist":["h1"]}'), { condensed: 'c', hoist: ['h1'] });
  assert.deepEqual(parseSummary('```json\n{"condensed":"c","hoist":[]}\n```'), { condensed: 'c', hoist: [] });
  assert.deepEqual(
    parseSummary(JSON.stringify({ result: '{"condensed":"c","hoist":[]}' })),
    { condensed: 'c', hoist: [] }
  );
});

test('parseSummary: preamble before a fence now parses (was the 195-case failure)', () => {
  const { parseSummary } = loadTs('src/main/reflect.ts');
  const text = 'Here is the compacted summary:\n```json\n{"condensed":"c","hoist":["h"]}\n```\nLet me know if you need anything else!';
  assert.deepEqual(parseSummary(text), { condensed: 'c', hoist: ['h'] });
});

test('parseSummary: raw JSON with preamble/trailing prose and no fence now parses', () => {
  const { parseSummary } = loadTs('src/main/reflect.ts');
  const text = 'Sure, here you go: {"condensed":"c is fine, trust me {not json}","hoist":[]} — done.';
  assert.deepEqual(parseSummary(text), { condensed: 'c is fine, trust me {not json}', hoist: [] });
});

test('parseSummary: a brace inside a string value never ends the scan early', () => {
  const { parseSummary } = loadTs('src/main/reflect.ts');
  const text = '{"condensed": "has a closing brace mid-string: } still going", "hoist": []} trailing junk with a } too';
  assert.deepEqual(parseSummary(text), { condensed: 'has a closing brace mid-string: } still going', hoist: [] });
});

test('parseSummary: genuinely unparseable text still returns null', () => {
  const { parseSummary } = loadTs('src/main/reflect.ts');
  assert.equal(parseSummary('I could not summarize this, sorry.'), null);
  assert.equal(parseSummary(''), null);
});

// ── integration: condense() through the stubbed hidden session ────────────

test('repro: "no assistant response" aborts cleanly and leaves the file untouched', async () => {
  const { home, mem } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const before = fs.readFileSync(mem, 'utf8');
  const { MemoryReflector, calls } = loadReflectWithStub(() => ({
    ok: false, error: 'no assistant response found in transcript'
  }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, false);
  assert.equal(result.reason, 'summarize-failed');
  // Retried the transcript-race once, per TRANSCRIPT_RACE_ATTEMPTS — then gave up.
  assert.equal(calls.length, 2);
  assert.equal(fs.readFileSync(mem, 'utf8'), before, 'original must be byte-identical on abort');
});

test('fix: "no assistant response" succeeds on the retry (race, not a real failure)', async () => {
  const { home } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const { MemoryReflector, calls } = loadReflectWithStub((n) =>
    n === 1
      ? { ok: false, error: 'no assistant response found in transcript' }
      : okJson('short summary', [])
  );
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, true);
  assert.equal(calls.length, 2);
});

test('repro: a workspace-trust-dialog block is NOT retried (identical dialog every attempt)', async () => {
  const { home, mem } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const before = fs.readFileSync(mem, 'utf8');
  const { MemoryReflector, calls } = loadReflectWithStub(() => ({
    ok: false, error: 'workspace trust dialog blocked the session (cwd is not a trusted Claude Code directory)'
  }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, false);
  assert.equal(calls.length, 1, 'a trust-dialog block is a different failure than the transcript race and is not retried');
  assert.equal(fs.readFileSync(mem, 'utf8'), before);
});

test('repro: a genuine timeout is NOT retried (retrying would double the cost for nothing)', async () => {
  const { home, mem } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const before = fs.readFileSync(mem, 'utf8');
  const { MemoryReflector, calls } = loadReflectWithStub(() => ({
    ok: false, error: 'hidden session timed out'
  }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, false);
  assert.equal(result.reason, 'summarize-failed');
  assert.equal(calls.length, 1, 'a real timeout must not be retried');
  assert.equal(fs.readFileSync(mem, 'utf8'), before);
});

test('timeout budget scales with the eviction payload size', async () => {
  const bigSections = [section('a', 40_000), section('b', 300)];
  const { home } = homeWith('a1', fixture({ sections: bigSections }));
  const { MemoryReflector, calls } = loadReflectWithStub(() => ({ ok: false, error: 'hidden session timed out' }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  await reflector.reflectNow('a1');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].opts.timeoutMs > 180_000, 'a large eviction payload must get more than the base budget');
});

test('repro: unparseable response aborts cleanly, no wasted retry', async () => {
  const { home, mem } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const before = fs.readFileSync(mem, 'utf8');
  const { MemoryReflector, calls } = loadReflectWithStub(() => ({ ok: true, text: 'not json at all, sorry' }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, false);
  assert.equal(result.reason, 'summarize-failed');
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(mem, 'utf8'), before);
});

test('fix: preambled/trailing-prose response now condenses successfully', async () => {
  const { home } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const { MemoryReflector, calls } = loadReflectWithStub(() => ({
    ok: true,
    text: 'Here is the JSON:\n```json\n{"condensed":"tight summary","hoist":[]}\n```\nHope that helps!'
  }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, true);
  assert.equal(calls.length, 1);
});

test('fix: a framed answer with a preamble and trailing prose condenses successfully', async () => {
  // The same model habit as the JSON case above, under the framed contract the
  // prompt now asks for.
  const { home } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const { MemoryReflector, calls } = loadReflectWithStub(() => ({
    ok: true,
    text: 'Here is the condensed block:\n<<<CONDENSED>>>\ntight summary\n<<<HOIST>>>\n(none)\n<<<END>>>\nHope that helps!'
  }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, true, `framed answer was refused: ${result.reason}`);
  assert.equal(calls.length, 1);
});

test('repro: an embedded "## " line in the model output causes recent-count-mismatch pre-fix shape; demote fixes it', async () => {
  const { home, mem } = homeWith('a1', fixture({
    sections: [section('old one', 300), section('old two', 300), section('newest', 300)]
  }));
  const { MemoryReflector } = loadReflectWithStub(() =>
    okJson('## Sneaky Header\nsome text the model echoed as a sub-heading', [])
  );
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, true, `must not abort on embedded heading: ${result.reason}`);
  const { parseMemory, countSections } = loadTs('src/main/reflect.ts');
  const written = fs.readFileSync(mem, 'utf8');
  const parsed = parseMemory(written);
  // Exactly one recent section survives (the kept newest one) — the embedded
  // "## Sneaky Header" line did NOT get re-parsed as a second section.
  assert.equal(parsed.recent.length, 1);
  assert.ok(parsed.condensed.includes('### Sneaky Header'), 'the heading must be demoted, not dropped');
  // pinned + condensed + the "## Recent" divider line are the 3 fixed `## `
  // headings outside the recent list itself.
  assert.equal(countSections(written) - 3, parsed.recent.length, 'no phantom sections beyond pinned+condensed+divider');
});

test('fix: a tight keep-budget forces eviction the section-count limit alone would skip', async () => {
  // 4 sections, all well within recentKeep=12 — the OLD behavior kept all 4
  // verbatim and had nothing to evict, which is the root shape of the
  // majority "not-smaller" class (recentKeep defaults to 12 in production).
  const secs = [section('a', 800), section('b', 800), section('c', 800), section('d', 800)];
  const { home, mem } = homeWith('a1', fixture({ sections: secs }));
  const before = fs.statSync(mem).size;
  const { MemoryReflector, calls } = loadReflectWithStub(() => okJson('tiny summary', []));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 12, keepBudgetPct: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(calls.length, 1, 'a tight keep budget must force a real eviction, not "nothing-to-evict"');
  assert.equal(result.condensed, true);
  assert.ok(result.newBytes < before, 'file must actually shrink');
});

test('repro: not-smaller aborts when the summary barely shrinks the file', async () => {
  const bodyText = 'y'.repeat(600);
  const secs = [section('old one', 600, bodyText), section('old two', 600, bodyText), section('newest', 300)];
  const { home, mem } = homeWith('a1', fixture({ sections: secs }));
  const before = fs.readFileSync(mem, 'utf8');
  // Stub echoes back nearly everything that was evicted — no real shrink.
  const { MemoryReflector } = loadReflectWithStub((n, prompt) => {
    const evictedPortion = prompt.split('(B) OLDER SECTIONS BEING EVICTED:')[1].split('(C)')[0];
    return okJson(evictedPortion.trim(), []);
  });
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, false);
  assert.equal(result.reason, 'not-smaller');
  assert.equal(fs.readFileSync(mem, 'utf8'), before, 'a rejected rewrite must never touch the original');
});

test('fix: backoff skips the autonomous scan after not-smaller until the file grows', async () => {
  const bodyText = 'y'.repeat(600);
  const secs = [section('old one', 600, bodyText), section('old two', 600, bodyText), section('newest', 300)];
  const { home, mem } = homeWith('a1', fixture({ sections: secs }));
  const echoStub = (n, prompt) => {
    const evictedPortion = prompt.split('(B) OLDER SECTIONS BEING EVICTED:')[1].split('(C)')[0];
    return okJson(evictedPortion.trim(), []);
  };
  const { MemoryReflector, calls } = loadReflectWithStub(echoStub);
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });

  // First autonomous scan: attempts, aborts not-smaller, records the backoff.
  const [first] = await reflector.reflectNow();
  assert.equal(first.reason, 'not-smaller');
  assert.equal(calls.length, 1);

  // Second scan, file unchanged: must be skipped WITHOUT another LLM call.
  const [second] = await reflector.reflectNow();
  assert.equal(second.reason, 'not-smaller-backoff');
  assert.equal(calls.length, 1, 'backoff must not spend another hidden-session call');

  // Grow the file past the backoff margin (append a new recent section) —
  // the scan must attempt again.
  const grown = fs.readFileSync(mem, 'utf8') + '\n' + section('grown', 2_000);
  fs.writeFileSync(mem, grown, 'utf8');
  const [third] = await reflector.reflectNow();
  assert.equal(calls.length, 2, 'growth past the backoff margin must re-attempt');
  assert.notEqual(third.reason, 'not-smaller-backoff');
});

test('manual (onlyId) condense bypasses both the trigger and the backoff', async () => {
  const bodyText = 'y'.repeat(600);
  const secs = [section('old one', 600, bodyText), section('old two', 600, bodyText), section('newest', 300)];
  const { home } = homeWith('a1', fixture({ sections: secs }));
  const echoStub = (n, prompt) => {
    const evictedPortion = prompt.split('(B) OLDER SECTIONS BEING EVICTED:')[1].split('(C)')[0];
    return okJson(evictedPortion.trim(), []);
  };
  const { MemoryReflector, calls } = loadReflectWithStub(echoStub);
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1, minBytes: 1_000_000 });
  await reflector.reflectNow('a1'); // not-smaller, records backoff
  await reflector.reflectNow('a1'); // manual call must retry anyway (bypasses backoff)
  assert.equal(calls.length, 2);
});

test('a clean condense actually shrinks the file and round-trips structurally', async () => {
  const secs = [
    section('old one', 2_000), section('old two', 2_000), section('old three', 2_000), section('newest', 300)
  ];
  const { home, mem } = homeWith('a1', fixture({ pinned: 'existing fact', sections: secs }));
  const before = fs.statSync(mem).size;
  const { MemoryReflector } = loadReflectWithStub(() => okJson('a genuinely short summary', ['a new durable fact']));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  const [result] = await reflector.reflectNow('a1');
  assert.equal(result.condensed, true);
  assert.ok(result.newBytes < before * 0.95);

  const { parseMemory } = loadTs('src/main/reflect.ts');
  const parsed = parseMemory(fs.readFileSync(mem, 'utf8'));
  assert.ok(parsed.pinned.includes('existing fact'));
  assert.ok(parsed.pinned.includes('a new durable fact'), 'hoisted fact must be merged into pinned');
  assert.equal(parsed.condensed, 'a genuinely short summary');
  assert.equal(parsed.recent.length, 1);
  assert.equal(parsed.recent[0].heading, '## newest');
});

test('a backup copy is written before any condense attempt, success or abort', async () => {
  const secs = [section('old one', 300), section('old two', 300), section('newest', 300)];
  const { home } = homeWith('a1', fixture({ sections: secs }));
  const { MemoryReflector } = loadReflectWithStub(() => ({ ok: false, error: 'hidden session timed out' }));
  const reflector = makeReflector({ MemoryReflector }, home, { recentKeep: 1 });
  await reflector.reflectNow('a1');
  const backupsDir = path.join(home, 'hive', 'backups');
  assert.ok(fs.existsSync(backupsDir));
  const stamps = fs.readdirSync(backupsDir);
  assert.equal(stamps.length, 1);
  const backupFile = path.join(backupsDir, stamps[0], 'a1', 'memory.md');
  assert.ok(fs.existsSync(backupFile));
});
