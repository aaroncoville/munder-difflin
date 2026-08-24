'use strict';

/**
 * T-045 — a spawn-request may instantiate a HIRE, not just an ad-hoc worker.
 *
 * The security property this file exists to pin down: a hire manifest is authored
 * by god (or arrives in a shared file), and **a god-authored spawn-request is not
 * human consent**. So no manifest may ever arm a write/secret MCP server, however
 * it asks. `mergeHireMcpDefaults` is the second of two tier gates and the one that
 * runs on the spawn path, so it is tested directly rather than through the plan.
 *
 * The rest covers the merge/precedence rules a hire relies on to stay a DEFAULT
 * rather than an override.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { mergeHireMcpDefaults, resolveHireManifestPath, resolveHireDefaults } = loadTs('src/main/hireSpawn.ts');
const { validateHireManifest, HIRE_SPEC_V1 } = loadTs('src/shared/hire.ts');
const { MAX_AGENT_TOKEN_CAP } = loadTs('src/shared/tokenCaps.ts');
const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

// DERIVED from the catalog, never copied literals. Review of PR #1 caught the
// copied-literal version, and rightly: a test that hardcodes the same ids the
// implementation classifies keeps passing when the catalog's tiers change
// underneath it, which is the one moment it most needs to fail. This is the same
// defect god flagged in someone else's work the same morning.
const SAFE = MCP_CATALOG.find((e) => e.tier === 'safe-readonly').id;
const UNSAFE = MCP_CATALOG.filter((e) => e.tier !== 'safe-readonly').map((e) => e.id);
assert.ok(SAFE, 'catalog must contain at least one safe-readonly entry');
assert.ok(UNSAFE.length, 'catalog must contain at least one write/secret entry');

test('a manifest can never arm ANY write/secret MCP server in the catalog', () => {
  // Every non-safe id, not a sample: a new secret entry added to the catalog
  // tomorrow is covered by this test today.
  const out = mergeHireMcpDefaults(undefined, UNSAFE);
  for (const id of UNSAFE) {
    assert.equal(out?.[id], undefined, `${id} must never be enabled by a manifest`);
  }
});

test('a mixed request enables only the safe half', () => {
  const out = mergeHireMcpDefaults({}, [SAFE, ...UNSAFE]);
  assert.deepEqual(out[SAFE], { enabled: true }, 'safe-readonly id should be enabled');
  for (const id of UNSAFE) assert.equal(out[id], undefined, `${id} must be dropped, not enabled`);
});

test("an explicit human 'off' outranks the manifest", () => {
  const out = mergeHireMcpDefaults({ [SAFE]: { enabled: false } }, [SAFE]);
  assert.deepEqual(out[SAFE], { enabled: false }, 'a manifest may not re-enable what the human switched off');
});

test('an already-on entry is left exactly as the human set it', () => {
  const base = { [SAFE]: { enabled: true } };
  const out = mergeHireMcpDefaults(base, [SAFE]);
  assert.deepEqual(out[SAFE], { enabled: true });
  assert.notEqual(out, base, 'the base map must not be mutated in place');
});

test('a hire id may not escape the hires directory', () => {
  for (const bad of ['../secrets', 'a/b', '/etc/passwd', '', '   ']) {
    assert.equal(resolveHireManifestPath('/hive/hires', bad).ok, false, `"${bad}" must be rejected`);
  }
  assert.equal(resolveHireManifestPath('/hive/hires', 'dwight-qa').ok, true);
  assert.equal(resolveHireManifestPath('/hive/hires', 'dwight-qa.hire.json').ok, true);
});

test("a hire's flags ride BEHIND the request's own", () => {
  const l = buildWorkerLaunch({
    requestCommand: 'claude --verbose',
    autoMode: false,
    hireFlags: ['--permission-mode', 'plan']
  });
  assert.equal(l.bin, 'claude');
  assert.deepEqual(l.args, ['--verbose', '--permission-mode', 'plan']);
  assert.equal(l.command, 'claude --verbose --permission-mode plan');
});

test('a hire model does not override a model the command line already picked', () => {
  // The request's own --model wins; the separate model field must not double up.
  const l = buildWorkerLaunch({
    requestCommand: 'claude --model gpt-5.6-terra',
    requestModel: 'claude-opus-5',
    autoMode: false
  });
  assert.equal(l.args.filter((a) => a === '--model').length, 1, 'exactly one --model may survive');
  assert.ok(l.args.includes('gpt-5.6-terra'));
  assert.ok(!l.args.includes('claude-opus-5'));
});

test('no hire flags is identical to the pre-hire behaviour', () => {
  const withNone = buildWorkerLaunch({ requestCommand: 'claude --verbose', autoMode: false });
  const withEmpty = buildWorkerLaunch({ requestCommand: 'claude --verbose', autoMode: false, hireFlags: [] });
  assert.deepEqual(withEmpty, withNone);
});


// ── precedence (regression: PR #1 review) ───────────────────────────────────
// A codex hire with no request provider launched under codex but was BROADCAST
// as claude, so a restart restored it as the wrong CLI. The bug was one consumer
// reading the request's value and forgetting the manifest's. These pin the rule
// itself rather than any one call site.

test('the request wins on every field it states', () => {
  const eff = resolveHireDefaults(
    { provider: 'codex', model: 'm-req', name: 'n-req', character: 'c-req', accent: 'a-req' },
    { provider: 'claude', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire' }
  );
  assert.deepEqual(eff, { provider: 'codex', model: 'm-req', name: 'n-req', character: 'c-req', accent: 'a-req', tokenCap: undefined });
});

test('the manifest fills every field the request leaves unset', () => {
  const eff = resolveHireDefaults({}, {
    provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire', tokenCap: undefined
  });
  assert.deepEqual(eff, { provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire', tokenCap: undefined });
  assert.equal(eff.provider, 'codex', "the exact regression: a codex hire must not resolve to claude");
});

test('an empty or whitespace request value is not a stated choice', () => {
  const eff = resolveHireDefaults(
    { provider: '', model: '   ', name: '', character: null, accent: undefined },
    { provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire' }
  );
  assert.deepEqual(eff, { provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire', tokenCap: undefined });
});

test('with no manifest at all, nothing is invented', () => {
  assert.deepEqual(resolveHireDefaults({ provider: 'codex' }, undefined),
    { provider: 'codex', model: undefined, name: undefined, character: undefined, accent: undefined, tokenCap: undefined });
});


// ── tokenCap precedence (T-062: spend control) ──────────────────────────────
// A manifest's `tokenCap` was never consulted on spawn: the cap came solely from
// the spawn-request JSON, so a hire that declares a ceiling launched UNCAPPED
// whenever the request omitted one — and omitting it is the safe-looking choice.
// tokenCap now resolves through the same one place as every other hire field.
// The numbers below are arbitrary literals; nothing here is shared with the
// implementation, which carries no cap constant of its own.

test('a request token cap wins over the manifest (both set)', () => {
  const eff = resolveHireDefaults({ tokenCap: 250000 }, { tokenCap: 4000000 });
  assert.equal(eff.tokenCap, 250000, 'the request states a ceiling; the manifest is only a default');
});

test('the manifest token cap applies when the request omits it', () => {
  // THE BUG. Before the fix this resolved to undefined and the worker ran uncapped.
  const eff = resolveHireDefaults({}, { tokenCap: 4000000 });
  assert.equal(eff.tokenCap, 4000000, 'a hire that declares a ceiling must never spawn uncapped');
});

test('a request token cap applies with no manifest at all', () => {
  const eff = resolveHireDefaults({ tokenCap: 250000 }, undefined);
  assert.equal(eff.tokenCap, 250000);
});

test('a non-positive or non-numeric request cap is not a stated choice', () => {
  // Same rule as the string fields: an unusable request value must fall back to
  // the manifest, not silently disable the hire's ceiling.
  for (const bad of [0, -1, NaN, Infinity, '4000000', null, true]) {
    assert.equal(resolveHireDefaults({ tokenCap: bad }, { tokenCap: 4000000 }).tokenCap, 4000000,
      `tokenCap ${String(bad)} must fall through to the manifest`);
  }
});

test('with a cap nowhere, none is invented', () => {
  assert.equal(resolveHireDefaults({}, {}).tokenCap, undefined);
  assert.equal(resolveHireDefaults({}, undefined).tokenCap, undefined);
});

// ── tokenCap edge battery (T-062 QA) ────────────────────────────────────────
// `reqCap` is the only guard on the request side, so the exact boundary between
// "a stated ceiling" and "fall through to the manifest" is worth pinning value by
// value. Nothing here is shared with the implementation: these are literals, and
// resolveHireDefaults carries no cap constant of its own.

test('edge: every unusable request cap falls through to the manifest ceiling', () => {
  const unusable = [
    0, -0, -1, -4000000, NaN, Infinity, -Infinity,
    '4000000', '0', '', '   ',                 // numeric strings are not numbers
    null, undefined, true, false,
    [], [4000000],                             // arrays coerce to numbers elsewhere; not here
    {}, { valueOf: () => 4000000 },            // no valueOf coercion either
    Number('nope')
  ];
  for (const bad of unusable) {
    assert.equal(
      resolveHireDefaults({ tokenCap: bad }, { tokenCap: 4000000 }).tokenCap, 4000000,
      `tokenCap ${JSON.stringify(bad) ?? String(bad)} must fall through to the manifest, not cancel it`
    );
  }
});

test('edge: an unusable request cap with NO manifest leaves the worker uncapped', () => {
  // The mirror of the case above, and the one that actually spends money: with
  // nothing to fall back to, an unusable value must resolve to undefined rather
  // than to a bogus ceiling (0 would read as "unlimited" downstream anyway).
  for (const bad of [0, -1, NaN, Infinity, '4000000', null, true, {}]) {
    assert.equal(resolveHireDefaults({ tokenCap: bad }, undefined).tokenCap, undefined);
    assert.equal(resolveHireDefaults({ tokenCap: bad }, {}).tokenCap, undefined);
  }
});

test('edge: any positive finite number is a stated ceiling, integer or not', () => {
  // Deliberately pinning the CURRENT contract, including the odd corners: the
  // guard is `> 0 && Number.isFinite`, not `Number.isInteger`. If someone tightens
  // it to integers-only, this test is the one that has to be argued with first.
  for (const good of [1, 0.5, 1e-6, 250000, Number.MAX_SAFE_INTEGER, MAX_AGENT_TOKEN_CAP]) {
    assert.equal(resolveHireDefaults({ tokenCap: good }, { tokenCap: 4000000 }).tokenCap, good,
      `${good} is a positive finite number and must win over the manifest`);
  }
});

test('edge: a malformed manifest cap never reaches resolveHireDefaults — validateHireManifest rejects it', () => {
  // resolveHireDefaults trusts `manifest.tokenCap` unchecked, which is only safe
  // because the manifest was validated on the way in. That guard is load-bearing
  // for the whole fix, so it is asserted here rather than assumed.
  // spec id DERIVED from the module, never a copied literal.
  const base = { spec: HIRE_SPEC_V1, name: 'n', description: 'd', goal: 'g' };
  for (const bad of [0, -1, 1.5, NaN, Infinity, '4000000', null, true, MAX_AGENT_TOKEN_CAP + 1]) {
    const res = validateHireManifest({ ...base, tokenCap: bad });
    assert.equal(res.ok, false, `manifest tokenCap ${String(bad)} must be rejected`);
    assert.ok(res.errors.some((e) => /tokenCap/.test(e)), `rejection must name tokenCap (got ${res.errors})`);
  }
  const good = validateHireManifest({ ...base, tokenCap: 4000000 });
  assert.equal(good.ok, true, `a well-formed cap must survive (got ${good.errors})`);
  assert.equal(good.manifest.tokenCap, 4000000);
});


// ── call site: SOURCE ASSERTION, NOT AN EXECUTION TEST ──────────────────────
// index.ts imports electron, so processSpawnRequest cannot be loaded or run in
// process, and reimplementing the call site in a test has shipped real defects
// here. So this inspects the real file — but through the TypeScript AST, the way
// renderer-sandbox.test.cjs pins the Electron sandbox flag, NOT through a regex
// over raw text.
//
// The regex version this replaces could not fail: commenting out the production
// line at index.ts:4691 left all 18 tests green, because `assert.match` happily
// matched the commented-out copy. It could also fire on a NON-regression, because
// `assert.doesNotMatch(block, /raw\.tokenCap/)` would trip on the words appearing
// in a comment. An AST carries no comments, so both failure modes are gone.
//
// WHAT THIS PROVES: in the live (non-commented) source of processSpawnRequest,
// `tokenCap` is bound from `eff.tokenCap` and that binding is what gets handed to
// liveWorkers.set, and nothing in that function reads `raw.tokenCap`.
// WHAT THIS DOES NOT PROVE: that the spawn path actually runs, that the value
// reaches the reaper at index.ts:4830, or that `eff` is the resolveHireDefaults
// result. Those need the electron-free integration this file cannot have. The
// behaviour of resolveHireDefaults itself is covered by the real tests above.

const INDEX_TS = path.join(__dirname, '..', 'src', 'main', 'index.ts');

/** Every descendant of `node` (inclusive) matching `predicate`. */
function collect(node, predicate) {
  const out = [];
  (function walk(n) {
    if (predicate(n)) out.push(n);
    ts.forEachChild(n, walk);
  })(node);
  return out;
}

