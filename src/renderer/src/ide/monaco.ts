/**
 * Monaco bootstrap for the Electron renderer (electron-vite / Vite).
 *
 * Two things have to be true for Monaco to work in a bundled Electron app:
 *
 *  1. Workers must be SELF-HOSTED, not fetched from a CDN. We import each
 *     language worker through Vite's `?worker` suffix, which emits a real
 *     bundled worker chunk and a constructor. `MonacoEnvironment.getWorker`
 *     hands Monaco the right one per language. This is the electron-vite-safe
 *     equivalent of the classic `getWorkerUrl` CDN dance — it works offline and
 *     inside the packaged `app.asar` because the worker URL is resolved by Vite
 *     at build time (relative `base: './'`).
 *
 *  2. `@monaco-editor/react` must use THIS bundled `monaco` instance rather than
 *     its default behaviour of lazy-loading monaco from a CDN via AMD. We pin it
 *     with `loader.config({ monaco })`.
 *
 * Import this module once (for its side effects) before any editor mounts.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import { occultMonacoTheme, OCCULT_MONACO_THEME } from '@/design/occult/occultTerminal';
import { paletteMonacoTheme } from '@/design/panelPalette';

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  }
};

let themesDefined = false;

/** Register the editor's theme (idempotent). */
function defineThemes(m: typeof monaco): void {
  if (themesDefined) return;
  themesDefined = true;
  m.editor.defineTheme(OCCULT_MONACO_THEME, paletteMonacoTheme(occultMonacoTheme));
}

let configured = false;

/** Pin @monaco-editor/react to the bundled monaco + register themes. Idempotent. */
export function setupMonaco(): typeof monaco {
  if (!configured) {
    configured = true;
    loader.config({ monaco });
  }
  defineThemes(monaco);
  return monaco;
}

/** Map a filename to a Monaco language id (used to set the model language). */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'ts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'md':
    case 'markdown': return 'markdown';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'c':
    case 'h': return 'c';
    case 'cpp':
    case 'cc':
    case 'hpp': return 'cpp';
    case 'cs': return 'csharp';
    case 'php': return 'php';
    case 'sh':
    case 'bash':
    case 'zsh': return 'shell';
    case 'html':
    case 'htm': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'yml':
    case 'yaml': return 'yaml';
    case 'toml': return 'ini';
    case 'xml': return 'xml';
    case 'sql': return 'sql';
    case 'dockerfile': return 'dockerfile';
    default:
      if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
      return 'plaintext';
  }
}
