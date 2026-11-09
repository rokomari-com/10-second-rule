# 10 Second Rule
Friction gate: a full-screen 10-second countdown ("Is this worth it?") before time-waste sites load. After it finishes, a 5-minute grace period applies per site.
1. Open `chrome://extensions`, enable Developer mode.
2. Click "Load unpacked" and pick this folder.
3. Click the toolbar icon (or Details > Extension options) to edit sites, wait time, grace, and see stats.
4. Weakening settings (remove site, shorter wait, longer grace) requires a 30-second in-page wait.
Tests: `cd test && npm i && node smoke.mjs`. All data stays local; see PRIVACY.md.

Known limitation: the overlay is injected after an async storage read, so page content may flash for a few ms (<10ms typical) before it appears. A leaner fix (`chrome.scripting.registerContentScripts` with per-host CSS) is deferred.