/**
 * Parse `text` as TypeScript and report the shape of the token-cap wiring inside
 * `processSpawnRequest`. Pure analysis over an AST, so comments are invisible to
 * it by construction. Takes text (not a path) so the meta-tests below can prove
 * it actually bites without touching the real file.
 */
function analyseSpawnCallSite(text) {
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const fns = collect(source, (n) =>
    (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
    && ((n.name && ts.isIdentifier(n.name) && n.name.text === 'processSpawnRequest')
      || (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)
        && n.parent.name.text === 'processSpawnRequest')));
  if (fns.length !== 1) return { fnCount: fns.length };
  const fn = fns[0];

  const decls = collect(fn, (n) =>
    ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'tokenCap');

  // Live reads of `raw.tokenCap` — a mention inside a comment is not a node.
  const rawReads = collect(fn, (n) =>
    ts.isPropertyAccessExpression(n)
    && ts.isIdentifier(n.expression) && n.expression.text === 'raw'
    && n.name.text === 'tokenCap');

  // The registration call and how it names the cap.
  const registrations = collect(fn, (n) =>
    ts.isCallExpression(n) && n.expression.getText(source) === 'liveWorkers.set');
  const capProps = registrations.flatMap((call) => {
    const arg = call.arguments[1];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return [];
    return arg.properties.filter((p) =>
      p.name && ts.isIdentifier(p.name) && p.name.text === 'tokenCap');
  });

  return {
    fnCount: fns.length,
    declCount: decls.length,
    declInitializer: decls.length === 1 && decls[0].initializer
      ? decls[0].initializer.getText(source) : undefined,
    rawReadCount: rawReads.length,
    registrationCount: registrations.length,
    capPropCount: capProps.length,
    // Shorthand `{ tokenCap }` means the local binding above; a longhand
    // `{ tokenCap: X }` is recorded so a swap to something else is visible.
    capPropSource: capProps.length === 1
      ? (ts.isShorthandPropertyAssignment(capProps[0]) ? 'tokenCap' : capProps[0].initializer.getText(source))
      : undefined
  };
}

