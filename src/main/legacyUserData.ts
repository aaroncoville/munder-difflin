import { join } from 'node:path';

/**
 * The settings folder every existing install already uses.
 *
 * Electron names the folder after the app, so changing the displayed name, or
 * calling `app.setName`, would start the app on an empty folder: settings, the
 * agent database, usage history, Slack state and the renderer's local storage
 * would all be left behind in the old one. The folder is a storage location, not
 * branding, so it keeps this name whatever the app is called.
 */
export const LEGACY_DATA_FOLDER = 'munder-difflin';

/** The subset of Electron's `app` this needs, so the decision can be tested without Electron. */
export interface UserDataPaths {
  getPath(name: 'appData'): string;
  setPath(name: 'userData', path: string): void;
}

/** Point `userData` at the legacy folder. Must run before anything reads `userData` and before `ready`. */
export function pinLegacyUserData(app: UserDataPaths): string {
  const dir = join(app.getPath('appData'), LEGACY_DATA_FOLDER);
  app.setPath('userData', dir);
  return dir;
}
