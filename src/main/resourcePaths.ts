import { join } from 'node:path';

/**
 * Absolute path to a file the app ships in its own resources: under
 * `resourcesPath` when packaged (electron-builder extraResources), under the
 * repository's `resources/` folder in development.
 */
export function bundledResourcePath(
  name: string,
  where: { isPackaged: boolean; resourcesPath: string; appPath: string }
): string {
  return where.isPackaged ? join(where.resourcesPath, name) : join(where.appPath, 'resources', name);
}
