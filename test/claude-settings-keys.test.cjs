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

test('every table entry has a class and a type, and an enum its values', () => {
  for (const [key, e] of Object.entries(CLAUDE_SETTINGS_KEYS)) {
    assert.ok(['restrictive', 'judged', 'refused'].includes(e.cls), key);
    assert.ok(['object', 'boolean', 'strings', 'string', 'enum', 'array', 'stringListMap', 'any'].includes(e.type), key);
    if (e.type === 'enum') assert.ok(Array.isArray(e.values) && e.values.length > 0, key);
    if (e.cls !== 'restrictive') assert.ok(typeof e.why === 'string' && e.why.length > 0, key);
  }
});

// A minified schema of the CLI's shape: lazily built sub-schemas, inline sub-objects, describe() text holding
// commas, braces and quotes, and a runtime object with the same key names that is not a schema.
const NET = 'Ja=p(()=>u({allowedDomains:P(o()).optional().describe("Domains, e.g. {a,b}"),deniedDomains:P(o()).optional(),tlsTerminate:u({caCertPath:o().optional(),caKeyPath:o().optional()}).optional()}))';
const FS = 'Za=p(()=>u({allowWrite:P(o()).optional(),denyRead:P(o()).optional().describe(`x ${"}"} y`),allowManagedReadPathsOnly:M().optional()}))';
const CRED = 'el=p(()=>u({files:P(Ct()).optional(),envVars:P(kt()).optional(),allowPlaintextInject:M().optional()}))';
const SANDBOX = 'DGo=p(()=>u({enabled:M().optional().describe("Run, \'quoted\'"),failIfUnavailable:M().optional(),network:Ja(),filesystem:Za(),credentials:el(),excludedCommands:P(o()).optional(),ripgrep:u({command:o(),args:P(o()).optional()}).optional()}))';
const PERMS = 'function nr(e){return u({allow:P(Hs()).optional(),deny:P(_n()).optional(),defaultMode:U(["a"]).optional(),blockWritesOutsideWorkingDirectories:M().optional(),additionalDirectories:P(o()).optional()}).passthrough()}';
const RUNTIME = 'let Gc={allowedDomains:re,deniedDomains:ce,strictAllowlist:L||void 0}';
const SCHEMA = [NET, FS, CRED, SANDBOX, PERMS, RUNTIME].join(';');

test('the reader lists the schema\'s key paths, following inline sub-objects and skipping runtime objects', () => {
  assert.deepEqual(settingsKeyPaths(SCHEMA).paths, [
    'permissions', 'permissions.additionalDirectories', 'permissions.allow', 'permissions.blockWritesOutsideWorkingDirectories',
    'permissions.defaultMode', 'permissions.deny',
    'sandbox', 'sandbox.credentials', 'sandbox.credentials.allowPlaintextInject', 'sandbox.credentials.envVars', 'sandbox.credentials.files',
    'sandbox.enabled', 'sandbox.excludedCommands', 'sandbox.failIfUnavailable',
    'sandbox.filesystem', 'sandbox.filesystem.allowManagedReadPathsOnly', 'sandbox.filesystem.allowWrite', 'sandbox.filesystem.denyRead',
    'sandbox.network', 'sandbox.network.allowedDomains', 'sandbox.network.deniedDomains',
    'sandbox.network.tlsTerminate', 'sandbox.network.tlsTerminate.caCertPath', 'sandbox.network.tlsTerminate.caKeyPath',
    'sandbox.ripgrep', 'sandbox.ripgrep.args', 'sandbox.ripgrep.command',
  ]);
});

test('the reader refuses to guess: a missing schema object, or copies that disagree, is an error', () => {
  assert.match(settingsKeyPaths(SCHEMA.replace(PERMS, '')).error, /permissions/);
  const other = FS.replace('Za=', 'Zb=').replace('denyRead:', 'denyReadX:P(o()).optional(),denyRead:');
  assert.match(settingsKeyPaths(`${SCHEMA};${other}`).error, /sandbox\.filesystem/);
  assert.equal(settingsKeyPaths(`${SCHEMA};${FS}`).error, undefined, 'an identical copy is fine');
});
