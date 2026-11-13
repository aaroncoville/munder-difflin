/**
 * The name the app shows people, and the notice that has to travel with it.
 *
 * Display only. No folder, bundle id, URL scheme, file marker or spec tag is
 * derived from this constant: those keep their original spelling, because
 * existing installs, agent configs and shared links are keyed on them. The
 * settings folder in particular is pinned in `src/main/legacyUserData.ts`.
 */
export const PRODUCT_NAME = 'Hush House';

/** Where this build's source, issues and changelog live. */
export const PRODUCT_REPO_URL = 'https://github.com/aaroncoville/munder-difflin';

/** The name set as a wordmark, for the places that letter-space it in capitals. */
export const PRODUCT_WORDMARK = PRODUCT_NAME.toUpperCase();

/**
 * The name draws on the Secret Histories setting, so the Sixth History Community
 * Licence applies to the product as a whole: it must say it is unofficial and
 * not endorsed, wherever the name is shown large, next to the Sixth History logo.
 * Kept in English in every language, as a legal notice.
 */
export const UNOFFICIAL_NOTICE =
  `${PRODUCT_NAME} is an unofficial fan work set in Weather Factory's Sixth History. ` +
  'It is not affiliated with or endorsed by Weather Factory Ltd, and is published under ' +
  "Weather Factory's Sixth History Community Licence.";
