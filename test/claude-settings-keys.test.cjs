'use strict';
// The settings-key table (src/core/claudeSettingsKeys.ts) classifies exactly the keys the pinned Claude Code accepts
// under sandbox and permissions, as read from its schema by tools/claude-settings-keys.cjs and kept in
// tools/claude-settings-keys.json: a key the CLI accepts cannot ship unclassified, and the table names no key the CLI
// does not have. The reader itself is checked on a minified schema of the same shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { CLAUDE_SETTINGS_CLI, CLAUDE_SETTINGS_KEYS } = loadTs('src/core/claudeSettingsKeys.ts');
const fixture = require('../tools/claude-settings-keys.json');
const { settingsKeyPaths } = require('../tools/claude-settings-keys.cjs');

test('the table classifies exactly the keys read from the CLI it names', () => {
  assert.equal(fixture.cli, CLAUDE_SETTINGS_CLI);
  assert.deepEqual(Object.keys(CLAUDE_SETTINGS_KEYS).sort(), [...fixture.paths].sort());
});

test('every table entry has a class, a type, a reason, and an enum its values', () => {
  for (const [key, e] of Object.entries(CLAUDE_SETTINGS_KEYS)) {
    assert.ok(['restrictive', 'judged', 'refused'].includes(e.cls), key);
    assert.ok(['object', 'boolean', 'strings', 'string', 'enum', 'array', 'stringListMap', 'any'].includes(e.type), key);
    if (e.type === 'enum') assert.ok(Array.isArray(e.values) && e.values.length > 0, key);
    assert.ok(typeof e.why === 'string' && e.why.length > 0, `${key} has no reason`);
  }
});

// A minified schema of the CLI's shape: one bundled module (`// @bun`) that imports the zod builders from another
// chunk and builds the settings schema from them, with lazily built sub-schemas referred to by name (one of them a
// block that names a local variable), inline sub-objects, describe() text holding commas, braces and quotes, array
// elements built elsewhere, and a runtime object with the same key names that is not a schema.
const HEAD = '// @bun @bytecode\n// Version: 9.9.9\nimport{x}from"/$bunfs/root/chunk-other.js";import{o,v,M,O,U,P,Te,u,Bc}from"/$bunfs/root/chunk-zod.js";';
const SIGV4 = 'Qa=p(()=>{let e=U(["deny","passthrough"]);return u({streaming:e.optional(),presigned:e.optional()})})';
const NET = 'Ja=p(()=>u({allowedDomains:P(o()).optional().describe("Domains, e.g. {a,b}"),deniedDomains:P(o()).optional(),tlsTerminate:u({caCertPath:o().optional(),caKeyPath:o().optional()}).optional()}))';
const FS = 'Za=p(()=>u({allowWrite:P(o()).optional(),denyRead:P(o()).optional().describe(`x ${"}"} y`),allowManagedReadPathsOnly:M().optional()}))';
const ITEM = 'Ct=p(()=>Bc(Ko,u({path:o().min(1),mode:U(["deny","mask"])})))';
const CRED = 'el=p(()=>u({files:P(Ct()).optional(),allowPlaintextInject:M().optional(),sigv4:Qa().optional().describe("policies")}))';
const SANDBOX = 'DGo=p(()=>u({enabled:M().optional().describe("Run, \'quoted\'"),failIfUnavailable:M().optional(),network:Ja(),filesystem:Za(),credentials:el(),excludedCommands:P(o()).optional(),ripgrep:u({command:o(),args:P(o()).optional()}).optional()}))';
const PERMS = 'function nr(e){return u({allow:P(Hs()).optional(),deny:P(_n()).optional(),defaultMode:U(["a"]).optional(),blockWritesOutsideWorkingDirectories:M().optional(),additionalDirectories:P(o()).optional()}).passthrough()}';
const RUNTIME = 'let Gc={allowedDomains:re,deniedDomains:ce,strictAllowlist:L||void 0};function zz(){let e=1;return e}';
const bundle = (...parts) => `${HEAD}${parts.join(';')};\n// @bun\nvar next=1;`;
const SCHEMA = bundle(SIGV4, NET, FS, ITEM, CRED, SANDBOX, PERMS, RUNTIME);
const BASE_PATHS = [
  'permissions', 'permissions.additionalDirectories', 'permissions.allow', 'permissions.blockWritesOutsideWorkingDirectories',
  'permissions.defaultMode', 'permissions.deny',
  'sandbox', 'sandbox.credentials', 'sandbox.credentials.allowPlaintextInject', 'sandbox.credentials.files',
  'sandbox.credentials.sigv4', 'sandbox.credentials.sigv4.presigned', 'sandbox.credentials.sigv4.streaming',
  'sandbox.enabled', 'sandbox.excludedCommands', 'sandbox.failIfUnavailable',
  'sandbox.filesystem', 'sandbox.filesystem.allowManagedReadPathsOnly', 'sandbox.filesystem.allowWrite', 'sandbox.filesystem.denyRead',
  'sandbox.network', 'sandbox.network.allowedDomains', 'sandbox.network.deniedDomains',
  'sandbox.network.tlsTerminate', 'sandbox.network.tlsTerminate.caCertPath', 'sandbox.network.tlsTerminate.caKeyPath',
  'sandbox.ripgrep', 'sandbox.ripgrep.args', 'sandbox.ripgrep.command',
];

