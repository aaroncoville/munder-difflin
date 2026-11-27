'use strict';
// A scheduler in a process of its own, for the tests that need a second process or a real crash. Its one argument is
// JSON: { dbPath, hiveRoot, calls, started?, now?, leaseMs?, heartbeatMs?, crashAt?, mode, put? }.
//  - mode "ok": the stub runner returns a finished run at once; "slow": after 200 ms; "hang": never returns;
//    "block": blocks this process's event loop for good (alive, but it can no longer heartbeat);
//    "detached": starts a stand-in CLI detached into a process group of its own, as the headless seat does, reports it
//    through job.onProcess, and returns once it exits. The stand-in appends its pid to `cliLog` and lives `cliMs`;
//    with `cliChild`, it also starts a subprocess in its group (see there).
//  - crashAt names a point inside the scheduler where this process kills itself with SIGKILL, as a crash would.
//  - put: a task definition to store before the tick.
// The stub runner appends "<runId> <prompt>" to `calls` and, when `started` is given, creates that file.
// Prints the tick's report as JSON and exits 0.

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const loadTs = require(path.join(__dirname, 'load-ts.cjs'));
const { headlessRun } = require(path.join(__dirname, 'scheduler-fixtures.cjs'));

const o = JSON.parse(process.argv[2]);
const { openSchedulerStore } = loadTs('src/core/scheduler/store.ts');
const { Scheduler } = loadTs('src/core/scheduler/scheduler.ts');

const store = openSchedulerStore({ path: o.dbPath, hiveRoots: [o.hiveRoot] });
if (o.put) store.putTask(o.put, o.putAt ?? Date.now());

const runner = async (job) => {
  fs.appendFileSync(o.calls, `${job.runId} ${job.snapshot.prompt}\n`);
  if (o.started) fs.writeFileSync(o.started, String(process.pid));
  if (o.mode === 'slow') await new Promise((r) => setTimeout(r, 200));
  if (o.mode === 'hang') await new Promise(() => {});
  if (o.mode === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  if (o.mode === 'detached') {
    // With cliChild, the stand-in also starts a subprocess in its own group (as the CLI's own subprocesses join it),
    // which logs its pid after the stand-in's and lives a minute.
    const sub = o.cliChild ? `require('node:child_process').spawn(process.execPath, ['-e', \`require('node:fs').appendFileSync(${JSON.stringify(o.cliLog)}, process.pid + '\\\\n'); setTimeout(() => {}, 60000);\`], { stdio: 'ignore' }).unref();` : '';
    const script = `require('node:fs').appendFileSync(${JSON.stringify(o.cliLog)}, process.pid + '\\n'); ${sub} setTimeout(() => {}, ${Number(o.cliMs)});`;
    // With unreported, the stand-in's command line carries a settings argument as the seat's does, which the runner
    // names through job.onLaunch before starting it, and its pid is never reported: as after a crash between the two.
    const settings = `${o.cliLog}.${job.runId}.a${job.attempt}.json`;
    if (o.unreported) job.onLaunch(`--settings ${settings} `);
    const cli = spawn(process.execPath, ['-e', script, '--', '--settings', settings, 'x'], { detached: true, stdio: 'ignore' });
    if (!o.unreported) job.onProcess({ pid: cli.pid, pgid: cli.pid });
    await new Promise((r) => cli.on('exit', r));
  }
  return { run: headlessRun(), done: true, doneReason: null };
};

const crash = () => process.kill(process.pid, 'SIGKILL');
const hooks = o.crashAt ? { [o.crashAt]: crash } : {};

const scheduler = new Scheduler({
  store, hiveRoot: o.hiveRoot, runner, hooks,
  ...(typeof o.now === 'number' ? { now: () => o.now } : {}),
  ...(o.leaseMs ? { leaseMs: o.leaseMs } : {}),
  ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
});

scheduler.tick().then((report) => {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  store.close();
  process.exit(0);
}, (e) => {
  process.stderr.write(`${e && e.stack}\n`);
  process.exit(1);
});
