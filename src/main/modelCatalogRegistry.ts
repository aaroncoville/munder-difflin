import { createCodexModelCatalog } from './codexModelCatalog';
import {
  CATALOG_CAPABLE_PROVIDERS,
  type ModelCatalogProvider,
  type ModelCatalogResult
} from '../shared/modelCatalog';

// Declared in the shared module so the preload bridge can publish it without
// importing anything from main; re-exported here because this file is where a
// new provider's adapter gets wired, and the two must change together.
export { CATALOG_CAPABLE_PROVIDERS };

/** The adapter for a provider, or undefined when it has none. */
export function modelCatalogFor(provider: string): ModelCatalogProvider | undefined {
  if (provider === 'codex') return createCodexModelCatalog();
  return undefined;
}

/** The body behind the models:refresh IPC: a live catalog, or a message the
 *  picker can show beside the list it is keeping.
 *
 *  It resolves in every case. A rejection would reach the renderer as an opaque
 *  "Error invoking remote method", which tells a user nothing about a list that
 *  is simply still the built-in one.
 *
 *  `lookup` is injectable so the failure paths can be tested without a codex
 *  install; production callers pass only the provider. */
export async function refreshModels(
  provider: string,
  lookup: (provider: string) => ModelCatalogProvider | undefined = modelCatalogFor
): Promise<ModelCatalogResult | { error: string }> {
  const adapter = lookup(provider);
  if (!adapter) return { error: `A live model list isn't available for ${provider}.` };
  try {
    const result = await adapter.queryModels();
    if (!result) return { error: `Couldn't reach ${provider} — showing the built-in list.` };
    return result;
  } catch (e) {
    return { error: `Couldn't reach ${provider} — showing the built-in list. (${e instanceof Error ? e.message : String(e)})` };
  }
}