test('the reader lists the schema\'s key paths, following inline sub-objects and sub-schemas built elsewhere, and skipping runtime objects', () => {
  assert.deepEqual(settingsKeyPaths(SCHEMA).paths, BASE_PATHS);
});

test('a key added to a sub-schema built elsewhere changes the list', () => {
  const more = SIGV4.replace('presigned:e.optional()', 'presigned:e.optional(),sigv4a:e.optional()');
  const got = settingsKeyPaths(bundle(more, NET, FS, ITEM, CRED, SANDBOX, PERMS)).paths;
  assert.ok(got.includes('sandbox.credentials.sigv4.sigv4a'), JSON.stringify(got));
});

test('a spread of another schema object and a quoted key are read as keys', () => {
  const extra = 'Wx=p(()=>u({fromSpread:M().optional()}))';
  const fs2 = FS.replace('allowWrite:', '...Wx().shape,"quoted-key":M().optional(),allowWrite:');
  const got = settingsKeyPaths(bundle(extra, SIGV4, NET, fs2, ITEM, CRED, SANDBOX, PERMS)).paths;
  assert.ok(got.includes('sandbox.filesystem.fromSpread'), JSON.stringify(got));
  assert.ok(got.includes('sandbox.filesystem.quoted-key'), JSON.stringify(got));
});

test('the reader refuses to guess: anything in a schema object it cannot resolve is an error', () => {
  for (const [what, text] of [
    ['a missing schema object', bundle(SIGV4, NET, FS, ITEM, CRED, SANDBOX)],
    ['a reference to nothing in the module', bundle(NET, FS, ITEM, CRED, SANDBOX, PERMS)],
    ['a spread of nothing in the module', bundle(SIGV4, NET, FS.replace('allowWrite:', '...Nope.shape,allowWrite:'), ITEM, CRED, SANDBOX, PERMS)],
    ['a shorthand property', bundle(SIGV4, NET, FS.replace('allowWrite:', 'shorty,allowWrite:'), ITEM, CRED, SANDBOX, PERMS)],
    ['a call to a local function', bundle(SIGV4, NET, FS.replace('allowWrite:P(o())', 'allowWrite:mk(1)'), ITEM, CRED, SANDBOX, PERMS)],
    ['an unknown local variable', bundle(SIGV4.replace('let e=', 'let f='), NET, FS, ITEM, CRED, SANDBOX, PERMS)],
    ['an imported builder call holding an object schema', bundle(SIGV4, NET, FS.replace('allowWrite:', 'wrapped:Te([u({deep:M()})]).optional(),allowWrite:'), ITEM, CRED, SANDBOX, PERMS)],
  ]) assert.ok(settingsKeyPaths(text).error, `${what} was not an error`);
});
