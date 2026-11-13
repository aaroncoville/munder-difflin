'use strict';

// The Settings card and the model presets used to be fetched from the original
// project's repository, so that project could put text and a live link into
// this app and change the models every installed copy offers. This build ships
// both and fetches neither.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const code = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the hero card and the model catalog are answered from the build, not the network', () => {
  const index = code('src/main/index.ts');
  assert.match(index, /^ipcMain\.handle\('hero:payload', \(\) => \(\{ hero: DEFAULT_HERO, fetchedAt: 0, stale: false \}\)\);$/m);
  assert.match(index, /^ipcMain\.handle\('models:catalog', \(\) => \(\{ catalog: null, fetchedAt: 0, stale: false \}\)\);$/m);
  assert.doesNotMatch(index, /loadHero|loadModelCatalog/);
  assert.equal(fs.existsSync(path.join(root, 'src/main/hero.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/main/modelCatalog.ts')), false);
});

test('no main-process source fetches from the original project', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(root, 'src/main'))) {
    if (!/\.ts$/.test(f)) continue;
    // The updater keeps its feed name as an identifier, but every path that
    // would use it is gated off (update-feed-off.test.cjs).
    if (f === 'updater.ts') continue;
    if (/raw\.githubusercontent\.com\/chaitanyagiri|munderdiffl\.in/.test(code(`src/main/${f}`))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("the Settings card links no community of the original project", () => {
  assert.doesNotMatch(code('src/renderer/src/components/SettingsHeroCard.tsx'), /discord\.gg|DISCORD_URL/);
});

test("the evidence check points contributors at this repository's guide", () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/pr-evidence.yml'), 'utf8');
  assert.doesNotMatch(wf, /github\.com\/chaitanyagiri/);
  assert.match(wf, /github\.com\/aaroncoville\/munder-difflin\/blob\/theme\/sixth-history\/CONTRIBUTING\.md#evidence-is-mandatory/);
});
