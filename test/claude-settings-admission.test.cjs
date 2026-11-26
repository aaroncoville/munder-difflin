'use strict';
// The strict judgement of an owner's merged Claude settings (claudeSettingsAdmission.ts, strict: true): every key under
// `sandbox` and `permissions` must be one the check understands, with the type it expects, and none may widen what the
// seat can write, read or run beyond its own roots. An unknown key, a wrong type, or a widening value refuses, naming
// the key path. Keys outside those two subtrees are not judged here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { claudeSettingsExcess } = loadTs('src/core/claudeSettingsAdmission.ts');

function floor(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdcsa-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const seat = path.join(base, 'seat');
  const work = path.join(base, 'work');
  fs.mkdirSync(seat);
  fs.mkdirSync(work);
  const managedFile = path.join(base, 'managed', 'managed-settings.json');
  fs.mkdirSync(path.dirname(managedFile));
  const judge = (settings) => {
    fs.writeFileSync(managedFile, JSON.stringify(settings));
    return claudeSettingsExcess({ managedFile, userDir: null, allowed: [seat, work], cwd: work, home: base, strict: true });
  };
  return { base, seat, work, judge };
}

test('strict: a setting that widens the seat is refused, naming its key path', (t) => {
  const f = floor(t);
  const out = path.join(f.base, 'elsewhere');
  const cases = [
    [{ sandbox: { enabled: false } }, 'sandbox.enabled'],
    [{ sandbox: { failIfUnavailable: false } }, 'sandbox.failIfUnavailable'],
    [{ sandbox: { allowUnsandboxedCommands: true } }, 'sandbox.allowUnsandboxedCommands'],
    [{ sandbox: { enableWeakerNestedSandbox: true } }, 'sandbox.enableWeakerNestedSandbox'],
    [{ sandbox: { excludedCommands: ['cp *'] } }, 'sandbox.excludedCommands'],
    [{ sandbox: { filesystem: { disabled: true } } }, 'sandbox.filesystem.disabled'],
    [{ sandbox: { filesystem: { allowWrite: [out] } } }, 'sandbox.filesystem.allowWrite'],
    [{ permissions: { additionalDirectories: [out] } }, 'permissions.additionalDirectories'],
    [{ permissions: { defaultMode: 'bypassPermissions' } }, 'permissions.defaultMode'],
    [{ permissions: { defaultMode: 'auto' } }, 'permissions.defaultMode'],
    // Listed by hand, not imported: a write tool dropped from the module's list must fail here.
    ...['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].flatMap((tool) => [
      [{ permissions: { allow: [`${tool}(/${out}/**)`] } }, `permissions.allow ${tool}`],
      [{ permissions: { allow: [tool] } }, `permissions.allow ${tool}`],
    ]),
  ];
  for (const [settings, key] of cases) {
    const r = f.judge(settings);
    assert.ok(r, `${JSON.stringify(settings)} was admitted`);
    assert.ok(r.why.includes(`managed settings: ${key}`), `${JSON.stringify(settings)}: ${r.why}`);
  }
});

test('strict: an unknown key or a wrong type under sandbox or permissions is refused, naming its key path', (t) => {
  const f = floor(t);
  const cases = [
    [{ sandbox: { somethingNew: true } }, 'sandbox.somethingNew'],
    [{ sandbox: { filesystem: { allowRead: ['/'] } } }, 'sandbox.filesystem.allowRead'],
    [{ sandbox: { network: { allowUnixSockets: ['/var/run/docker.sock'] } } }, 'sandbox.network.allowUnixSockets'],
    [{ permissions: { somethingNew: [] } }, 'permissions.somethingNew'],
    [{ sandbox: 'on' }, 'sandbox'],
    [{ sandbox: { enabled: 'false' } }, 'sandbox.enabled'],
    [{ sandbox: { filesystem: { disabled: 1 } } }, 'sandbox.filesystem.disabled'],
    [{ permissions: { allow: ['Read', 5] } }, 'permissions.allow'],
    [{ permissions: { deny: 'Bash' } }, 'permissions.deny'],
    [{ permissions: { ask: [null] } }, 'permissions.ask'],
    [{ permissions: { defaultMode: 3 } }, 'permissions.defaultMode'],
    [{ permissions: { disableBypassPermissionsMode: 'enable' } }, 'permissions.disableBypassPermissionsMode'],
  ];
  for (const [settings, key] of cases) {
    const r = f.judge(settings);
    assert.ok(r, `${JSON.stringify(settings)} was admitted`);
    assert.ok(r.why.includes(`managed settings: ${key}`), `${JSON.stringify(settings)}: ${r.why}`);
  }
});

