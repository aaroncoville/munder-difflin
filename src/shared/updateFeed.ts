/**
 * Whether this build checks for, downloads or announces updates.
 *
 * Off. The release feed the updater reads is the original project's, whose
 * builds carry the original name and settings, so following it would replace
 * this build with a different product. Until there is a feed of this build's
 * own releases, nothing is polled, nothing is downloaded, the post-update
 * release page is not fetched, and Settings does not offer a switch that would
 * do nothing.
 */
export const UPDATE_FEED_ENABLED = false;

/** What every gated update action answers while the feed is off. */
export const UPDATES_OFF = 'updates are turned off in this build';

export interface UpdatesOff { ok: false; error: string }

/**
 * Wrap an update action so it refuses while the feed is off. Main wraps its IPC
 * handlers with it and the preload wraps the calls it exposes, so neither side
 * can reach the feed or the releases page on its own. Always resolves, so a
 * caller that awaits or chains `.then` behaves the same either way.
 */
export function feedGate(enabled: boolean) {
  return <A extends unknown[], R>(action: (...args: A) => R) =>
    async (...args: A): Promise<Awaited<R> | UpdatesOff> =>
      enabled ? await action(...args) : { ok: false, error: UPDATES_OFF };
}

/** The gate for this build. */
export const whenFeedOn = feedGate(UPDATE_FEED_ENABLED);
