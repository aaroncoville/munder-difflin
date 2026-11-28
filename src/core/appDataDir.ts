/**
 * The app's own data folder (the folder Electron calls userData), computed without Electron so that code outside
 * the app's main process (the hive CLI, a scheduler) finds the same folder the app uses.
 */
import { posix, win32 } from 'node:path';

/** The folder name of the app's data folder, as Electron derives userData from the package name. */
export const APP_DATA_NAME = 'munder-difflin';

/** The app's data folder for the platform, as Electron computes userData for this app. */
export function appDataDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_DATA_NAME);
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), APP_DATA_NAME);
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), APP_DATA_NAME);
}
