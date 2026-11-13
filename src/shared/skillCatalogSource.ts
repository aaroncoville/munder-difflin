/**
 * Where the Skills tab's browsable catalog comes from: the README of a
 * third-party GitHub repository that lists Claude skills. Main fetches it when
 * the user opens Browse (cached for a day), and the tab names it, so the source
 * of the list is never hidden. Installing a skill downloads it from the skill's
 * own repository, not from here.
 */
export const SKILL_CATALOG_REPO = 'abubakarsiddik31/claude-skills-collection';
export const SKILL_CATALOG_URL = `https://raw.githubusercontent.com/${SKILL_CATALOG_REPO}/main/README.md`;
