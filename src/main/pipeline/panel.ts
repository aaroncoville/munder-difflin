/**
 * The multi-model review panel (spec 7.1 to 7.3). Pure: no I/O.
 *
 * For each sha under review the conductor asks one reviewer per vendor: the first
 * name in that vendor's configured list that is on the live roster, not archived,
 * and really of that vendor. When every requested reviewer has a terminal state,
 * the combining rule decides once:
 *   1. any BLOCK blocks: one vendor's block is enough, and a CONFIRMED from the
 *      other vendor never outvotes it;
 *   2. else CONFIRMED from at least `minVendors` distinct vendors confirms;
 *   3. else the review is degraded (some vendor has no counted answer).
 * `minVendors` is never below two: the conductor does not merge on one vendor.
 */
import type { Vendor } from './config';
import type { VerdictWord } from './schema';

export interface RosterAgent {
  id: string;
  /** The agent's display name, matched against the configured panel names. */
  name: string;
  provider: string;
  archived: boolean;
}

export interface PanelSeat {
  vendor: Vendor;
  reviewer: string;
}

/** A requested reviewer's state for the sha: a verdict, UNAVAILABLE, DRIFTED, or null while it has none. */
export type TerminalState = VerdictWord | 'UNAVAILABLE' | 'DRIFTED' | null;

export type PanelOutcome = 'confirm' | 'block' | 'degraded' | 'pending';

const PROVIDER_VENDOR: Record<string, Vendor> = { claude: 'anthropic', codex: 'openai' };

/** The company behind an agent provider, or null for one with no reviewer vendor. */
export function vendorOf(provider: string): Vendor | null {
  return PROVIDER_VENDOR[provider] ?? null;
}

/** One reviewer per vendor (7.1); a vendor with nobody live is listed as missing. */
export function choosePanel(panel: Record<Vendor, string[]>, roster: RosterAgent[]): { reviewers: PanelSeat[]; missing: Vendor[] } {
  const reviewers: PanelSeat[] = [];
  const missing: Vendor[] = [];
  for (const vendor of Object.keys(panel) as Vendor[]) {
    const pick = panel[vendor]
      .map((name) => roster.find((a) => a.name === name && !a.archived && vendorOf(a.provider) === vendor))
      .find(Boolean);
    if (pick) reviewers.push({ vendor, reviewer: pick.id });
    else missing.push(vendor);
  }
  return { reviewers, missing };
}

/** The combining rule (7.3), evaluated once every requested reviewer is terminal for the sha. */
export function combine(reviewers: Array<{ vendor: Vendor; state: TerminalState }>, minVendors: number): PanelOutcome {
  if (reviewers.some((r) => r.state === null)) return 'pending';
  if (reviewers.some((r) => r.state === 'BLOCK')) return 'block';
  const confirmed = new Set(reviewers.filter((r) => r.state === 'CONFIRMED').map((r) => r.vendor));
  return confirmed.size >= Math.max(2, minVendors) ? 'confirm' : 'degraded';
}
