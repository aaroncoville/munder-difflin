#!/usr/bin/env node
'use strict';
/**
 * Finish installing two packages whose install can end up incomplete:
 *
 * - electron: since v43 the package declares no install script. The binary is
 *   downloaded by its install.js, which only runs when something requires the
 *   package. electron-vite never does: it reads `path.txt` and throws "Electron
 *   uninstall" without it. So every clean install reaches that error, and `dist`
 *   existing is not enough, because an interrupted extraction leaves `dist` too.
 * - node-pty: its install script compiles the binding where no prebuild ships, and
 *   recent npm versions skip dependency scripts not approved through `allowScripts`
 *   in package.json or the `allow-scripts` config, with only a warning. Only the
 *   binding is restored. node-pty's postinstall, which copies conpty.dll on Windows,
 *   is not: Windows ships a prebuild, so this step would not fire there anyway.
 *
 * Each step runs the package's own script and only when its output is missing, so
 * a normal install does nothing here and this file downloads nothing itself.
 * A failed step fails the install. To install without the Electron download, such
 * as offline, set ELECTRON_SKIP_BINARY_DOWNLOAD, which electron 43 no longer reads.
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

function pendingSteps({ root, platform, arch, env = process.env, log = console.log }) {
  const steps = [];

  const electron = join(root, 'node_modules', 'electron');
  if (existsSync(electron) && !electronIsInstalled(electron)) {
    if (env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
      log('[ensure-native-install] ELECTRON_SKIP_BINARY_DOWNLOAD is set; not downloading Electron');
    } else {
      steps.push({ name: 'electron', cwd: electron, command: process.execPath, args: ['install.js'], shell: false });
    }
  }

  const pty = join(root, 'node_modules', 'node-pty');
  if (existsSync(pty) && !ptyBindingIsPresent(pty, platform, arch)) {
    const { scripts = {} } = JSON.parse(readFileSync(join(pty, 'package.json'), 'utf8'));
    if (scripts.install) {
      steps.push({ name: 'node-pty', cwd: pty, command: scripts.install, args: [], shell: true });
    }
  }

  return steps;
}

/** Runs one step and returns its exit code. */
function runStep(step, log) {
  const result = spawnSync(step.command, step.args, { cwd: step.cwd, shell: step.shell, stdio: 'inherit' });
  if (result.status === 0) return 0;
  const reason = result.error ? `: ${result.error.message}` : '';
  log(`[ensure-native-install] ${step.name} install script failed${reason}`);
  return result.status || 1;
}

/** Runs the pending steps in order and returns the exit code for the process. */
function ensureNativeInstall({ root, platform, arch, env = process.env, log = console.log }) {
  for (const step of pendingSteps({ root, platform, arch, env, log })) {
    log(`[ensure-native-install] ${step.name} was not installed; running its install script`);
    const status = runStep(step, log);
    if (status !== 0) return status;
  }
  return 0;
}

module.exports = { pendingSteps, ensureNativeInstall, runStep };

if (require.main === module) {
  process.exitCode = ensureNativeInstall({
    root: join(__dirname, '..'),
    platform: process.platform,
    arch: process.arch,
  });
}
