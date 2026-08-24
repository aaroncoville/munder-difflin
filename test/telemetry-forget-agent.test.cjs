'use strict';

/**
 * Per-agent usage counters must RESET when an agent's PTY dies, so a respawn
 * starts its cap counter at zero.
 *
 * Live symptom: `AgentUsageSample` is the input the circuit breaker compares
 * against `agentTokenCaps`, and it is aggregated from in-memory maps keyed by
 * agent id (`sessions` / `agentSessions`). `breaker.forget()` runs on PTY death
 * but those maps were never cleared, so a respawned agent re-inherited its dead
 * predecessor's lifetime token total and the cap re-tripped on the first beat —
 * before the fresh session had spent anything.
 *
 * Drives the collector through its REAL OTLP endpoint (loopback, ephemeral
 * port) rather than poking private maps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');

/** Minimal OTLP metrics batch: one token.usage point for (agent, session). */
function tokenBatch(agentId, sessionId, type, value) {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'agent.id', value: { stringValue: agentId } }] },
      scopeMetrics: [{
        metrics: [{
          name: 'claude_code.token.usage',
          sum: {
            dataPoints: [{
              asInt: String(value),
              attributes: [
                { key: 'session.id', value: { stringValue: sessionId } },
                { key: 'type', value: { stringValue: type } },
                { key: 'model', value: { stringValue: 'claude-sonnet-5' } }
              ]
            }]
          }
        }]
      }]
    }]
  };
}

async function post(endpoint, path, body) {
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(res.status, 200);
  await res.text();
}

test('forgetAgent resets an agent\'s usage counter so a respawn starts at zero', async (t) => {
  const telemetry = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
  await telemetry.start();
  t.after(() => telemetry.stop());
  const endpoint = telemetry.endpoint();

  await post(endpoint, '/v1/metrics', tokenBatch('jim', 'session-1', 'output', 900000));
  assert.equal(telemetry.getAgentUsage('jim').output, 900000, 'the dead session should have accumulated');

  telemetry.forgetAgent('jim');
  assert.equal(telemetry.getAgentUsage('jim'), null, 'a forgotten agent must report no live usage');

  // The respawned agent (same id) counts only its OWN new session.
  await post(endpoint, '/v1/metrics', tokenBatch('jim', 'session-2', 'output', 10));
  assert.equal(telemetry.getAgentUsage('jim').output, 10, 'the fresh session must not inherit the dead one');
});

test('forgetAgent leaves other agents\' counters untouched', async (t) => {
  const telemetry = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
  await telemetry.start();
  t.after(() => telemetry.stop());
  const endpoint = telemetry.endpoint();

  await post(endpoint, '/v1/metrics', tokenBatch('jim', 'session-1', 'output', 500));
  await post(endpoint, '/v1/metrics', tokenBatch('pam', 'session-2', 'output', 700));

  telemetry.forgetAgent('jim');

  assert.equal(telemetry.getAgentUsage('jim'), null);
  assert.equal(telemetry.getAgentUsage('pam').output, 700);
});

test('forgetAgent drops the agent\'s stale tool spans', async (t) => {
  const telemetry = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
  await telemetry.start();
  t.after(() => telemetry.stop());
  const endpoint = telemetry.endpoint();

  await post(endpoint, '/v1/logs', {
    resourceLogs: [{
      resource: { attributes: [{ key: 'agent.id', value: { stringValue: 'jim' } }] },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: String(Date.now() * 1e6),
          body: { stringValue: 'tool_result' },
          attributes: [
            { key: 'event.name', value: { stringValue: 'tool_result' } },
            { key: 'session.id', value: { stringValue: 'session-1' } },
            { key: 'tool_name', value: { stringValue: 'Bash' } }
          ]
        }]
      }]
    }]
  });
  assert.ok(telemetry.getSpans('jim').length > 0, 'expected a span to have been recorded');

  telemetry.forgetAgent('jim');
  assert.deepEqual(telemetry.getSpans('jim'), [], 'a respawn must not look "progressing" off the dead session\'s spans');
});
