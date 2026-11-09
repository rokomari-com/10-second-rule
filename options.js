'use strict';
const DEFAULTS = {
  hosts: ['facebook.com', 'youtube.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com'],
  waitSeconds: 10,
  graceMinutes: 5
};
const FRICTION_SECONDS = 30;
const $ = (id) => document.getElementById(id);
let cfg = { ...DEFAULTS };
let stats = {};
let pendingTimer = null;

function normCfg(c) {
  const out = { ...DEFAULTS, ...(c || {}) };
  if (!Array.isArray(out.hosts)) out.hosts = [...DEFAULTS.hosts];
  return out;
}

// Always read fresh from storage; never trust the in-memory snapshot for decisions or writes.
async function getCfg() {
  const d = await chrome.storage.local.get('config');
  return normCfg(d.config);
}

// Read-modify-write of config: mutator receives a fresh copy and changes only its field.
async function updateCfg(mutator) {
  const fresh = await getCfg();
  mutator(fresh);
  await chrome.storage.local.set({ config: fresh });
  cfg = fresh;
}

async function load() {
  const d = await chrome.storage.local.get(['config', 'stats']);
  cfg = normCfg(d.config);
  stats = d.stats || {};
}

function normalizeHost(s) {
  s = String(s).trim().toLowerCase();
  if (!s) return '';
  try { s = new URL(s.includes('://') ? s : 'http://' + s).hostname; } catch (e) { return ''; }
  s = s.replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(s) && s.includes('.') ? s : '';
}

function render() {
  const ul = $('hosts');
  ul.textContent = '';
  for (const h of cfg.hosts) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = h;
    const b = document.createElement('button');
    b.textContent = 'Remove';
    b.dataset.host = h;
    b.className = 'rm';
    b.addEventListener('click', () => removeHost(h));
    li.append(span, b);
    ul.append(li);
  }
  if (document.activeElement !== $('wait')) $('wait').value = cfg.waitSeconds;
  if (document.activeElement !== $('grace')) $('grace').value = cfg.graceMinutes;
  renderStats();
}

function renderStats() {
  const tb = $('stats');
  tb.textContent = '';
  const keys = Object.keys(stats).sort();
  for (const k of keys) {
    const s = stats[k] || {};
    const shown = s.shown || 0, done = s.completed || 0;
    const tr = document.createElement('tr');
    const cells = [k, shown, done, shown ? Math.round((done / shown) * 100) + '%' : '-'];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      if (i) td.className = 'num';
      td.textContent = v;
      tr.append(td);
    });
    tb.append(tr);
  }
  if (!keys.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4; td.textContent = 'No data yet.';
    tr.append(td); tb.append(tr);
  }
}

function say(t) { $('msg').textContent = t; }

// Run `apply` after a 30s in-page countdown; cancel aborts. Closing page aborts implicitly.
function withFriction(description, apply) {
  if (pendingTimer) { say('Another change is pending. Cancel it or wait for it to finish first.'); return; }
  say('');
  const modal = $('modal');
  $('mtext').textContent = description;
  const end = Date.now() + FRICTION_SECONDS * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    $('mcount').textContent = String(left);
    return left;
  };
  tick();
  modal.classList.add('on');
  const finish = () => { clearInterval(pendingTimer); pendingTimer = null; modal.classList.remove('on'); };
  pendingTimer = setInterval(async () => {
    if (tick() > 0) return;
    finish();
    try { await apply(); } catch (e) { say('Could not save: ' + (e && e.message || e)); } // apply re-reads config itself
    render();
  }, 250);
  $('mcancel').onclick = () => { finish(); say('Cancelled.'); };
}

async function removeHost(h) {
  const fresh = await getCfg();
  if (!fresh.hosts.includes(h)) { cfg = fresh; render(); return; }
  withFriction('Stop gating ' + h + '?', () => updateCfg((c) => { c.hosts = c.hosts.filter((x) => x !== h); }));
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const h = normalizeHost($('newHost').value);
  if (!h) { say('Enter a valid host like example.com'); return; }
  await updateCfg((c) => { if (!c.hosts.includes(h)) c.hosts.push(h); });
  $('newHost').value = '';
  say('');
  render();
});

function readInt(id, min) {
  const v = Math.floor(Number($(id).value));
  return Number.isFinite(v) && v >= min ? v : null;
}

$('saveWait').addEventListener('click', async () => {
  const v = readInt('wait', 1);
  if (v === null) { say('Wait must be at least 1 second.'); return; }
  const fresh = await getCfg();
  cfg = fresh;
  if (v === fresh.waitSeconds) { render(); return; }
  if (v < fresh.waitSeconds) {
    withFriction('Lower wait from ' + fresh.waitSeconds + 's to ' + v + 's?', () => updateCfg((c) => { c.waitSeconds = v; }));
  } else { await updateCfg((c) => { c.waitSeconds = v; }); say('Saved.'); render(); }
});

$('saveGrace').addEventListener('click', async () => {
  const v = readInt('grace', 0);
  if (v === null) { say('Grace must be 0 or more minutes.'); return; }
  const fresh = await getCfg();
  cfg = fresh;
  if (v === fresh.graceMinutes) { render(); return; }
  if (v > fresh.graceMinutes) {
    withFriction('Raise grace from ' + fresh.graceMinutes + ' to ' + v + ' minutes?', () => updateCfg((c) => { c.graceMinutes = v; }));
  } else { await updateCfg((c) => { c.graceMinutes = v; }); say('Saved.'); render(); }
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.stats) stats = ch.stats.newValue || {};
  if (ch.config) { cfg = normCfg(ch.config.newValue); render(); } else if (ch.stats) renderStats();
});

load().then(render);
