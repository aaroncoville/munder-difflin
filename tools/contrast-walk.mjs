#!/usr/bin/env node
// Contrast walk: drive the BUILT app and measure the text it renders.
//
// A source scan can only find the patterns someone thought to write down; this
// reads what the renderer actually paints. It launches the production build
// (`npm run build` first) twice on throwaway profiles: once as a first run, to
// walk every step of the onboarding wizard, and once as a finished install,
// where it visits every command-centre tab (the Workers tab fed live workers in
// each state through the main process's own `workers:list` handler), every
// Settings section, every Add Agent section, the quit warning (raised through
// the main process's own `app:closeRequested` message), and focus mode with the
// agent list shown and hidden. In each view it hovers every visible control,
// then scrolls each scrolling box a screen at a time to its end, hovering what
// each screen reveals.
//
// In every state it reads, for each laid-out element with its own text, each
// form field (typed text and placeholder) and each pseudo-element with text,
// the computed text colour and the backgrounds that can be behind it: fills
// alpha-composited up the ancestor chain with element opacity, every stop of a
// gradient, and any filled ::before/::after, keeping the worst. It checks:
//
//   - large text (>= 24px, or >= 18.66px bold): at least 3:1
//   - everything else:                           at least 4.5:1
//
// Text drawn over a picture (a url() background) cannot be measured from
// styles; it is counted and listed as unmeasured, never passed silently. What
// the walk does not reach is printed at the end.
//
//   node tools/contrast-walk.mjs [--electron <binary>] [--port 9339] [--out <file.json>] [--app <dir>]
//
// The second launch uses the next two ports up; each main process's
// inspector listens one port above its window's.
// Exit code 1 when anything is under its floor.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', '9339'));
const OUT = arg('out', null);
// The app to launch; by default this checkout's build. Another build (for
// example one with a fix reverted) can be walked with this checkout's walker.
const APP = resolve(arg('app', ROOT));
const electron = arg('electron', null) ?? createRequire(import.meta.url)('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The labels the walk clicks, read from the locales so a rename cannot make
// the walk silently skip a view. The app speaks English in the house register.
const merge = (a, b) => {
  for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' ? merge(a[k] ?? {}, v) : v;
  return a;
};
const locale = (code) => JSON.parse(readFileSync(join(ROOT, 'src/renderer/src/i18n/locales', `${code}.json`), 'utf8'));
const L = merge(locale('en'), locale('en-SH'));
const TABS = Object.values(L.commandCenter.tabs);
const SECTIONS = Object.values(L.settings.nav ?? {}).filter((v) => typeof v === 'string');

// ─── launch ──────────────────────────────────────────────────────────────────

/** Start the app on a fresh throwaway profile. The renderer is driven over
 *  its DevTools port; the main process is reached over its inspector port, so
 *  fixtures enter through the app's own IPC channels rather than by reaching
 *  into the page. */
async function launch(config, port) {
  const scratch = mkdtempSync(join(tmpdir(), 'contrast-walk-'));
  const profile = join(scratch, 'profile');
  const home = join(scratch, 'home');
  mkdirSync(profile, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ ...config, harnessHome: home }));
  const env = { ...process.env };
  delete env.ELECTRON_RENDERER_URL; // load the built renderer, never a dev server
  const app = spawn(electron, [`--inspect=${port + 1}`, APP, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  const exited = new Promise((r) => app.once('exit', r));
  const sockets = [];
  // Wait for the app to be gone before the next launch, so nothing of this
  // one is still answering on its ports or holding its profile.
  const cleanup = async () => {
    for (const w of sockets) { try { w.close(); } catch { /* closed */ } }
    try { app.kill(); } catch { /* gone */ }
    await Promise.race([exited, sleep(10_000)]);
    rmSync(scratch, { recursive: true, force: true });
  };
  const target = async (port, pick) => {
    for (let i = 0; i < 80; i++) {
      try {
        const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(pick);
        if (t) return t;
      } catch { /* not up yet */ }
      await sleep(500);
    }
    return null;
  };
  const connect = async (url) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise((r) => ws.addEventListener('open', r));
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
    return (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  };
  const page = await target(port, (t) => t.type === 'page' && /index\.html/.test(t.url));
  const main = await target(port + 1, () => true);
  if (!page || !main) { await cleanup(); throw new Error('the app did not open its window or its inspector'); }
  const call = await connect(page.webSocketDebuggerUrl);
  const mainCall = await connect(main.webSocketDebuggerUrl);
  const ev = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const mainEv = async (expression) => {
    const r = await mainCall('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (r.result?.exceptionDetails) throw new Error(`main: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`);
    return r.result?.result?.value;
  };
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(3000);
  return { call, ev, mainEv, cleanup };
}

// ─── in-page measurement ─────────────────────────────────────────────────────

const MEASURE = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null;
    const v = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
  const stops = (img) => [...img.matchAll(/rgba?\\([^)]+\\)/g)].map((m) => parse(m[0]));
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const filled = (c) => c && c[3] > 0;
  /** Every colour that can be behind an element's text. A gradient adds each
   *  of its stops; a pseudo-element with a fill on the element or an ancestor
   *  adds that fill, since it may sit behind the text: the worst case is kept. */
  const groundsOf = (el) => {
    const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
    let root = parse(getComputedStyle(document.documentElement).backgroundColor) || [0, 0, 0, 1];
    if (root[3] < 1) root = [0, 0, 0, 1];
    let grounds = [root];
    let image = false;
    for (const e of chain.reverse()) {
      const cs = getComputedStyle(e);
      const bg = parse(cs.backgroundColor);
      if (filled(bg)) { grounds = grounds.map((g) => over(bg, g)); if (bg[3] >= 1) { image = false; grounds = [grounds[0]]; } }
      const img = cs.backgroundImage || '';
      if (/url\\(/.test(img)) image = true;
      else if (/gradient\\(/.test(img)) grounds = grounds.flatMap((g) => stops(img).filter(filled).map((s) => over(s, g)).concat([g]));
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(e, pseudo);
        if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
        if (!overlaps(e, ps)) continue;
        const pb = parse(ps.backgroundColor);
        if (filled(pb)) grounds = grounds.concat(grounds.map((g) => over(pb, g)));
        if (/gradient\\(/.test(ps.backgroundImage || '')) grounds = grounds.concat(grounds.flatMap((g) => stops(ps.backgroundImage).filter(filled).map((s) => over(s, g))));
      }
    }
    return { grounds, image };
  };
  /** False only for a positioned pseudo-element placed wholly outside its
   *  element's box (a tooltip below a button): it cannot be behind the text. */
  const overlaps = (e, ps) => {
    if (!/absolute|fixed/.test(ps.position)) return true;
    const w = e.offsetWidth, h = e.offsetHeight;
    const px = (v) => (v.endsWith('px') ? parseFloat(v) : NaN);
    return !(px(ps.top) >= h || px(ps.bottom) >= h || px(ps.left) >= w || px(ps.right) >= w);
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const out = { checked: 0, unmeasured: [], fails: [], lowest: null };
  const check = (el, label, color, size, weight, own) => {
    const fg = parse(color); if (!fg) return;
    let { grounds, image } = groundsOf(el);
    // Pseudo-element text sits on the pseudo-element's own fill, if it has one.
    const pb = own && parse(own.backgroundColor);
    if (filled(pb)) { grounds = grounds.map((g) => over(pb, g)); if (pb[3] >= 1) { grounds = [grounds[0]]; image = false; } }
    if (image) { out.unmeasured.push(label); return; }
    let k = Infinity; let worst = grounds[0];
    for (const g of grounds) { const r = ratio(over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], g), g); if (r < k) { k = r; worst = g; } }
    const floor = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    out.checked++;
    if (!out.lowest || k < out.lowest.ratio) out.lowest = { ratio: +k.toFixed(2), text: label, color };
    if (k < floor) out.fails.push({ ratio: +k.toFixed(2), floor, text: label, color, ground: 'rgb(' + worst.slice(0, 3).map(Math.round).join(', ') + ')', disabled: !!el.closest('[disabled]') || el.disabled === true });
  };
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    // Laid out, wherever it is scrolled: colour does not depend on position.
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (opacityOf(el) === 0) continue; // fully transparent: nothing is shown
    const size = parseFloat(cs.fontSize); const weight = Number(cs.fontWeight);
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) check(el, own.slice(0, 48), cs.color, size, weight);
    // What a person types into a field, and the hint shown while it is empty.
    if (el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden]), textarea, select')) {
      check(el, '[field] ' + (el.value || el.name || el.type || el.tagName).slice(0, 40), cs.color, size, weight);
      if (el.placeholder) { const ps = getComputedStyle(el, '::placeholder'); check(el, '[placeholder] ' + el.placeholder.slice(0, 40), ps.color, parseFloat(ps.fontSize) || size, Number(ps.fontWeight) || weight); }
    }
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      const text = /^["'](.+)["']$/.exec(ps.content || '');
      if (text && text[1].trim() && ps.display !== 'none') check(el, '[' + pseudo + '] ' + text[1].slice(0, 40), ps.color, parseFloat(ps.fontSize) || size, Number(ps.fontWeight) || weight, ps);
    }
  }
  return out;
})()`;

/** Every visible control's centre, so each can be hovered in turn. A control
 *  already hovered in this view is marked and skipped after a scroll. */
const CONTROLS = `[...document.querySelectorAll('button,[role=button],a,select,input,textarea,[role=tab],label')]
  .filter((e) => !e.dataset.contrastWalkHovered)
  .map((e) => [e, e.getBoundingClientRect()])
  .filter(([, r]) => r.width > 2 && r.height > 2 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth)
  .filter(([e, r]) => { const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); return top && (top === e || e.contains(top)); })
  .map(([e, r]) => { e.dataset.contrastWalkHovered = '1'; return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })`;

/** Scroll every scrollable box one screen further; false once all are at the end. */
const SCROLL_ON = `(() => { let moved = false;
  for (const e of [document.scrollingElement, ...document.querySelectorAll('body *')]) {
    if (!e) continue; const cs = e === document.scrollingElement ? null : getComputedStyle(e);
    if (cs && !/(auto|scroll)/.test(cs.overflowY)) continue;
    if (e.scrollHeight - e.clientHeight < 4) continue;
    const before = e.scrollTop; e.scrollTop = Math.min(e.scrollTop + Math.max(40, e.clientHeight - 40), e.scrollHeight);
    if (e.scrollTop !== before) moved = true; }
  return moved; })()`;
const UNMARK = `document.querySelectorAll('[data-contrast-walk-hovered]').forEach((e) => delete e.dataset.contrastWalkHovered)`;

const report = { states: [], checked: 0, unmeasured: 0, unmeasuredText: new Set(), fails: [], lowest: null, unreachable: [] };
const seenFail = new Set();
function record(state, m) {
  if (!m) throw new Error(`no measurement for ${state}`);
  report.states.push(state);
  if (process.env.CONTRAST_WALK_PROGRESS) process.stderr.write(`${state}\n`);
  report.checked += m.checked;
  report.unmeasured += m.unmeasured.length;
  for (const u of m.unmeasured) report.unmeasuredText.add(u);
  if (m.lowest && (!report.lowest || m.lowest.ratio < report.lowest.ratio)) report.lowest = { ...m.lowest, state };
  for (const f of m.fails) {
    const key = `${f.text}|${f.color}|${f.ground}`;
    if (!seenFail.has(key)) { seenFail.add(key); report.fails.push({ ...f, state }); }
  }
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walker({ call, ev }) {
  const clickText = (re) => ev(`(() => { const r = new RegExp(${JSON.stringify(re)}, 'i');
    const b = [...document.querySelectorAll('button,[role=button],[role=tab],label')].find((x) =>
      !x.disabled && r.test(((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + x.textContent).trim()));
    if (!b) return false; b.click(); return true; })()`);
  const key = async (k) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k });
  };
  async function hoverAll(name) {
    const points = (await ev(CONTROLS)) ?? [];
    for (const [x, y] of points) {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(90);
      record(`${name} · hover ${x},${y}`, await ev(MEASURE));
    }
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  }
  /** Measure a view, hover each control, then scroll every scrolling box a
   *  screen at a time to its end, hovering what each screen reveals. */
  async function walkView(name) {
    await sleep(900);
    await ev(UNMARK);
    record(name, await ev(MEASURE));
    await hoverAll(name);
    for (let i = 1; i <= 40 && (await ev(SCROLL_ON)); i++) {
      await sleep(200);
      record(`${name} · scrolled ${i}`, await ev(MEASURE));
      await hoverAll(`${name} · scrolled ${i}`);
    }
  }
  return { clickText, key, walkView };
}

// The live workers the Workers tab can show: one in each state the main
// process reports, one replying to Slack, one near its token cap, and a
// preserved worktree.
const now = Date.now();
const WORKERS = {
  live: [
    { workerId: 'w-working', reqId: 'r1', name: 'fixture: working', baseBranch: 'main', spawnedAt: now - 95_000, ageMs: 95_000, idleMs: 2_000, tokensUsed: 182_000, tokenCap: 200_000, hasSlack: true, releasing: false, status: 'working' },
    { workerId: 'w-done', reqId: 'r2', name: 'fixture: done', baseBranch: 'main', spawnedAt: now - 600_000, ageMs: 600_000, idleMs: 300_000, tokensUsed: 41_000, tokenCap: null, hasSlack: false, releasing: false, status: 'done' },
    { workerId: 'w-releasing', reqId: 'r3', name: 'fixture: releasing', baseBranch: 'main', spawnedAt: now - 30_000, ageMs: 30_000, idleMs: null, tokensUsed: 900, tokenCap: 50_000, hasSlack: false, releasing: true, status: 'releasing' }
  ],
  preserved: [{ workerId: 'w-kept', wtPath: '/tmp/worktrees/w-kept', baseBranch: 'main', preservedAt: now - 3_600_000 }],
  maxWorkers: 4
};

let first;
try {
  // ── First run: the onboarding wizard, every step. ──
  first = await launch({ onboardingComplete: false }, PORT);
  {
    const { clickText, walkView } = walker(first);
    const O = L.onboarding;
    await walkView('onboarding: persona');
    if (await clickText(`^${esc(O.persona.technicalTitle)}`)) await walkView('onboarding: persona chosen');
    else report.unreachable.push('onboarding: persona chosen');
    for (const step of ['welcome', 'home', 'orchestrator', 'repos', 'permissions']) {
      const next = step === 'home' ? O.permissions.setItUp : L.common.next;
      if (await clickText(`^${esc(next)}$`)) await walkView(`onboarding: ${step}`);
      else report.unreachable.push(`onboarding: ${step}`);
    }
    await first.cleanup();
    first = null;
  }

  // ── A floor that has finished onboarding. ──
  const run = await launch({ onboardingComplete: true }, PORT + 2);
  first = run;
  const { clickText, key, walkView } = walker(run);
  // Feed the Workers tab through its own channel: the renderer asks
  // `workers:list` as it always does and gets live workers in every state.
  await run.mainEv(`(() => { const { ipcMain } = process.mainModule.require('electron');
    ipcMain.removeHandler('workers:list');
    ipcMain.handle('workers:list', () => (${JSON.stringify(WORKERS)}));
    return true; })()`);
  // A fresh install opens on the hive picker; take the default.
  await clickText('^open$');
  await sleep(6000);

  for (const tab of TABS) {
    if (await clickText(`^${esc(tab)}$`)) await walkView(`tab: ${tab}`);
    else report.unreachable.push(`tab: ${tab} (not shown on a fresh floor)`);
  }

  if (await clickText('^Settings$')) {
    for (const s of SECTIONS) {
      if (await clickText(`^${esc(s)}$`)) await walkView(`settings: ${s}`);
      else report.unreachable.push(`settings: ${s}`);
    }
    await clickText(`^${esc(L.settings.close)}$`);
    await sleep(500);
  } else report.unreachable.push('settings');

  if (await clickText(`^${esc(L.agentStrip.addAgent)}$`)) {
    for (const s of Object.values(L.addAgent.sections)) {
      // Each section button reads as its step number, then its label.
      if (await clickText(`^\\d*\\s*${esc(s.label)}`)) await walkView(`add agent: ${s.label}`);
      else report.unreachable.push(`add agent: ${s.label}`);
    }
    await key('Escape');
    await sleep(500);
  } else report.unreachable.push('add agent');

  // The quit warning, raised the way the main process raises it.
  await run.mainEv(`(() => { const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL()));
    w.webContents.send('app:closeRequested', { ptyCount: 3 }); return true; })()`);
  await walkView('quit warning');
  // It closes on a click outside it.
  await run.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 4, button: 'left', clickCount: 1 });
  await run.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 4, y: 4, button: 'left', clickCount: 1 });
  await sleep(500);

  if (await clickText('Toggle focus mode')) {
    await walkView('focus mode');
    if (await clickText(L.fullscreenTerminal.hideAgentList.split(' — ')[0])) await walkView('focus mode, agent list hidden');
    else report.unreachable.push('focus mode, agent list hidden');
  } else report.unreachable.push('focus mode');
} finally {
  await first?.cleanup();
}

report.unreachable.push(
  'pressed (:active) states and keyboard focus rings: not driven',
  'agent states that need a live session: thinking, working, waiting, blocked, compacting and looping agents, their task cards and pending approvals; worker states are fixtures',
  'menus, pickers and dialogs other than Settings, Add Agent and the quit warning (for example the restore menu, the folder picker, an agent\'s edit dialog)',
  'text drawn into the terminal and editor canvases: not DOM, held by the palette tests instead',
  'text over a picture (a url() background): counted as unmeasured below, not passed'
);
const summary = {
  checked: report.checked,
  states: report.states.length,
  unmeasured: report.unmeasured,
  lowest: report.lowest,
  failures: report.fails.length
};
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, fails: report.fails, unreachable: report.unreachable, unmeasuredText: [...report.unmeasuredText], states: report.states }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const f of report.fails) console.log(`FAIL ${f.ratio} < ${f.floor}${f.disabled ? ' (disabled)' : ''}  ${JSON.stringify(f.text)}  ${f.color} on ${f.ground}  [${f.state}]`);
if (report.unmeasuredText.size) console.log('unmeasured (over a picture):\n  ' + [...report.unmeasuredText].join('\n  '));
console.log('not reached:\n  ' + report.unreachable.join('\n  '));
process.exit(report.fails.length ? 1 : 0);
