#!/usr/bin/env node
'use strict';
/**
 * Restore what a dependency's install script should have left behind.
 *
 * npm can skip dependency install scripts: `--ignore-scripts` aside, recent npm
 * versions block those not covered by `allowScripts`, with only a warning. The
 * root postinstall still runs, and two packages are then incomplete:
 *
 * - electron: its install script downloads the binary and writes `path.txt`.
 *   electron-vite reads that file and throws "Electron uninstall" without it, so
 *   `dist` existing is not enough; an interrupted extraction leaves `dist` too.
 * - node-pty: its install script compiles the binding where no prebuild ships.
 *
 * Each step runs the package's own script and only when its output is missing, so
 * a normal install does nothing here and this file downloads nothing itself.
 * A failed step fails the install, as it would have if npm had run the script.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function electronIsInstalled(dir) {
  const pathFile = join(dir, 'path.txt');
  if (!existsSync(pathFile)) return false;
  const executable = readFileSync(pathFile, 'utf8');
  return executable !== '' && existsSync(join(dir, 'dist', executable));
}

/** The directories node-pty's loader (lib/utils.js) searches, for the binding this platform loads. */
function ptyBindingIsPresent(dir, platform, arch) {
  const binding = platform === 'win32' ? 'conpty.node' : 'pty.node';
  return ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`].some((searched) =>
    existsSync(join(dir, searched, binding))
  );
}

function pendingSteps({ root, platform, arch }) {
  const steps = [];

  const electron = join(root, 'node_modules', 'electron');
  if (existsSync(electron) && !electronIsInstalled(electron)) {
    steps.push({ name: 'electron', cwd: electron, command: process.execPath, args: ['install.js'], shell: false });
  }

  const pty = join(root, 'node_modules', 'node-pty');
  if (existsSync(pty) && !ptyBindingIsPresent(pty, platform, arch)) {
    const { scripts } = JSON.parse(readFileSync(join(pty, 'package.json'), 'utf8'));
    steps.push({ name: 'node-pty', cwd: pty, command: scripts.install, args: [], shell: true });
  }

  return steps;
}

/** Runs the pending steps in order and returns the exit code for the process. */
function ensureNativeInstall({ root, platform, arch, log = console.log }) {
  for (const step of pendingSteps({ root, platform, arch })) {
    log(`[ensure-native-install] ${step.name} was not installed; running its install script`);
    const result = spawnSync(step.command, step.args, { cwd: step.cwd, shell: step.shell, stdio: 'inherit' });
    if (result.status !== 0) {
      log(`[ensure-native-install] ${step.name} install script failed`);
      return result.status || 1;
    }
  }
  return 0;
}

module.exports = { pendingSteps, ensureNativeInstall };

if (require.main === module) {
  process.exitCode = ensureNativeInstall({
    root: join(__dirname, '..'),
    platform: process.platform,
    arch: process.arch,
  });
}
