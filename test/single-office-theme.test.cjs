'use strict';
// The TV-show office themes are gone: one office floor, no theme picker, no
// theme settings. A config saved by an older build that still names a show or
// turns the flag on must load and change nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-single-theme-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData }, ipcMain: { handle() {}, on() {} } } };
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const ROOT = path.join(__dirname, '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', 'src', ...p);

test('the office is the only floor theme: no show maps, no picker, no theme table', () => {
  // themeRegistry.ts imports Vite asset URLs, so it is checked on disk, not loaded.
  assert.deepEqual(fs.readdirSync(R('assets', 'maps')).filter((f) => f.endsWith('.tmj')), ['office.tmj']);
  assert.equal(fs.existsSync(R('components', 'OfficeThemePicker.tsx')), false);
  const registry = fs.readFileSync(R('scene', 'office', 'themeRegistry.ts'), 'utf8');
  assert.doesNotMatch(registry, /brooklyn99|BROOKLYN99|THEMES\b|ThemeId/);
});

test('no locale carries the theme picker strings', () => {
  for (const loc of ['en', 'en-SH', 'ar', 'zh-CN']) {
    const json = JSON.parse(fs.readFileSync(R('i18n', 'locales', `${loc}.json`), 'utf8'));
    const hasBlock = (o) => o && typeof o === 'object' && Object.entries(o).some(([k, v]) => k === 'officeTheme' || hasBlock(v));
    assert.equal(hasBlock(json), false, loc);
  }
});

test('the config has no theme settings, and an old config that names one loads unchanged otherwise', () => {
  const { readConfig } = loadTs('src/main/config.ts');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ onboardingComplete: true }));
  const fresh = readConfig();
  assert.equal('tvShowOffices' in fresh, false, 'no default for the removed flag');
  assert.equal('officeTheme' in fresh, false, 'no default for the removed theme');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ onboardingComplete: true, tvShowOffices: true, officeTheme: 'brooklyn99', terminalTheme: 'dark' }));
  const c = readConfig();
  assert.equal(c.onboardingComplete, true);
  assert.equal(c.terminalTheme, 'dark');
});

test('voice cannot change a theme setting', () => {
  const { VOICE_SETTING_KEYS } = loadTs('src/main/realtimeActions.ts');
  assert.ok(VOICE_SETTING_KEYS.includes('terminalTheme'));
  assert.equal(VOICE_SETTING_KEYS.includes('tvShowOffices'), false);
  assert.equal(VOICE_SETTING_KEYS.includes('officeTheme'), false);
});
