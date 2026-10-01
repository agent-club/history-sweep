# History Sweep

A local-first Chrome extension for searching and clearing browsing history in batches, with an English / Simplified Chinese interface and a matching bilingual website.

## Layout
- extension/ — load this directory in Chrome; includes popup, full workspace, shared UI, translations, and icons.
- site/ — deployable static website and privacy page. No backend, analytics, remote fonts, or build framework.
- store/ — listing copy, submission notes, icons, screenshots, and promotional images.
- scripts/ — local preview server, synthetic-data screenshots, browser verification, and packaging.
- tests/ — localization checks; extension/tests/ contains search matching tests.
- dist/ — generated upload ZIP and deployment ZIP (ignored by Git).

## Install locally
Open chrome://extensions, enable Developer mode, choose Load unpacked, and select extension/. Pin History Sweep to the toolbar.
If upgrading from the old project, remove/unload the old unpacked entry first or select this new extension directory. No browsing data is changed by installing.
After updating unpacked files, especially manifest.json or background.mjs, click Reload for History Sweep at chrome://extensions. Close existing popup/workspace views and reopen the extension before trying again.

For Chrome Web Store installs, Chrome downloads updates automatically. A ready update appears as a compact banner with an Update action; deletion and verification must finish before reloading. The banner drops into place once, respects reduced motion, and can be dismissed for the current view. Updating reloads the extension and clears the current in-memory selection; reopen it afterward.

Run `node scripts/preview-update.mjs` to inspect the banner animation at http://127.0.0.1:4190/design/update-preview/ using synthetic history and simulated update notifications.

## Website preview
Run npm run dev and open http://127.0.0.1:4173/site/.
The default interface language is English, regardless of browser locale. The language picker remembers a manual choice.
The hero includes a silent, nine-second Remotion feature film in both languages. It plays once while visible, supports pause/replay and chapter navigation, and stays on its poster when reduced motion is enabled. Run `npm run render:opening` to regenerate the MP4s and posters from `remotion/` (uses local Google Chrome; override with `HISTORY_SWEEP_CHROME`). Rendering is a development step; the published site serves static video files without a React runtime.
A file:// preview is not recommended because ES modules require a suitable origin.

## Development
Requires Node.js 22+ and zip on PATH.
Run npm install, then npx playwright install chromium for isolated browser verification.
- npm test — search and translation tests.
- npm run assets — generate icons and product/store screenshots from synthetic data.
- npm run test:browser — test search, bulk selection, cancellation, deletion, failures, localization, popup handoff and responsive website.
- npm run test:site — check bilingual desktop/mobile layouts, downloads, film playback, chapter navigation, language switching, and reduced motion in an isolated browser.
- npm run test:features — test time filters, deletion previews, kept websites, cross-window updates and the current-website entry using synthetic history.
- npm run test:native — load the unpacked extension in a disposable Chromium profile and verify its real history permission, selection and deletion against local test pages.
- npm run test:toolbar — open a visible disposable Chromium window and exercise the actual toolbar popup, including its distinct message sender metadata, cancellation, deletion after popup close and full-page handoff.
- npm run build — create extension and website ZIP files, validate asset sizes, and include the extension download on the site.

Optional environment variables:
- HISTORY_SWEEP_NODE_MODULES: alternate directory containing playwright and sharp.
- HISTORY_SWEEP_CHROME: path to an installed Chrome executable for isolated headless tests.
- HISTORY_SWEEP_CHROMIUM: path to a Chromium executable that supports loading unpacked extensions for the native smoke test.
- PORT: local preview port (default 4173).

`test:browser` uses a temporary browser context with an injected in-memory history API. `test:native` loads the real extension API in a disposable browser profile and creates only local test visits. Neither test attaches to the user's browser profile.

## Behavior and limits
Chrome permissions are history (search and delete), activeTab (the user-invoked current website or in-page modal), scripting (inserting the modal host when that opening method is chosen), contextMenus (the website right-click entry), and storage (kept website rules and opening preference saved only on this device). Search results and brief background deletion/handoff state stay in memory; language preference stays in localStorage. Popup-to-workspace search conditions, including date filters, use a one-time in-memory handoff, never URL query parameters. No history upload, account, tracking or remote code.
Time filters match each URL's last visit using local calendar dates, with both custom endpoint dates included. A time filter can be used without a keyword. Deleting a selected URL still removes all of its visits, including visits outside the filter; the confirmation previews selected URLs by website and repeats this warning. Kept-domain rules include subdomains, are checked again by the worker, and cannot be changed while a deletion is running. The popup's current-website button and the page right-click entry start exact-host searches with no automatic selection or deletion.
Each scan reads up to 100,000 URLs and displays a cap notice. Smart matching uses exact hostname labels for ASCII site terms, domain matching for full domains, and title/URL text for non-ASCII terms. Existing search semantics are preserved.
Select all covers every matching result, including rows outside the current render window. Confirmed deletion runs in an extension service worker and continues when the popup or workspace closes. Keep Chrome running; reopen and search to review the result. Worker state is in memory, so tasks do not resume after Chrome exits, extension reloads, or unexpected worker termination. Chrome 110+ is required because extension API calls keep an active worker alive.
Deleting a URL removes all visits and may propagate through Chrome sync. Deletion needs explicit confirmation; completion is checked per selected URL.

## Release
Workspace version: 0.3.2. The website is deployed at https://sweep.agentclub.dev; the extension is listed on the Chrome Web Store.
Read store/submission.md for the ready-to-use fields, assets, and remaining owner-supplied details.
Public support: https://github.com/agent-club/history-sweep/issues. The site privacy page documents Cloudflare hosting. Version 0.3.2 is saved as a store draft; see store/submission.md for the verified submission status.
No license grant is assumed; add the owner's chosen license before public source distribution.
