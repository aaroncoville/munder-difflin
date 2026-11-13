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
