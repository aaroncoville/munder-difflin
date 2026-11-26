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
    { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, enableWeakerNestedSandbox: false } },
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
