(() => {
  'use strict';
  // Idempotent guard: never run two gate instances in one page context.
  if (window.__tenSecondRuleLoaded) return;
  window.__tenSecondRuleLoaded = true;

  const DEFAULTS = { waitSeconds: 10, graceMinutes: 5 };
  let gateActive = false;

  // Input blockers installed synchronously at script start; no-op until a gate is active.
  const block = (e) => {
    if (!gateActive) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const blockOpts = { capture: true, passive: false };
  ['keydown', 'keypress', 'keyup'].forEach((n) => window.addEventListener(n, block, blockOpts));

  const host = location.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return;

  function matchHost(hosts) {
    for (const h of hosts) {
      if (host === h || host.endsWith('.' + h)) return h;
    }
    return null;
  }

  async function checkAndGate() {
    if (gateActive) return;
    let data;
    try {
      data = await chrome.storage.local.get(['config', 'passes']);
    } catch (e) {
      return; // extension context invalidated (e.g. after update)
    }
    if (gateActive) return;
    const cfg = data.config || {};
    const hosts = Array.isArray(cfg.hosts) ? cfg.hosts : [];
    const key = matchHost(hosts);
    if (!key) return;
    const waitSeconds = Number(cfg.waitSeconds) > 0 ? Number(cfg.waitSeconds) : DEFAULTS.waitSeconds;
    const graceMinutes = Number(cfg.graceMinutes) >= 0 ? Number(cfg.graceMinutes) : DEFAULTS.graceMinutes;
    const last = (data.passes || {})[key];
    if (typeof last === 'number' && Date.now() - last < graceMinutes * 60e3) return;
    showGate(key, waitSeconds);
  }

  // Writes go through the service worker (serialized across tabs); fall back to a direct write.
  async function send(msg, fallback) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (r && r.ok) return;
    } catch (e) { /* SW unavailable: fall through */ }
    try { await fallback(); } catch (e) { /* ignore */ }
  }
  const bump = (key, field) => send({ type: 'bump', key, field }, async () => {
    const { stats = {} } = await chrome.storage.local.get('stats');
    const s = stats[key] || { shown: 0, completed: 0 };
    s[field] = (s[field] || 0) + 1;
    stats[key] = s;
    await chrome.storage.local.set({ stats });
  });
  const writePass = (key) => send({ type: 'pass', key }, async () => {
    const { passes = {} } = await chrome.storage.local.get('passes');
    passes[key] = Date.now();
    await chrome.storage.local.set({ passes });
  });

  const STYLE = [
    'all:initial', 'display:block', 'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
    'margin:0', 'padding:0', 'border:0', 'max-width:none', 'max-height:none', 'overflow:hidden',
    'background:transparent', 'z-index:2147483647', 'visibility:visible', 'opacity:1',
    'pointer-events:auto', 'transform:none', 'clip-path:none', 'filter:none'
  ].map((d) => d + '!important').join(';');

  const CSS =
    ':host{all:initial}' +
    '.o{position:fixed;inset:0;background:#0b0b0f;color:#f2f2f5;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'user-select:none;cursor:default}' +
    '.n{font-size:min(30vw,260px);font-weight:200;line-height:1;font-variant-numeric:tabular-nums}' +
    '.t{margin-top:24px;font-size:22px;opacity:.7;letter-spacing:.02em}' +
    '.p{margin-top:12px;font-size:16px;opacity:.5;min-height:1.2em}';

  function showGate(key, waitSeconds) {
    gateActive = true;
    const supportsPopover = 'popover' in HTMLElement.prototype && typeof HTMLElement.prototype.showPopover === 'function';

    const root = document.createElement('ten-second-gate');
    root.id = '__ten-second-rule__';
    root.setAttribute('style', STYLE);
    if (supportsPopover) root.popover = 'manual';
    const shadow = root.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const o = document.createElement('div'); o.className = 'o';
    const num = document.createElement('div'); num.className = 'n';
    const txt = document.createElement('div'); txt.className = 't'; txt.textContent = 'Is this worth it?';
    const pausedLine = document.createElement('div'); pausedLine.className = 'p';
    o.append(num, txt, pausedLine);
    shadow.append(style, o);

    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.appendChild(root);
    // Scroll blockers are non-passive, so only live while a gate is up.
    ['wheel', 'touchmove'].forEach((n) => window.addEventListener(n, block, blockOpts));

    // Keep overlay on top of the top layer (page popovers re-raise via the toggle listener).
    const raise = (force) => {
      if (!root.isConnected || !supportsPopover) return;
      try {
        if (!root.matches(':popover-open')) { root.showPopover(); return; }
        if (force) { root.hidePopover(); root.showPopover(); }
      } catch (e) { /* ignore */ }
    };
    raise(false);
    const onToggle = (e) => { if (e.target !== root) raise(true); };
    document.addEventListener('toggle', onToggle, true);

    // Media: pause everything now and whenever something tries to play.
    const pauseIn = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if (el instanceof HTMLMediaElement) { try { el.pause(); } catch (e) { /* ignore */ } }
        if (el.shadowRoot) pauseIn(el.shadowRoot); // open shadow roots only
      }
    };
    const pauseAll = () => pauseIn(document);
    const onPlay = (e) => { if (e.target instanceof HTMLMediaElement) { try { e.target.pause(); } catch (err) { /* ignore */ } } };
    pauseAll();
    document.addEventListener('play', onPlay, true);
    document.addEventListener('playing', onPlay, true);

    // Restore overlay if the page detaches it or tampers with its attributes.
    const reattach = () => { if (root.parentNode !== document.documentElement) document.documentElement.appendChild(root); };
    const mo = new MutationObserver(() => {
      reattach();
      if (root.getAttribute('style') !== STYLE) root.setAttribute('style', STYLE);
      if (supportsPopover && root.popover !== 'manual') root.popover = 'manual';
      raise(false);
    });
    mo.observe(document.documentElement, { childList: true });
    mo.observe(root, { attributes: true });

    // Countdown accumulates only time the tab is visible, non-prerendering and focused.
    const need = waitSeconds * 1000;
    let acc = 0, last = Date.now(), wasVis = false, shownCounted = false;
    const isVis = () => document.visibilityState === 'visible' && !document.prerendering && document.hasFocus();
    const step = () => {
      const now = Date.now();
      const v = isVis();
      if (v && wasVis) acc += Math.min(Math.max(now - last, 0), 2000);
      wasVis = v;
      last = now;
      if (v && !shownCounted) { shownCounted = true; bump(key, 'shown'); }
      const msg = v ? '' : 'paused, come back to continue';
      if (pausedLine.textContent !== msg) {
        pausedLine.textContent = msg;
        if (v) root.removeAttribute('data-paused'); else root.setAttribute('data-paused', '');
      }
      const left = Math.max(0, Math.ceil((need - acc) / 1000));
      num.textContent = String(left);
      return left;
    };
    const onVis = () => step();
    const resetClock = () => { wasVis = false; last = Date.now(); step(); };
    const onFocusChange = resetClock;
    window.addEventListener('focus', onFocusChange);
    window.addEventListener('blur', onFocusChange);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('prerenderingchange', onVis);
    window.addEventListener('pageshow', resetClock);
    const onFreeze = () => { wasVis = false; };
    document.addEventListener('freeze', onFreeze);
    step();

    const timer = setInterval(() => {
      reattach();
      pauseAll();
      if (step() > 0) { raise(false); return; }
      clearInterval(timer);
      mo.disconnect();
      document.removeEventListener('toggle', onToggle, true);
      document.removeEventListener('play', onPlay, true);
      document.removeEventListener('playing', onPlay, true);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('prerenderingchange', onVis);
      window.removeEventListener('pageshow', resetClock);
      window.removeEventListener('focus', onFocusChange);
      window.removeEventListener('blur', onFocusChange);
      document.removeEventListener('freeze', onFreeze);
      ['wheel', 'touchmove'].forEach((n) => window.removeEventListener(n, block, blockOpts));
      try { if (supportsPopover && root.matches(':popover-open')) root.hidePopover(); } catch (e) { /* ignore */ }
      root.remove();
      document.documentElement.style.overflow = prevOverflow;
      writePass(key);
      bump(key, 'completed');
      gateActive = false;
    }, 250);
  }

  checkAndGate();
  // bfcache restore: page state is frozen; re-check grace, guard prevents duplicates.
  window.addEventListener('pageshow', (e) => { if (e.persisted) checkAndGate(); });
  // SPA navigation needs no handling: grace covers it, and the script never re-runs.
})();
