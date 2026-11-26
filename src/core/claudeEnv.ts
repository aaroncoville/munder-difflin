/**
 * Configuration, not identity: these share the CLAUDE prefix of a Claude session's identity markers but are the
 * OPERATOR's own choices — where the CLI keeps its config, how it authenticates, which backend serves it. An operator
 * who exported them wants agents to see them, and stripping them breaks agents in exactly the quiet way stripping the
 * parent session's identity exists to prevent. Everything session-scoped stays out of this list.
 */
export const CLAUDE_CONFIG_KEEP: ReadonlySet<string> = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
]);
