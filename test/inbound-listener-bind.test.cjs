'use strict';

/**
 * The Slack and webhook listeners exist to be reached through a tunnel, and the
 * tunnel client forwards to `localhost`. Nothing on the local network needs them,
 * so they bind loopback unless the operator explicitly opts in.
 *
 * Each listener is really bound (port 0, tunnel stubbed so the test never reaches
 * the network) and asked which address it got.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { SlackWebhookServer } = loadTs('src/main/slack.ts');
const { WebhookServer } = loadTs('src/main/webhook.ts');

const LISTENERS = {
  SlackWebhookServer: (extra) =>
    new SlackWebhookServer({ port: 0, signingSecret: 's'.repeat(32), onMessage: () => {}, ...extra }),
  WebhookServer: (extra) =>
    new WebhookServer({
      port: 0,
      endpoints: [{ id: 'a', name: 'A', secret: 's'.repeat(64), schema: '{}' }],
      onMessage: () => null,
      lookupStatus: () => null,
      ...extra
    })
};

/** Start a listener with the tunnel stubbed, stopping it when the test ends. */
async function bind(t, make, extra) {
  const listener = make(extra);
  listener.openTunnel = async () => 'https://tunnel.invalid';
  t.after(() => listener.stop());
  const res = await listener.start();
  assert.equal(res.ok, true, `start() failed: ${res.error}`);
  return listener.server.address();
}

/** GET a URL the way the tunnel client does: by hostname, resolved by the OS. */
function statusOf(hostname, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: '/', method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

/** The address this machine gives a listener with no host. */
function wildcardAddress() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const { address } = server.address();
      server.close(() => resolve(address));
    });
  });
}

for (const [name, make] of Object.entries(LISTENERS)) {
  test(`${name} binds loopback when no option is given`, async (t) => {
    assert.equal((await bind(t, make)).address, '127.0.0.1');
  });

  test(`${name} binds loopback when the opt-in is false`, async (t) => {
    assert.equal((await bind(t, make, { bindAllInterfaces: false })).address, '127.0.0.1');
  });

  test(`${name} takes the operating system's wildcard only with the opt-in`, async (t) => {
    const { address, port } = await bind(t, make, { bindAllInterfaces: true });
    // The same address a listener given no host gets: dual-stack where the machine has IPv6.
    assert.equal(address, await wildcardAddress());
    assert.equal(typeof (await statusOf('127.0.0.1', port)), 'number');
    if (address === '::') assert.equal(typeof (await statusOf('::1', port)), 'number');
  });

  // The config file is hand-editable JSON, so the type does not protect this.
  for (const value of ['false', 'true', 1, {}]) {
    test(`${name} stays on loopback for the non-boolean opt-in ${JSON.stringify(value)}`, async (t) => {
      assert.equal((await bind(t, make, { bindAllInterfaces: value })).address, '127.0.0.1');
    });
  }

  test(`${name} is reachable at localhost on its default bind, as the tunnel client connects`, async (t) => {
    const { port } = await bind(t, make);
    const status = await statusOf('localhost', port);
    assert.equal(typeof status, 'number');
  });
}

/**
 * The classes only do what they are told, and the app's entry point cannot be
 * loaded outside Electron. Parse it instead: comments are not in the AST, so a
 * disabled line cannot satisfy this.
 */
test('the app hands the config setting to both listeners', () => {
  const file = path.join(__dirname, '..', 'src/main/index.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const seen = {};
  const visit = (node) => {
    if (ts.isNewExpression(node) && Object.hasOwn(LISTENERS, node.expression.getText())) {
      const prop = node.arguments[0].properties.find((p) => p.name?.getText() === 'bindAllInterfaces');
      seen[node.expression.getText()] = prop?.initializer?.getText();
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(seen, {
    SlackWebhookServer: 'cfg.inboundBindAllInterfaces',
    WebhookServer: 'cfg.inboundBindAllInterfaces'
  });
});
