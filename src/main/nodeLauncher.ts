/**
 * The launcher script for the app's bundled node. The app's binary normally runs the script, but on a dev build that
 * binary lives in node_modules, so losing that install would stop every agent's hooks at once. With it gone the launcher
 * looks for a real node: on PATH, then where one lives that a hook's bare PATH cannot see. `runtimeNode` is the app's
 * own PATH shim, which wraps the same missing binary, so it is passed over.
 */
export function nodeLauncherScript(execPath: string, platform: NodeJS.Platform | string, runtimeNode: string): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      `if not exist "${execPath}" goto nobundled`,
      'set ELECTRON_RUN_AS_NODE=1',
      `"${execPath}" %*`,
      'exit /b %errorlevel%',
      ':nobundled',
      `for /f "delims=" %%N in ('where node 2^>nul') do if /i not "%%~fN"=="${runtimeNode}" (set "FOUND_NODE=%%~fN" & goto found)`,
      'if exist "%LOCALAPPDATA%\\mise\\shims\\node.exe" (set "FOUND_NODE=%LOCALAPPDATA%\\mise\\shims\\node.exe" & goto found)',
      'if exist "%ProgramFiles%\\nodejs\\node.exe" (set "FOUND_NODE=%ProgramFiles%\\nodejs\\node.exe" & goto found)',
      `echo hive-node: no node found, and "${execPath}" is missing 1>&2`,
      'exit /b 127',
      ':found',
      '"%FOUND_NODE%" %*',
      'exit /b %errorlevel%',
      ''
    ].join('\r\n');
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
