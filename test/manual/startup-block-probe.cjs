'use strict';
/*
 * Manual probe (needs a display; not part of `npm test`): how long Electron's main thread may stay busy between app
 * ready and the first page load before the network service fails to start and the window never loads (#109).
 *
 *   node_modules/.bin/electron test/manual/startup-block-probe.cjs            # default blocks: 0 8 12 16 25 s
 *   BLOCKS=0,14,20 node_modules/.bin/electron test/manual/startup-block-probe.cjs
 *
 * Each block runs in a fresh Electron child with its own temporary userData, so it never touches the app's folder or
 * a running app. Seen on Electron 43.8.4 (macOS): 0-12 s load; 16 s and 25 s print "Network service crashed or was
 * terminated, restarting service" and never load. The same 25 s block after the page has loaded is harmless.
 * Exit code 0 when every block up to 12 s loads.
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const WAIT_MS = 15_000;

if (process.env.PROBE_CHILD) {
  // One run: block main for BLOCK_MS right after ready, then load URL and report.
  app.setPath('userData', process.env.PROBE_USERDATA);
  app.whenReady().then(() => {
    const end = Date.now() + Number(process.env.BLOCK_MS);
    while (Date.now() < end) { /* synchronous work on main, as a startup git commit was */ }
    const w = new BrowserWindow({ width: 240, height: 120, show: false });
    const done = (r) => { process.stdout.write(`PROBE ${r}\n`); app.exit(0); };
    w.webContents.on('did-finish-load', () => done('loaded'));
    w.webContents.on('did-fail-load', (_e, code, desc) => done(`failed ${code} ${desc}`));
    w.loadURL(process.env.PROBE_URL);
    setTimeout(() => done('never-loaded'), WAIT_MS);
  });
} else {
  const blocks = (process.env.BLOCKS || '0,8,12,16,25').split(',').map((s) => Number(s.trim()));
  const server = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<p>ok</p>'); });
  // The page is served from this process, so each child runs asynchronously: a synchronous wait would leave the
  // server unable to answer and every block would read as a failure.
  const run = (url, s) => new Promise((resolve) => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-block-probe-'));
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, PROBE_CHILD: '1', PROBE_USERDATA: ud, PROBE_URL: url, BLOCK_MS: String(s * 1000) }
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), s * 1000 + WAIT_MS + 15_000);
    child.on('close', () => { clearTimeout(kill); fs.rmSync(ud, { recursive: true, force: true }); resolve(out); });
  });
  server.listen(0, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    let ok = true;
    for (const s of blocks) {
      const out = await run(url, s);
      const result = (out.match(/PROBE (.*)/) || [])[1] || 'no result';
      const crashed = /Network service crashed or was terminated/.test(out);
      console.log(`block ${String(s).padStart(3)} s: ${result}${crashed ? '  (network service crashed)' : ''}`);
      if (s <= 12 && result !== 'loaded') ok = false;
    }
    server.close();
    process.exit(ok ? 0 : 1);
  });
}
