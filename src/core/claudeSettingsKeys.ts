/**
 * Every key Claude Code accepts under `sandbox` and `permissions` in a settings file, for the CLI version below, and how
 * the strict owner-settings check (claudeSettingsAdmission.ts) treats each.
 *
 * The list is read from the CLI's own settings schema by tools/claude-settings-keys.cjs; the list it printed is kept in
 * tools/claude-settings-keys.json, a test holds this table to exactly that list, and the upgrade canary fails when an
 * installed CLI's list differs. A key that is not here is refused as unknown to this table.
 *
 * Classes:
 *  - restrictive: no well-typed value widens what a seat can write, read or run. The key only narrows (a deny list,
 *    a block switch), or leaves confinement as it is (approval or reporting only). Any well-typed value is admitted.
 *  - judged: some values widen the seat, and only the others are admitted (claudeSettingsAdmission.ts strictExcess).
 *  - refused: refused whatever its value. Either every value can widen the seat (another proxy, another binary run
 *    outside the sandbox), or what it does is not modelled closely enough to admit any value.
 */

/** The Claude Code version the table was read from. */
export const CLAUDE_SETTINGS_CLI = '2.1.332';

export type SettingsKeyClass = 'restrictive' | 'judged' | 'refused';
/** The type a value must have: an object, a boolean, a list of text, text, one of `values`, a list of anything, or a
 *  map of text to lists of text. */
export type SettingsKeyType = 'object' | 'boolean' | 'strings' | 'string' | 'enum' | 'array' | 'stringListMap' | 'any';

export interface SettingsKey {
  cls: SettingsKeyClass;
  type: SettingsKeyType;
  /** The values an enum takes. */
  values?: readonly string[];
  /** Why it is in its class: what no value of a restrictive key can do, or what a judged or refused key's values can. */
  why: string;
}

const r = (type: SettingsKeyType, why: string, values?: readonly string[]): SettingsKey => ({ cls: 'restrictive', type, why, ...(values ? { values } : {}) });
const j = (type: SettingsKeyType, why: string): SettingsKey => ({ cls: 'judged', type, why });
const x = (why: string): SettingsKey => ({ cls: 'refused', type: 'any', why });

