import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve(import.meta.dirname, '..');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tsr-')), {
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new', '--autoplay-policy=no-user-gesture-required'],
});
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  let defaults;
  for (let i = 0; i < 20; i++) { // poll: onInstalled seeds defaults asynchronously
    defaults = await sw.evaluate(() => chrome.storage.local.get('config'));
    if (defaults.config) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(defaults.config?.hosts?.length === 6 && defaults.config.waitSeconds === 10 && defaults.config.graceMinutes === 5, 'defaults seeded');

  await sw.evaluate(() => chrome.storage.local.set({
    config: { hosts: ['example.com'], waitSeconds: 1, graceMinutes: 5 }, passes: {}, stats: {} }));

  const overlay = (p) => p.evaluate(() => !!document.getElementById('__ten-second-rule__'));
  const p = await ctx.newPage();
  await p.goto('https://example.com/', { waitUntil: 'commit' });
  await p.waitForSelector('#__ten-second-rule__', { state: 'attached', timeout: 3000 });
  ok(true, 'overlay present on first visit');
  await p.waitForTimeout(1800);
  ok(!(await overlay(p)), 'overlay gone after countdown');
  const st = await sw.evaluate(() => chrome.storage.local.get(['stats', 'passes']));
  ok(st.stats['example.com']?.shown === 1 && st.stats['example.com']?.completed === 1, 'stats shown=1 completed=1');
  ok(typeof st.passes['example.com'] === 'number', 'pass written');

  await p.goto('https://example.com/?again', { waitUntil: 'load' });
  await p.waitForTimeout(600);
  ok(!(await overlay(p)), 'no overlay within grace');

  // subdomain match
  await sw.evaluate(() => chrome.storage.local.set({ passes: {} }));
  await p.goto('https://www.example.com/', { waitUntil: 'commit' });
  await p.waitForSelector('#__ten-second-rule__', { state: 'attached', timeout: 3000 });
  ok(true, 'subdomain www.example.com gated');
  await p.close();

  const setCfg = (c) => sw.evaluate((c) => chrome.storage.local.set({ config: c, passes: {}, stats: {} }), c);
  const html = (body) => ({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });

  // negative host match
  const n = await ctx.newPage();
  await n.route('https://notexample.com/**', (r) => r.fulfill(html('hi')));
  await n.goto('https://notexample.com/', { waitUntil: 'load' });
  await n.waitForTimeout(600);
  ok(!(await overlay(n)), 'notexample.com not gated');
  await n.close();

  // iframe not gated
  await sw.evaluate(() => chrome.storage.local.set({ passes: {} }));
  const f = await ctx.newPage();
  await f.route('https://embed.test/**', (r) => r.fulfill(html('<iframe src="https://example.com/" width=300 height=200></iframe>')));
  await f.goto('https://embed.test/', { waitUntil: 'load' });
  await f.waitForTimeout(800);
  const fr = f.frames().find((x) => x.url().startsWith('https://example.com'));
  ok(fr && !(await overlay(fr)), 'iframe not gated');
  await f.close();

  // top-layer stacking + media pause (light + shadow DOM) + detach recovery
  await setCfg({ hosts: ['example.com'], waitSeconds: 4, graceMinutes: 5 });
  const wav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  const z = await ctx.newPage();
  await z.route('https://example.com/z', (r) => r.fulfill(html(
    `<div id=hi style="position:fixed;inset:0;z-index:2147483647;background:red"></div>` +
    `<audio id=a src="${wav}" loop></audio><div id=host></div>` +
    `<script>const sr=document.getElementById('host').attachShadow({mode:'open'});` +
    `sr.innerHTML='<audio id=sa src="${wav}" loop></audio>';` +
    `setTimeout(()=>{document.getElementById('a').play().catch(()=>{});sr.getElementById('sa').play().catch(()=>{})},300)</script>`)));
  await z.goto('https://example.com/z', { waitUntil: 'commit' });
  await z.waitForSelector('#__ten-second-rule__', { state: 'attached', timeout: 3000 });
  await z.waitForTimeout(900);
  ok(await z.evaluate(() => { const r = document.getElementById('__ten-second-rule__'); return r.isConnected && r.matches(':popover-open'); }), 'overlay connected and popover open over z-index page');
  ok(await z.evaluate(() => document.getElementById('a').paused), 'light-DOM audio paused behind overlay');
  ok(await z.evaluate(() => document.getElementById('host').shadowRoot.getElementById('sa').paused), 'shadow-DOM audio paused behind overlay');
  await z.evaluate(() => document.getElementById('__ten-second-rule__').remove());
  await z.waitForTimeout(500);
  ok(await z.evaluate(() => { const r = document.getElementById('__ten-second-rule__'); return !!r && r.isConnected && r.matches(':popover-open'); }), 'overlay re-appended and open after page removes it');
  await z.close();

  // hidden-tab timer pause
  await setCfg({ hosts: ['example.com'], waitSeconds: 3, graceMinutes: 5 });
  const hA = await ctx.newPage();
  await hA.route('https://example.com/h', (r) => r.fulfill(html('hidden test')));
  await hA.goto('https://example.com/h', { waitUntil: 'commit' });
  await hA.waitForSelector('#__ten-second-rule__', { state: 'attached', timeout: 3000 });
  // Headless Chrome never reports hidden; spoof visibility inside the content script's isolated world.
  const cdp = await ctx.newCDPSession(hA);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
  await cdp.send('Runtime.enable');
  const iso = worlds.find((w) => w.origin.startsWith('chrome-extension://'));
  const setVis = (v) => cdp.send('Runtime.evaluate', { contextId: iso.id, expression:
    `Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'${v}'});document.dispatchEvent(new Event('visibilitychange'))` });
  ok(!!iso, 'found content script isolated world');
  await setVis('hidden');
  await hA.waitForTimeout(4500);
  ok(await overlay(hA), 'overlay still present after hidden > wait');
  await setVis('visible');
  await hA.waitForTimeout(4000);
  ok(!(await overlay(hA)), 'overlay completes after visible time');
  // unfocused-window pause: spoof hasFocus=false + blur, then restore
  await setCfg({ hosts: ['example.com'], waitSeconds: 3, graceMinutes: 5 });
  const fA = await ctx.newPage();
  await fA.route('https://example.com/f', (r) => r.fulfill(html('focus test')));
  await fA.goto('https://example.com/f', { waitUntil: 'commit' });
  await fA.waitForSelector('#__ten-second-rule__', { state: 'attached', timeout: 3000 });
  const cdpF = await ctx.newCDPSession(fA);
  const worldsF = [];
  cdpF.on('Runtime.executionContextCreated', (e) => worldsF.push(e.context));
  await cdpF.send('Runtime.enable');
  const isoF = worldsF.find((w) => w.origin.startsWith('chrome-extension://'));
  const setFocus = (f) => cdpF.send('Runtime.evaluate', { contextId: isoF.id, expression:
    `document.hasFocus=()=>${f};window.dispatchEvent(new Event('${f ? 'focus' : 'blur'}'))` });
  const paused = () => fA.evaluate(() => document.getElementById('__ten-second-rule__')?.hasAttribute('data-paused'));
  ok(!!isoF, 'found isolated world for focus test');
  await setFocus(false);
  await fA.waitForTimeout(4500);
  ok(await overlay(fA), 'overlay still present after unfocused > wait');
  ok(await paused(), 'paused line shown while unfocused');
  await setFocus(true);
  await fA.waitForTimeout(3500);
  ok(!(await overlay(fA)), 'overlay completes within wait+0.5s after refocus');
  await fA.close();

  // options friction
  const o = await ctx.newPage();
  await o.goto(`chrome-extension://${id}/options.html`);
  await o.fill('#newHost', 'foo.org'); await o.click('#addForm button');
  ok((await sw.evaluate(() => chrome.storage.local.get('config'))).config.hosts.includes('foo.org'), 'add host instant');
  await o.click('button.rm >> nth=0');
  ok(await o.locator('#modal.on').count() === 1, 'remove opens friction modal');
  await o.click('#mcancel');
  ok((await sw.evaluate(() => chrome.storage.local.get('config'))).config.hosts.includes('example.com'), 'cancel keeps host');
  await o.fill('#wait', '5'); await o.click('#saveWait');
  ok((await sw.evaluate(() => chrome.storage.local.get('config'))).config.waitSeconds === 5, 'raise wait instant');
  await o.fill('#wait', '2'); await o.click('#saveWait');
  ok(await o.locator('#modal.on').count() === 1, 'lower wait opens modal');
  await o.click('#mcancel');

  // stale-tab friction bypass
  await setCfg({ hosts: ['example.com'], waitSeconds: 10, graceMinutes: 5 });
  const A = await ctx.newPage(); await A.goto(`chrome-extension://${id}/options.html`);
  const B = await ctx.newPage(); await B.goto(`chrome-extension://${id}/options.html`);
  await B.fill('#wait', '60'); await B.click('#saveWait');
  await B.waitForTimeout(300);
  await A.fill('#wait', '30'); await A.click('#saveWait');
  await A.waitForTimeout(300);
  ok(await A.locator('#modal.on').count() === 1, 'stale tab lowering 60->30 opens friction');
  ok((await sw.evaluate(() => chrome.storage.local.get('config'))).config.waitSeconds === 60, 'stale tab did not apply instantly');
  await A.close(); await B.close();

  // live: youtube + facebook + reddit
  await setCfg({ hosts: ['youtube.com', 'facebook.com', 'reddit.com'], waitSeconds: 3, graceMinutes: 5 });
  for (const url of ['https://www.youtube.com/', 'https://www.facebook.com/', 'https://www.reddit.com/']) {
    const lp = await ctx.newPage();
    const errs = [];
    lp.on('console', (m) => { if (/trustedhtml|trusted types/i.test(m.text())) errs.push(m.text()); });
    lp.on('pageerror', (e) => { if (/trustedhtml|trusted types/i.test(e.message)) errs.push(e.message); });
    try {
      await lp.goto(url, { waitUntil: 'commit', timeout: 15000 });
      await lp.waitForSelector('#__ten-second-rule__', { state: 'attached', timeout: 5000 });
      await lp.waitForTimeout(800);
      const t = await lp.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return e && e.id; });
      ok(t === '__ten-second-rule__', `live ${url} overlay topmost`);
      await lp.waitForTimeout(3000);
      ok(!(await overlay(lp)), `live ${url} overlay gone`);
      ok(errs.length === 0, `live ${url} no Trusted Types errors`);
    } catch (e) { console.log(`LIVE-SKIP ${url}: ${e.message.split('\n')[0]}`); }
    await lp.close();
  }
} catch (e) { console.log('ERROR', e.message); fail++; }
await ctx.close();
console.log(fail ? `FAILED (${fail})` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