test('call site (AST source assertion, not an execution test): processSpawnRequest binds tokenCap from eff and registers that binding', () => {
  const shape = analyseSpawnCallSite(readFileSync(INDEX_TS, 'utf8'));

  assert.equal(shape.fnCount, 1, 'exactly one processSpawnRequest must exist in index.ts');
  assert.equal(shape.declCount, 1,
    'processSpawnRequest must contain exactly one LIVE `tokenCap` binding — zero means the line was commented out or deleted');
  assert.equal(shape.declInitializer, 'eff.tokenCap',
    'the cap must be read from the resolved defaults, so a manifest ceiling is honoured (T-062)');
  assert.equal(shape.rawReadCount, 0,
    'reading `raw.tokenCap` is what let a hire spawn uncapped when the request omitted a cap');
  assert.equal(shape.registrationCount, 1, 'exactly one liveWorkers.set registration');
  assert.equal(shape.capPropCount, 1, 'the registration must carry a tokenCap property');
  assert.equal(shape.capPropSource, 'tokenCap',
    'the registration must pass the resolved binding, not some other expression');
});

// The meta-tests: proof that the assertion above can actually fail, and that it
// does not fire on a non-regression. Synthetic sources — they do NOT reimplement
// the call site, they exercise the analyser that inspects it.