export const CLAUDE_SETTINGS_KEYS: Readonly<Record<string, SettingsKey>> = {
  permissions: j('object', 'its keys are judged one by one'),
  'permissions.additionalDirectories': j('strings', 'each directory widens the file tools; it must be inside the seat\'s roots'),
  'permissions.allow': j('strings', 'a file-writing tool\'s rule must be inside the seat\'s roots; other rules leave the sandbox and roots as they are'),
  'permissions.ask': r('strings', 'an ask rule only adds a prompt'),
  'permissions.blockFileToolReadsOutsideWorkingDirectories': r('boolean', 'it only refuses reads, and the CLI reads it from --settings alone'),
  'permissions.blockReadsExemptPaths': r('strings', 'it allows nothing, only exempts from a block the seat does not set, and the CLI reads it from --settings alone'),
  'permissions.blockReadsOutsideWorkingDirectories': r('boolean', 'it only refuses file-tool reads outside the working directories'),
  'permissions.blockWritesOutsideWorkingDirectories': r('boolean', 'it only refuses file-tool writes outside the working directories'),
  'permissions.defaultMode': j('string', 'bypassPermissions and auto approve without the rules; only the asking modes are admitted'),
  'permissions.deny': r('strings', 'a deny rule only refuses'),
  'permissions.denyInsteadOfPrompting': r('boolean', 'it turns a prompt into a refusal and allows nothing'),
  'permissions.disableAutoMode': r('enum', 'its one value removes auto mode', ['disable']),
  'permissions.disableBypassPermissionsMode': r('enum', 'its one value removes bypass mode', ['disable']),
  'permissions.workingDirectoriesAsGiven': r('strings', 'it only stops links being followed, and the CLI reads it from --settings alone'),
  'permissions.workingDirectoriesExclude': r('strings', 'it only counts paths as outside the working directories'),
  sandbox: j('object', 'its keys are judged one by one'),
  'sandbox.allowAppleEvents': j('boolean', 'true lets sandboxed commands launch applications outside the sandbox'),
  'sandbox.allowNestedUserNamespaces': j('boolean', 'true removes code-execution isolation'),
  'sandbox.allowUnsandboxedCommands': j('boolean', 'true reruns a failed command outside the sandbox'),
  'sandbox.autoAllowBashIfSandboxed': j('boolean', 'true approves sandboxed Bash without the permission flow; only the seat\'s pinned false is admitted'),
  'sandbox.bwrapPath': x('it names a binary the sandbox itself runs'),
  'sandbox.credentials': j('object', 'its keys are judged one by one'),
  'sandbox.credentials.allowPlaintextInject': j('boolean', 'true sends real credentials over plain HTTP'),
  'sandbox.credentials.awsPairs': r('array', 'it only groups masked variables, and a masked entry is refused'),
  'sandbox.credentials.envVars': j('array', 'a mask entry has the proxy inject the real value; only deny entries are admitted'),
  'sandbox.credentials.files': j('array', 'a mask entry has the proxy inject the real value; only deny entries are admitted'),
  'sandbox.credentials.sigv4': x('its passthrough policies are not modelled'),
  'sandbox.credentials.sigv4.presigned': x('its passthrough policies are not modelled'),
  'sandbox.credentials.sigv4.sigv4a': x('its passthrough policies are not modelled'),
  'sandbox.credentials.sigv4.streaming': x('its passthrough policies are not modelled'),
  'sandbox.enableWeakerNestedSandbox': j('boolean', 'true exposes the host /proc'),
  'sandbox.enableWeakerNetworkIsolation': j('boolean', 'true opens the trustd service to sandboxed commands'),
  'sandbox.enabled': j('boolean', 'false turns the sandbox off'),
  'sandbox.excludedCommands': j('strings', 'each entry runs outside the sandbox; only commands the scoped seat already runs unsandboxed are admitted'),
  'sandbox.failIfUnavailable': j('boolean', 'false lets the seat start without a sandbox'),
  'sandbox.filesystem': j('object', 'its keys are judged one by one'),
  'sandbox.filesystem.allowManagedReadPathsOnly': r('boolean', 'it only drops read re-allows from sources other than managed settings'),
  'sandbox.filesystem.allowRead': j('strings', 'each path re-allows reads; it must be inside the seat\'s roots'),
  'sandbox.filesystem.allowWrite': j('strings', 'each path allows writes; it must be inside the seat\'s roots'),
  'sandbox.filesystem.denyRead': r('strings', 'it only refuses reads'),
  'sandbox.filesystem.denyWrite': r('strings', 'it only refuses writes'),
  'sandbox.filesystem.disabled': j('boolean', 'true turns filesystem confinement off'),
  'sandbox.ignoreViolations': r('stringListMap', 'it only leaves violations unreported; they are still blocked'),
  'sandbox.network': j('object', 'its keys are judged one by one'),
  'sandbox.network.allowAllUnixSockets': j('boolean', 'true opens every Unix socket, a daemon\'s included'),
  'sandbox.network.allowLocalBinding': j('boolean', 'true lets sandboxed commands open localhost listeners; only the seat\'s pinned false is admitted'),
  'sandbox.network.allowMachLookup': j('strings', 'each service reached runs outside the sandbox; only an empty list is admitted'),
  'sandbox.network.allowManagedDomainsOnly': r('boolean', 'it only drops domain allows from sources other than managed settings'),
  'sandbox.network.allowUnixSockets': j('strings', 'a socket can reach a daemon outside the sandbox; only an empty list is admitted'),
  'sandbox.network.allowedDomains': j('strings', 'an entry that matches every domain is refused'),
  'sandbox.network.deniedDomains': r('strings', 'it only blocks domains'),
  'sandbox.network.httpProxyPort': x('it replaces the proxy that filters sandboxed traffic'),
  'sandbox.network.socksProxyPort': x('it replaces the proxy that filters sandboxed traffic'),
  'sandbox.network.strictAllowlist': r('boolean', 'true denies unlisted hosts instead of prompting; false is the default'),
  'sandbox.network.tlsTerminate': x('its certificate handling is not modelled'),
  'sandbox.network.tlsTerminate.caCertPath': x('its certificate handling is not modelled'),
  'sandbox.network.tlsTerminate.caKeyPath': x('its certificate handling is not modelled'),
  'sandbox.ripgrep': x('it names a binary run for the search tools, outside the sandbox'),
  'sandbox.ripgrep.args': x('it names a binary run for the search tools, outside the sandbox'),
  'sandbox.ripgrep.command': x('it names a binary run for the search tools, outside the sandbox'),
  'sandbox.socatPath': x('it names a binary the sandbox itself runs'),
  'sandbox.windows': j('object', 'its keys are judged one by one'),
  'sandbox.windows.backend': r('enum', 'both backends confine sandboxed commands', ['sandboxuser', 'mxc']),
};