test('strict: settings that keep the seat within its roots are admitted', (t) => {
  const f = floor(t);
  const admitted = [
    {},
    { model: 'haiku', hooks: {} },
    { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, enableWeakerNestedSandbox: false } },
    { sandbox: { excludedCommands: ['npm run build', 'git fetch *'] } },
    { sandbox: { filesystem: { disabled: false, allowWrite: [path.join(f.seat, 'x')], denyWrite: ['/etc'], denyRead: ['~/.ssh'] } } },
    { sandbox: { network: { allowedDomains: ['example.com'], allowLocalBinding: false } } },
    { permissions: { allow: ['Bash', 'Read', 'WebFetch', `Edit(/${f.work}/**)`, `Write(/${f.seat}/**)`], ask: ['Bash(git push:*)'], deny: ['Read(~/.ssh/**)'] } },
    { permissions: { additionalDirectories: [f.work], disableBypassPermissionsMode: 'disable' } },
    ...['default', 'manual', 'acceptEdits', 'plan', 'dontAsk'].map((defaultMode) => ({ permissions: { defaultMode } })),
  ];
  for (const settings of admitted) assert.equal(f.judge(settings), null, JSON.stringify(settings));
});

test('strict: a file-writing tool rule is read whatever the case of its tool name', (t) => {
  const f = floor(t);
  const out = path.join(f.base, 'elsewhere');
  for (const tool of ['edit', 'WRITE', 'multiedit', 'notebookedit', 'NotebookEDIT']) {
    for (const rule of [`${tool}(/${out}/**)`, tool]) {
      const r = f.judge({ permissions: { allow: [rule] } });
      assert.ok(r && /managed settings: permissions\.allow /.test(r.why), `${rule} was admitted`);
    }
  }
  assert.equal(f.judge({ permissions: { allow: [`write(/${f.work}/**)`] } }), null, 'a rule inside the roots is still admitted');
});

test('the root reader lists a file-writing tool rule whatever the case of its tool name', () => {
  const { claudeRootEntries } = loadTs('src/core/launchLine.ts');
  const rules = ['edit(//x/**)', 'WRITE', 'MultiEdit(//y)', 'notebookedit', 'Read(//z)', 'Editor(//w)'];
  assert.deepEqual(claudeRootEntries(JSON.stringify({ permissions: { allow: rules } })).editRules, ['edit(//x/**)', 'WRITE', 'MultiEdit(//y)', 'notebookedit']);
});

test('strict: a file-writing tool rule whose path has a variable, a backtick or another user\'s home is refused, as a root list entry is', (t) => {
  const f = floor(t);
  for (const spec of ['$HOME/**', '${HOME}/x', '%USERPROFILE%/x', 'a`id`/x', '~root/**', '~other', 'sub/$X']) {
    for (const tool of ['Edit', 'Write']) {
      const r = f.judge({ permissions: { allow: [`${tool}(${spec})`] } });
      assert.ok(r && r.why.includes(`managed settings: permissions.allow ${tool}`), `${tool}(${spec}) was admitted`);
    }
  }
  assert.equal(f.judge({ permissions: { allow: ['Edit(sub/com~apple~x/**)'] } }), null, 'a ~ inside a name is just a name');
});

test('strict: the restrictive keys of the pinned CLI are admitted with any well-typed value', (t) => {
  const f = floor(t);
  const admitted = [
    { sandbox: { network: { deniedDomains: ['evil.example'], allowManagedDomainsOnly: true, strictAllowlist: true } } },
    { sandbox: { filesystem: { allowManagedReadPathsOnly: true, allowRead: [] } } },
    { sandbox: { filesystem: { denyRead: ['/'], allowRead: [path.join(f.work, 'docs')] } } },
    { permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true, denyInsteadOfPrompting: true, disableAutoMode: 'disable', workingDirectoriesExclude: ['/x'] } },
    { sandbox: { credentials: { files: [{ path: '~/.aws', mode: 'deny' }], envVars: [{ name: 'GH_TOKEN', mode: 'deny' }] }, ignoreViolations: { '*': ['/tmp'] }, windows: { backend: 'sandboxuser' } } },
  ];
  for (const settings of admitted) assert.equal(f.judge(settings), null, JSON.stringify(settings));
});

