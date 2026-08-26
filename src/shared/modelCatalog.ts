/** The live model catalog: one adapter interface, one provider-specific parser.
 *
 *  A CLI's account-scoped model list drifts (models ship, models retire), so a
 *  hardcoded picker list goes stale between releases and can offer a slug the
 *  account cannot run. The pieces here let a provider be asked for its current
 *  list at run time, while keeping the raw → typed step a pure function so it
 *  is testable without the CLI installed. */

/** One selectable model. Structurally identical to the renderer's ModelOption
 *  (src/renderer/src/store/config.ts); redeclared here so this shared module
 *  carries no renderer dependency. */
export interface ModelOption {
  /** undefined = use the CLI default (no --model flag) */
  id?: string;
  label: string;
}

export interface ModelCatalogResult {
  models: ModelOption[];
  /** The provider's own current default model id, when it reports one. */
  default?: string;
}

/** Providers that can report a live model list. Everything else keeps the
 *  built-in picker list. It lives in the shared module because BOTH sides need
 *  it — main to route a refresh, the renderer to decide whether offering one
 *  makes sense — and the preload bridge may not import from main to get it. */
export const CATALOG_CAPABLE_PROVIDERS = ['codex'] as const;

export interface ModelCatalogProvider {
  /** The live catalog, or null when it is unsupported or unreachable — the
   *  caller then falls back to the built-in list. Never throws for an expected
   *  failure (no CLI, not logged in, timeout). */
  queryModels(): Promise<ModelCatalogResult | null>;
}

/** One entry of a codex `app-server` `model/list` result, narrowed to the
 *  fields the picker needs. Verified against codex-cli 0.149.1, whose result is
 *  `{ data: [...], nextCursor }` — note it is `data`, not `models`, and the
 *  default is flagged `isDefault`, not `default`. */
interface RawCodexModel {
  id?: unknown;
  displayName?: unknown;
  isDefault?: unknown;
  hidden?: unknown;
}

/** Map a codex `model/list` result to a catalog.
 *
 *  Returns null on any payload that yields no usable model. That null is the
 *  fallback signal: an empty picker is strictly worse than a stale one, so
 *  "nothing parsed" must stay distinguishable from "parsed, and it is empty".
 *
 *  Only the first page is read. The result carries a `nextCursor`, but every
 *  account seen so far returns its whole (single-digit) catalog in one page,
 *  and a picker that pages is worse than one that shows the first page now. */
export function parseCodexModelList(raw: unknown): ModelCatalogResult | null {
  const list = (raw as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(list)) return null;
  const models: ModelOption[] = [];
  let flagged: string | undefined;
  for (const entry of list as RawCodexModel[]) {
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    // The provider hides models it will not run for this account; offering one
    // would put a slug in the picker that fails at spawn.
    if (entry.hidden === true) continue;
    // A model with no display name is labelled by its id — the picker must
    // never render a chip a user cannot read back as a --model value.
    const label =
      typeof entry.displayName === 'string' && entry.displayName.length > 0
        ? entry.displayName
        : id;
    models.push({ id, label });
    if (entry.isDefault === true && flagged === undefined) flagged = id;
  }
  if (models.length === 0) return null;
  return flagged === undefined ? { models } : { models, default: flagged };
}
