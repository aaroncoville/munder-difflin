#!/usr/bin/env node
'use strict';
// Stands in for a `claude` CLI that never finishes, for headless-seat timeout tests. Copied into a temporary folder
// as `claude`, it starts one grandchild that shares its stdout (as a tool's subprocess would), records both process
// ids to the file hang.json names as pidsFile (pids.json beside itself by default), and then waits forever. With hang.json { "ignoreTerm": true } beside it, it and
// its grandchild both ignore SIGTERM, so only SIGKILL stops them. With { "print": "..." } it prints that text first.
// With { "exitAfterMs": n } the stub itself exits 0 after n ms, leaving the grandchild.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

let conf = {};
try { conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'hang.json'), 'utf8')); } catch { /* defaults */ }
const ignoreTerm = conf.ignoreTerm === true;
if (typeof conf.print === 'string') process.stdout.write(conf.print);

const wait = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000);`;
if (ignoreTerm) process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', wait], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(typeof conf.pidsFile === 'string' ? conf.pidsFile : path.join(__dirname, 'pids.json'), JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
if (typeof conf.exitAfterMs === 'number') setTimeout(() => process.exit(0), conf.exitAfterMs);
else setInterval(() => {}, 1000);