test('call-site analyser bites: a commented-out binding reports zero live declarations', () => {
  const shape = analyseSpawnCallSite(`
    async function processSpawnRequest(f: string) {
      // const tokenCap = eff.tokenCap;
      liveWorkers.set(workerId, { workerId, tokenCap });
    }`);
  assert.equal(shape.declCount, 0, 'a commented-out binding must not count as live code');
});

test('call-site analyser bites: a binding moved back to raw.tokenCap is reported', () => {
  const shape = analyseSpawnCallSite(`
    async function processSpawnRequest(f: string) {
      const tokenCap = raw.tokenCap;
      liveWorkers.set(workerId, { workerId, tokenCap });
    }`);
  assert.equal(shape.declInitializer, 'raw.tokenCap');
  assert.equal(shape.rawReadCount, 1);
});

test('call-site analyser does not false-fire: raw.tokenCap named only in a comment is not a read', () => {
  // The mirror-image failure of the regex it replaces, which would have gone RED
  // on this file even though the code is correct.
  const shape = analyseSpawnCallSite(`
    async function processSpawnRequest(f: string) {
      // NOTE: this used to be raw.tokenCap, which was the bug.
      const tokenCap = eff.tokenCap;
      liveWorkers.set(workerId, { workerId, tokenCap });
    }`);
  assert.equal(shape.rawReadCount, 0, 'a comment mentioning raw.tokenCap is not a read');
  assert.equal(shape.declInitializer, 'eff.tokenCap');
  assert.equal(shape.capPropSource, 'tokenCap');
});

test('call-site analyser bites: registering a different expression is reported', () => {
  const shape = analyseSpawnCallSite(`
    async function processSpawnRequest(f: string) {
      const tokenCap = eff.tokenCap;
      liveWorkers.set(workerId, { workerId, tokenCap: raw.tokenCap });
    }`);
  assert.equal(shape.capPropSource, 'raw.tokenCap', 'a longhand override must be visible, not hidden by the live binding');
  assert.equal(shape.rawReadCount, 1);
});
