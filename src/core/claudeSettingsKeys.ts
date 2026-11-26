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
  /** Why it is judged or refused. */
  why?: string;
}

const r = (type: SettingsKeyType, values?: readonly string[]): SettingsKey => ({ cls: 'restrictive', type, ...(values ? { values } : {}) });
const j = (type: SettingsKeyType, why: string): SettingsKey => ({ cls: 'judged', type, why });
const x = (why: string): SettingsKey => ({ cls: 'refused', type: 'any', why });

export const CLAUDE_SETTINGS_KEYS: Readonly<Record<string, SettingsKey>> = {
  permissions: j('object', 'its keys are judged one by one'),
  'permissions.additionalDirectories': j('strings', 'each directory must be inside the seat\'s roots'),
  'permissions.allow': j('strings', 'a file-writing tool\'s rule must be inside the seat\'s roots'),
  'permissions.ask': r('strings'),
  'permissions.blockFileToolReadsOutsideWorkingDirectories': r('boolean'),
  'permissions.blockReadsExemptPaths': r('strings'),
  'permissions.blockReadsOutsideWorkingDirectories': r('boolean'),
  'permissions.blockWritesOutsideWorkingDirectories': r('boolean'),
  'permissions.defaultMode': j('string', 'bypassPermissions and auto are refused'),
  'permissions.deny': r('strings'),
  'permissions.denyInsteadOfPrompting': r('boolean'),
  'permissions.disableAutoMode': r('enum', ['disable']),
  'permissions.disableBypassPermissionsMode': r('enum', ['disable']),
  'permissions.workingDirectoriesAsGiven': r('strings'),
  'permissions.workingDirectoriesExclude': r('strings'),
  sandbox: j('object', 'its keys are judged one by one'),
  'sandbox.allowAppleEvents': j('boolean', 'true lets sandboxed commands launch applications outside the sandbox'),
  'sandbox.allowNestedUserNamespaces': j('boolean', 'true removes code-execution isolation'),
  'sandbox.allowUnsandboxedCommands': j('boolean', 'true reruns a failed command outside the sandbox'),
  'sandbox.autoAllowBashIfSandboxed': r('boolean'),
  'sandbox.bwrapPath': x('it names a binary the sandbox itself runs'),
  'sandbox.credentials': j('object', 'its keys are judged one by one'),
  'sandbox.credentials.allowPlaintextInject': j('boolean', 'true sends real credentials over plain HTTP'),
  'sandbox.credentials.awsPairs': r('array'),
  'sandbox.credentials.envVars': r('array'),
  'sandbox.credentials.files': r('array'),
  'sandbox.credentials.sigv4': x('its passthrough policies are not modelled'),
  'sandbox.enableWeakerNestedSandbox': j('boolean', 'true exposes the host /proc'),
  'sandbox.enableWeakerNetworkIsolation': j('boolean', 'true opens the trustd service to sandboxed commands'),
  'sandbox.enabled': j('boolean', 'false turns the sandbox off'),
  'sandbox.excludedCommands': j('strings', 'only commands the scoped seat already runs unsandboxed are admitted'),
  'sandbox.failIfUnavailable': j('boolean', 'false lets the seat start without a sandbox'),
  'sandbox.filesystem': j('object', 'its keys are judged one by one'),
  'sandbox.filesystem.allowManagedReadPathsOnly': r('boolean'),
  'sandbox.filesystem.allowRead': j('strings', 'each path must be inside the seat\'s roots'),
  'sandbox.filesystem.allowWrite': j('strings', 'each path must be inside the seat\'s roots'),
  'sandbox.filesystem.denyRead': r('strings'),
  'sandbox.filesystem.denyWrite': r('strings'),
  'sandbox.filesystem.disabled': j('boolean', 'true turns filesystem confinement off'),
  'sandbox.ignoreViolations': r('stringListMap'),
  'sandbox.network': j('object', 'its keys are judged one by one'),
  'sandbox.network.allowAllUnixSockets': j('boolean', 'true opens every Unix socket, a daemon\'s included'),
  'sandbox.network.allowLocalBinding': r('boolean'),
  'sandbox.network.allowMachLookup': j('strings', 'each service reached runs outside the sandbox; only an empty list is admitted'),
  'sandbox.network.allowManagedDomainsOnly': r('boolean'),
  'sandbox.network.allowUnixSockets': j('strings', 'a socket can reach a daemon outside the sandbox; only an empty list is admitted'),
  'sandbox.network.allowedDomains': j('strings', 'a domain list is admitted'),
  'sandbox.network.deniedDomains': r('strings'),
  'sandbox.network.httpProxyPort': x('it replaces the proxy that filters sandboxed traffic'),
  'sandbox.network.socksProxyPort': x('it replaces the proxy that filters sandboxed traffic'),
  'sandbox.network.strictAllowlist': r('boolean'),
  'sandbox.network.tlsTerminate': x('its certificate handling is not modelled'),
  'sandbox.network.tlsTerminate.caCertPath': x('its certificate handling is not modelled'),
  'sandbox.network.tlsTerminate.caKeyPath': x('its certificate handling is not modelled'),
  'sandbox.ripgrep': x('it names a binary run for the search tools, outside the sandbox'),
  'sandbox.ripgrep.args': x('it names a binary run for the search tools, outside the sandbox'),
  'sandbox.ripgrep.command': x('it names a binary run for the search tools, outside the sandbox'),
  'sandbox.socatPath': x('it names a binary the sandbox itself runs'),
  'sandbox.windows': j('object', 'its keys are judged one by one'),
  'sandbox.windows.backend': r('enum', ['sandboxuser', 'mxc']),
};
