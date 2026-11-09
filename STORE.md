# Chrome Web Store: permission justifications

## Host permissions (content script on `<all_urls>`)
10 Second Rule shows a countdown overlay on sites the user chooses to gate. The list of gated sites is user-configurable at runtime (options page), so the set of hosts cannot be known at publish time. The content script therefore must be able to load on any page; on load it reads the local host list and exits immediately unless the current hostname matches. It reads no page content, makes no network requests, and sends no data off-device. All settings and stats stay in `chrome.storage.local`.

## storage
Stores the user's host list, wait/grace settings, grace-period timestamps, and local usage counters.
