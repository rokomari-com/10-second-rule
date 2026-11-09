'use strict';

const DEFAULTS = {
  hosts: ['facebook.com', 'youtube.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com'],
  waitSeconds: 10,
  graceMinutes: 5
};

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    const cur = await chrome.storage.local.get(null);
    if (Object.keys(cur).length === 0) {
      await chrome.storage.local.set({
        config: { ...DEFAULTS },
        passes: {},
        stats: {}
      });
    }
  }
});

// Toolbar icon opens settings.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Serialize all stats/passes read-modify-write ops across tabs on one promise chain.
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const FIELDS = ['shown', 'completed'];
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return;
  if (typeof msg.key !== 'string' || !msg.key) return;
  let op;
  if (msg.type === 'bump' && FIELDS.includes(msg.field)) {
    op = async () => {
      const { stats = {} } = await chrome.storage.local.get('stats');
      const s = stats[msg.key] || { shown: 0, completed: 0 };
      s[msg.field] = (s[msg.field] || 0) + 1;
      stats[msg.key] = s;
      await chrome.storage.local.set({ stats });
    };
  } else if (msg.type === 'pass') {
    op = async () => {
      const { passes = {} } = await chrome.storage.local.get('passes');
      passes[msg.key] = Date.now();
      await chrome.storage.local.set({ passes });
    };
  } else return;
  enqueue(op).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true; // async response
});
