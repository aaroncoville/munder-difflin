#!/usr/bin/env node
// Contrast walk: drive the BUILT app and measure every text node it renders.
//
// A source scan can only find the patterns someone thought to write down; this
// reads what the renderer actually paints. It launches the production build
// (`npm run build` first) on a throwaway profile and harness home, then visits
// every command-centre tab, every Settings section, focus mode with the agent
// list shown and hidden, and, in each of those views, hovers every visible
// control. In every state it reads, for each element with its own text, the
// computed text colour and the background actually behind it (alpha composited
// up the ancestor chain, including element opacity), and checks:
//
//   - large text (>= 24px, or >= 18.66px bold): at least 3:1
//   - everything else:                           at least 4.5:1
//
// Text drawn over a background image (the painted Study) cannot be measured
// from styles; it is counted and listed as unmeasured, never passed silently.
//
//   node tools/contrast-walk.mjs [--electron <binary>] [--port 9339] [--out <file.json>]
//
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

const scratch = mkdtempSync(join(tmpdir(), 'contrast-walk-'));
const profile = join(scratch, 'profile');
const home = join(scratch, 'home');
mkdirSync(profile, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(profile, 'config.json'), JSON.stringify({ onboardingComplete: true, harnessHome: home }));
const env = { ...process.env };
delete env.ELECTRON_RENDERER_URL; // load the built renderer, never a dev server
const app = spawn(electron, [ROOT, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
const cleanup = () => { try { app.kill(); } catch { /* gone */ } rmSync(scratch, { recursive: true, force: true }); };

let page;
for (let i = 0; i < 80 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  if (!page) await sleep(500);
}
if (!page) { cleanup(); throw new Error('the app did not open a page'); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const call = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
await sleep(3000);

// ─── in-page measurement ─────────────────────────────────────────────────────

const MEASURE = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null;
    const v = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const groundOf = (el) => {
    const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
    let ground = parse(getComputedStyle(document.documentElement).backgroundColor) || [0, 0, 0, 1];
    if (ground[3] < 1) ground = [0, 0, 0, 1];
    let image = false;
    for (const e of chain.reverse()) {
      const cs = getComputedStyle(e);
      const bg = parse(cs.backgroundColor);
      // An opaque fill covers any picture beneath it; a picture on top of
      // this element's own fill makes its text unmeasurable from styles.
      if (bg && bg[3] > 0) { ground = over(bg, ground); if (bg[3] >= 1) image = false; }
      if (/url\\(/.test(cs.backgroundImage || '')) image = true;
    }
    return { ground, image };
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const out = { checked: 0, unmeasured: [], fails: [], lowest: null };
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const fg = parse(cs.color); if (!fg) continue;
    const { ground, image } = groundOf(el);
    const label = own.slice(0, 48);
    if (image) { out.unmeasured.push(label); continue; }
    const k = ratio(over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], ground), ground);
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const floor = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    out.checked++;
    if (!out.lowest || k < out.lowest.ratio) out.lowest = { ratio: +k.toFixed(2), text: label, color: cs.color };
    if (k < floor) out.fails.push({ ratio: +k.toFixed(2), floor, text: label, color: cs.color, ground: 'rgb(' + ground.slice(0, 3).map(Math.round).join(', ') + ')', disabled: !!el.closest('[disabled]') });
  }
  return out;
})()`;

const clickText = (re) => ev(`(() => { const r = new RegExp(${JSON.stringify(re)}, 'i');
  const b = [...document.querySelectorAll('button,[role=button],[role=tab]')].find((x) =>
    r.test(((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + x.textContent).trim()));
  if (!b) return false; b.click(); return true; })()`);

/** Every visible control's centre, so each can be hovered in turn. */
const CONTROLS = `[...document.querySelectorAll('button,[role=button],a,select,input,[role=tab]')]
  .map((e) => e.getBoundingClientRect())
  .filter((r) => r.width > 2 && r.height > 2 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth)
  .map((r) => [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)])`;

const report = { states: [], checked: 0, unmeasured: 0, fails: [], lowest: null, unreachable: [] };
const seenFail = new Set();
function record(state, m) {
  report.states.push(state);
  report.checked += m.checked;
  report.unmeasured += m.unmeasured.length;
  if (m.lowest && (!report.lowest || m.lowest.ratio < report.lowest.ratio)) report.lowest = { ...m.lowest, state };
  for (const f of m.fails) {
    const key = `${f.text}|${f.color}|${f.ground}`;
    if (!seenFail.has(key)) { seenFail.add(key); report.fails.push({ ...f, state }); }
  }
}

async function walkView(name) {
  await sleep(900);
  record(name, await ev(MEASURE));
  const points = (await ev(CONTROLS)) ?? [];
  for (const [x, y] of points) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(90);
    record(`${name} · hover ${x},${y}`, await ev(MEASURE));
  }
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
}

try {
  // A fresh install opens on the hive picker; take the default.
  await clickText('^open$');
  await sleep(6000);

  for (const tab of TABS) {
    if (await clickText(`^${tab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)) await walkView(`tab: ${tab}`);
    else report.unreachable.push(`tab: ${tab} (not shown on a fresh floor)`);
  }

  if (await clickText('^Settings$')) {
    for (const s of SECTIONS) {
      if (await clickText(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)) await walkView(`settings: ${s}`);
      else report.unreachable.push(`settings: ${s}`);
    }
    await clickText(`^${L.settings.close}$`);
    await sleep(500);
  } else report.unreachable.push('settings');

  if (await clickText('Toggle focus mode')) {
    await walkView('focus mode');
    if (await clickText(L.fullscreenTerminal.hideAgentList.split(' — ')[0])) await walkView('focus mode, agent list hidden');
    else report.unreachable.push('focus mode, agent list hidden');
  } else report.unreachable.push('focus mode');
} finally {
  ws.close();
  cleanup();
}

report.unreachable.push(
  'pressed (:active) states and keyboard focus rings: not driven',
  'states that need live work: running, blocked or looping agents, populated task cards, pending approvals, an open editor',
  'text inside the terminal and editor canvases: not DOM, held by the palette tests instead'
);
const summary = {
  checked: report.checked,
  states: report.states.length,
  unmeasured: report.unmeasured,
  lowest: report.lowest,
  failures: report.fails.length
};
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, ...report, states: undefined, stateCount: report.states.length }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const f of report.fails) console.log(`FAIL ${f.ratio} < ${f.floor}${f.disabled ? ' (disabled)' : ''}  ${JSON.stringify(f.text)}  ${f.color} on ${f.ground}  [${f.state}]`);
console.log('not reached:\n  ' + report.unreachable.join('\n  '));
process.exit(report.fails.length ? 1 : 0);
