/**
 * The folders the app keeps for itself, which no agent's sandbox may reach.
 *
 * Main trusts what it finds in its own data folder: the hook runtime it stages and runs hooks from, the settings files
 * of its helper sessions, its config, databases and secrets. An agent whose working folder or writable roots reach one
 * of these could forge a file there that main then reads or runs. So each module registers the private folder it
 * chooses, where it chooses it, and admission refuses any agent whose roots contain, equal or lie inside a registered
 * folder (hive.ts, the same decision that keeps agents out of the Codex homes), before anything for it is created.
 *
 * The app data folder itself is registered at start (index.ts), so a folder inside it is covered even before its
 * module registers it. A module that adds a private folder of its own, anywhere, registers it with one call:
 *   registerPrivateDir(folder, 'the <name> folder');
 * from the place that creates or chooses the folder.
 *
 * This covers agents the app sandboxes (Claude and Codex). An agent the app does not sandbox can write anywhere, so no
 * root check holds it; such agents keep their own admission rule (hive.ts).
 */
import { overlaps, type WriteRoot } from './hookRuntime';

const registered = new Map<string, string>();

/** Register a folder the app keeps for itself, with a label that names it in a refusal. Returns a function that
 *  removes the registration (tests). */
export function registerPrivateDir(path: string, label: string): () => void {
  registered.set(path, label);
  return () => { if (registered.get(path) === label) registered.delete(path); };
}

/** Every registered private folder. */
export function privateDirs(): Array<{ path: string; label: string }> {
  return [...registered].map(([path, label]) => ({ path, label }));
}

/** An agent whose write roots reach one of the app's private folders. */
export class PrivateDirRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateDirRefused';
  }
}

/** Why these roots reach a private folder (contain it, equal it or lie inside it, compared resolved), naming the
 *  folder, the root and where the root came from; null when none does. */
export function privateDirsReach(roots: WriteRoot[]): string | null {
  for (const d of privateDirs()) {
    for (const r of roots) {
      if (r.path && overlaps(d.path, r.path)) {
        return `the agent may write ${d.label} (${d.path}) through ${r.path} (${r.from}); no agent may reach a folder the app keeps for itself`;
      }
    }
  }
  return null;
}
