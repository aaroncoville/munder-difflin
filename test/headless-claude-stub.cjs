#!/usr/bin/env node
'use strict';
// Stands in for the `claude` CLI in headless-seat tests. Copied into a temporary folder as `claude`, it records
// what it was started with (argv, the exact environment, the working folder and the settings file named by
// --settings) to record.json beside itself, then prints the canned output in canned.json and exits with its code,
// or, when canned.json sets hang, stays running for five seconds (long enough to be killed, short enough that a
// launcher which never kills it fails its test instead of holding the run open) and then exits 0.

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const at = argv.indexOf('--settings');
let settings = null;
if (at !== -1 && argv[at + 1]) {
  try { settings = fs.readFileSync(argv[at + 1], 'utf8'); } catch (e) { settings = `unreadable: ${e.message}`; }
}
fs.writeFileSync(path.join(__dirname, 'record.json'), JSON.stringify({ argv, env: { ...process.env }, cwd: process.cwd(), settings }));

const canned = JSON.parse(fs.readFileSync(path.join(__dirname, 'canned.json'), 'utf8'));
if (canned.stderr) process.stderr.write(canned.stderr);
process.stdout.write(canned.stdout ?? '');
process.exitCode = canned.exitCode ?? 0;
if (canned.hang) setTimeout(() => process.exit(0), 5000);
