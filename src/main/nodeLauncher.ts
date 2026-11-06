/**
 * The launcher script for the app's bundled node. The app's binary normally runs the script, but on a dev build that
 * binary lives in node_modules, so losing that install would stop every agent's hooks at once. With it gone the launcher
 * looks for a real node: on PATH, then where one lives that a hook's bare PATH cannot see. `runtimeNode` is the app's
 * own PATH shim, which wraps the same missing binary, so it is passed over.
 */
export function nodeLauncherScript(execPath: string, platform: NodeJS.Platform | string, runtimeNode: string): string {
  if (platform === 'win32') {
    return `@echo off\r\nif not exist "${execPath}" goto nobundled\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\nexit /b %errorlevel%\r\n:nobundled\r\nnode %*\r\n`;
  }
  return `#!/bin/sh
if [ -x "${execPath}" ]; then ELECTRON_RUN_AS_NODE=1 exec "${execPath}" "$@"; fi
on_path=$(command -v node)
if [ -n "$on_path" ] && [ "$on_path" != "${runtimeNode}" ]; then exec "$on_path" "$@"; fi
for candidate in "$HOME/.local/share/mise/shims/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ]; then exec "$candidate" "$@"; fi
done
echo "hive-node: no node found, and ${execPath} is missing" >&2
exit 127
`;
}