test('strict: the pinned CLI\'s widening keys are refused, naming the key path', (t) => {
  const f = floor(t);
  const cases = [
    [{ sandbox: { allowAppleEvents: true } }, 'sandbox.allowAppleEvents'],
    [{ sandbox: { allowNestedUserNamespaces: true } }, 'sandbox.allowNestedUserNamespaces'],
    [{ sandbox: { enableWeakerNetworkIsolation: true } }, 'sandbox.enableWeakerNetworkIsolation'],
    [{ sandbox: { filesystem: { allowRead: ['/etc'] } } }, 'sandbox.filesystem.allowRead'],
    [{ sandbox: { network: { allowMachLookup: ['com.apple.*'] } } }, 'sandbox.network.allowMachLookup'],
    [{ sandbox: { network: { allowAllUnixSockets: true } } }, 'sandbox.network.allowAllUnixSockets'],
    [{ sandbox: { network: { httpProxyPort: 8080 } } }, 'sandbox.network.httpProxyPort'],
    [{ sandbox: { ripgrep: { command: '/bin/sh' } } }, 'sandbox.ripgrep'],
    [{ sandbox: { credentials: { allowPlaintextInject: true } } }, 'sandbox.credentials.allowPlaintextInject'],
    [{ sandbox: { windows: { backend: 'none' } } }, 'sandbox.windows.backend'],
    [{ permissions: { disableAutoMode: 'enable' } }, 'permissions.disableAutoMode'],
  ];
  for (const [settings, key] of cases) {
    const r = f.judge(settings);
    assert.ok(r && r.why.includes(`managed settings: ${key}`), `${JSON.stringify(settings)}: ${r && r.why}`);
  }
});

test('strict: a key the table does not have is refused as unknown to the table for its CLI version', (t) => {
  const f = floor(t);
  const { CLAUDE_SETTINGS_CLI } = loadTs('src/core/claudeSettingsKeys.ts');
  for (const [settings, key] of [[{ sandbox: { somethingNew: true } }, 'sandbox.somethingNew'], [{ permissions: { network: {} } }, 'permissions.network'], [{ sandbox: { network: { tlsTerminate2: {} } } }, 'sandbox.network.tlsTerminate2']]) {
    const r = f.judge(settings);
    assert.ok(r && r.why.includes(`managed settings: ${key} (unknown to this build's settings table for CLI ${CLAUDE_SETTINGS_CLI})`), r && r.why);
  }
});

test('every judged key in the table that is not an object has a judgement', () => {
  const { CLAUDE_SETTINGS_KEYS } = loadTs('src/core/claudeSettingsKeys.ts');
  const { JUDGED_SETTINGS_KEYS } = loadTs('src/core/claudeSettingsAdmission.ts');
  const want = Object.entries(CLAUDE_SETTINGS_KEYS).filter(([, e]) => e.cls === 'judged' && e.type !== 'object').map(([k]) => k).sort();
  assert.deepEqual([...JUDGED_SETTINGS_KEYS].sort(), want);
});

test('strict: an allowedDomains entry made only of wildcards and dots is refused; a wildcard under a named domain is admitted', (t) => {
  const f = floor(t);
  for (const entry of ['*', '*.*', '**', '.*', '*.']) {
    const r = f.judge({ sandbox: { network: { allowedDomains: ['example.com', entry] } } });
    assert.ok(r && r.why.includes('managed settings: sandbox.network.allowedDomains'), `${entry} was admitted`);
  }
  assert.equal(f.judge({ sandbox: { network: { allowedDomains: ['*.example.com', 'api.example.org'] } } }), null);
});

test('strict: a credential entry that masks rather than denies is refused: the proxy would inject the real value', (t) => {
  const f = floor(t);
  for (const [credentials, key] of [
    [{ files: [{ path: '~/.aws/credentials', mode: 'deny' }, { path: '~/.netrc', mode: 'mask' }] }, 'sandbox.credentials.files'],
    [{ envVars: [{ name: 'GH_TOKEN', mode: 'mask' }] }, 'sandbox.credentials.envVars'],
    [{ files: ['~/.aws'] }, 'sandbox.credentials.files'],
  ]) {
    const r = f.judge({ sandbox: { credentials } });
    assert.ok(r && r.why.includes(`managed settings: ${key}`), `${JSON.stringify(credentials)}: ${r && r.why}`);
  }
});
