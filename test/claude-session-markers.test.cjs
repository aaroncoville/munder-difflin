'use strict';

/**
 * stripClaudeSessionMarkers (ptyEnv.ts): the denylist strip a hidden claude
 * session runs with. It must drop the inherited markers that describe the
 * parent session — the ones that make a child session believe it is nested
 * and switch transcript saving off — and nothing else: an operator's backend
 * selection and the switches that go with it are configuration the hidden
 * session needs to work at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { stripClaudeSessionMarkers, CLAUDE_SESSION_MARKERS } = loadTs('src/main/ptyEnv.ts');

// What a Bash subprocess of a live Claude Code session sees (captured on the
// 2026-10-20 floor), plus the markers named in review.
const MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: '3abbc539-7e79-43ce-a252-6247a999129f',
  CLAUDE_SESSION_ID: '3abbc539-7e79-43ce-a252-6247a999129f',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/Users/me/.nvm/versions/node/v22.23.3/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  CLAUDE_PID: '3281',
  CLAUDE_EFFORT: 'high',
  CLAUDE_CODE_MESSAGING_SOCKET: '/run/user/1000/cc-socks/3281.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token',
  CLAUDE_CODE_SSE_PORT: '41234',
  CLAUDE_CODE_HOST_HTTP_PROXY_PORT: '36887',
  CLAUDE_CODE_HOST_SOCKS_PROXY_PORT: '36887',
  CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX: 'Librarian'
};

// A Foundry-style operator configuration, with the other backends' switches
// alongside for good measure.
const CONFIG = {
  CLAUDE_CODE_USE_FOUNDRY: '1',
  ANTHROPIC_FOUNDRY_RESOURCE: 'my-resource',
  ANTHROPIC_FOUNDRY_API_KEY: 'k',
  CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1',
  CLAUDE_CODE_USE_BEDROCK: '0',
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  CLAUDE_CODE_USE_VERTEX: '0',
  CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
  CLAUDE_CODE_USE_MANTLE: '0',
  CLAUDE_CONFIG_DIR: '/operator/claude',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_TMPDIR: '/tmp/claude-1000',
  CLAUDE_TMPDIR: '/tmp/claude-1000',
  ANTHROPIC_MODEL: 'claude-haiku-5-5'
};

const PLAIN = { HOME: '/Users/me', PATH: '/usr/bin', LANG: 'en_US.UTF-8', SHELL: '/bin/bash' };

test('a Foundry-style env keeps every configuration variable and loses every session marker', () => {
  const out = stripClaudeSessionMarkers({ ...PLAIN, ...CONFIG, ...MARKERS });
  for (const k of Object.keys(MARKERS)) assert.equal(out[k], undefined, `${k} must be stripped`);
  for (const [k, v] of Object.entries(CONFIG)) assert.equal(out[k], v, `${k} must survive`);
  for (const [k, v] of Object.entries(PLAIN)) assert.equal(out[k], v, `${k} must survive`);
});

test('the denylist is explicit: every marker it names is the full set stripped', () => {
  const out = stripClaudeSessionMarkers({ ...MARKERS });
  assert.deepEqual(Object.keys(out), []);
  assert.deepEqual(new Set(Object.keys(MARKERS)), CLAUDE_SESSION_MARKERS);
});

test('an unknown CLAUDE_* variable is configuration until proven otherwise', () => {
  const out = stripClaudeSessionMarkers({ CLAUDE_CODE_SOME_NEW_SWITCH: 'on', CLAUDECODE: '1' });
  assert.deepEqual(out, { CLAUDE_CODE_SOME_NEW_SWITCH: 'on' });
});

test('undefined values are dropped and the input is not modified', () => {
  const input = { A: 'a', B: undefined, CLAUDECODE: '1' };
  const out = stripClaudeSessionMarkers(input);
  assert.deepEqual(out, { A: 'a' });
  assert.deepEqual(input, { A: 'a', B: undefined, CLAUDECODE: '1' });
});
