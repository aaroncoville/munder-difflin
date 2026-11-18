'use strict';

// The app is shown as Hush House. These hold that the name comes from one
// constant, reaches the packaged app, the agents and every locale, and that the
// licence notice travelling with it says the product is unofficial.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** Source with comments removed, so a match can only come from live code. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const builderValue = (key) => {
  const m = read('electron-builder.yml').match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  assert.ok(m, `electron-builder.yml has no top-level ${key}`);
  return m[1].trim();
};

const { PRODUCT_NAME, PRODUCT_WORDMARK, UNOFFICIAL_NOTICE } = loadTs('src/shared/productName.ts');

test('the packaged app is named from the same constant the UI uses', () => {
  assert.equal(PRODUCT_NAME, 'Hush House');
  assert.equal(PRODUCT_WORDMARK, 'HUSH HOUSE');
  assert.equal(builderValue('productName'), PRODUCT_NAME);
});

test('the unofficial notice names the product and says it is not endorsed', () => {
  assert.match(UNOFFICIAL_NOTICE, /^Hush House is an unofficial fan work set in Weather Factory's Sixth History\./);
  assert.match(UNOFFICIAL_NOTICE, /not affiliated with or endorsed by Weather Factory Ltd/);
});

test('agents are told the new name in their RUNNING BUILD line', () => {
  assert.match(code('src/main/hive.ts'), /`RUNNING BUILD: \$\{PRODUCT_NAME\} v\$\{rt\.version\}/);
});

test('the locales render the product name from the constant', () => {
  const i18n = loadTs('src/renderer/src/i18n/index.ts').default;
  const old = /munder|difflin/i;
  for (const lng of ['en', 'ar', 'zh-CN']) {
    const t = i18n.getFixedT(lng);
    const keys = ['onboarding.titles.persona', 'onboarding.persona.body', 'onboarding.permissions.shareStatsDesc',
                  'updatesSection.downloadedDetail', 'triggersTab.organisationBlurb'];
    for (const key of keys) {
      const out = t(key, { v: '1.0.0' });
      assert.notEqual(out, key, `${lng}:${key} is missing`);
      assert.doesNotMatch(out, old, `${lng}:${key} still shows the old name`);
      assert.ok(out.includes(PRODUCT_NAME) || out.includes(PRODUCT_WORDMARK), `${lng}:${key} does not show ${PRODUCT_NAME}: ${out}`);
    }
  }
});

test('no app source shows the old name, in full or short form', () => {
  // A hyphen after it marks a kept identifier (release asset names such as
  // Munder-Difflin-1.0.0-mac-arm64.dmg), not a displayed name.
  const old = /\bMunder\b(?!-)|MUNDER\b|MunderDifflin/;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) {
        code(rel).split("\n").forEach((line) => { if (old.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 100)}`); });
      }
    }
  };
  for (const dir of ['src/main', 'src/preload', 'src/shared', 'src/renderer/src']) walk(dir);
  assert.deepEqual(offenders, []);
});

test('the window title is the product name', () => {
  assert.match(read('src/renderer/index.html'), new RegExp(`<title>${PRODUCT_NAME}</title>`));
});

test('the startup splash names the product, not the setting', () => {
  // The splash is static HTML painted before any script runs, so it cannot read
  // the constant; this holds the literal to it.
  const html = read('src/renderer/index.html');
  const title = html.match(/<div class="title">([^<]*)<\/div>/);
  assert.ok(title, 'the splash has no title');
  assert.equal(title[1], PRODUCT_WORDMARK);
  assert.doesNotMatch(html.match(/<div class="mk">([^<]*)<\/div>/)[1], /^MD$/);
});

test('the title bar shows the product name beside the logo', () => {
  // The window uses titleBarStyle hiddenInset, so macOS draws no native title:
  // the app's own title bar is the only place the name can appear.
  assert.match(code('src/main/index.ts'), /titleBarStyle: 'hiddenInset'/);
  const app = code('src/renderer/src/App.tsx');
  const bar = app.slice(app.indexOf('className="cth-titlebar-drag"'));
  const logo = bar.indexOf('src={brandLogo}');
  const name = bar.indexOf('{PRODUCT_NAME}');
  const version = bar.search(/<AppVersionLabel \/>|<UpdateBadge \/>/);
  assert.ok(logo !== -1 && name !== -1 && version !== -1, 'logo, name and version are all in the title bar');
  assert.ok(logo < name && name < version, 'the name sits between the logo and the version');
  assert.match(app, /^import \{[^}]*\bPRODUCT_NAME\b[^}]*\} from '@shared\/productName';$/m);
});

test("the Settings card's star, issue and changelog links open this build's repository", () => {
  const { PRODUCT_REPO_URL } = loadTs('src/shared/productName.ts');
  const hero = code('src/renderer/src/components/SettingsHeroCard.tsx');
  assert.match(hero, /^const GITHUB_REPO_URL = PRODUCT_REPO_URL;$/m);
  assert.doesNotMatch(hero, /github\.com\/chaitanyagiri/);
  assert.match(PRODUCT_REPO_URL, /^https:\/\/github\.com\/aaroncoville\//);
});

test('the hive-sync skill agents install describes itself by the product name', () => {
  const skill = read('resources/skills/md-hive-sync/SKILL.md');
  assert.match(skill, new RegExp(`^  ${PRODUCT_NAME} hive sync`, 'm'));
  assert.doesNotMatch(skill, /Munder Difflin/);
});
