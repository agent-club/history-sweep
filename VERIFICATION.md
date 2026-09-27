 # Verification — 0.3.0

Date: 2026-09-19.

- 14 Node tests passed: existing search semantics, translation key/placeholder parity, default English, translated variable messages.
- 61 isolated Chrome browser assertions passed: full page and popup, 124 synthetic matches, select-all beyond rendered rows, exclusions, cancellation, confirmed deletion, failure retention, verification failure messaging, language persistence, popup-to-tab query handoff, and bilingual website/privacy pages. The EN / 中文 segmented controls were checked for selected state, keyboard focus, preserved query/mode/selection/scroll, translated placeholder and confirmation, and disabling during a pending history operation.
- Extension viewport: full page 1280 × 800, popup 440 × 590. Website viewports: 1440 × 1000 and 390 × 1000; DPR 1. No horizontal overflow in tested states. Delete actions remain visible without scrolling in the tested extension viewports.
- Product screenshots and visual inspection covered English/Chinese extension views and the responsive website. All product screenshots contain synthetic fixture records.
- The popup was reimagined with built-in ImageGen and implemented against the saved visual target. The 1083 × 1453 source was normalized to 440 × 590 for a side-by-side full-view comparison. After one fix iteration, the count/selection summary is a single line, six result rows fit above the persistent action bar, passive status copy no longer consumes compact space, and the table header is absent from the popup. The project-root `design-qa.md` records `final result: passed`.
- UI icons use licensed Phosphor SVG assets with the license included in the extension bundle. No text glyphs, CSS drawings or raster placeholders are used for UI controls.
- Codex in-app browser verification covered EN/中文 switching, query entry, clear-search, localized unavailable-API feedback and the empty state; no console warnings or errors were present. The history API path remains covered by the 61 isolated browser assertions with synthetic data.
- The extension visual refresh now strictly approximates selected ImageGen option 3: the source three-slash mark, short brand divider, diagonal header rule, independent language controls, query clear divider, obsidian control zone, ivory result surface, celadon selection states and wine-red destructive action. Browser measurements verified the compact popup at 440 × 590: topbar y=0–64, search y=64–158, results y=158–526 and the persistent footer y=526–590. The query is 404 × 38px, the second row is 196px / 198px with a 10px gap, and the footer actions are 140px / 142px. The 1280 × 800 manager uses the same visual system. Existing 61 browser assertions passed again; history logic was unchanged.
- All required generated image dimensions were validated. The extension ZIP has manifest.json at its root and excludes tests, fixtures and developer tools. Website ZIP includes the matching extension download.
- Tested with installed Chrome through isolated Playwright contexts; no user browser profile or real history was accessed. The history API was mocked, so this does not replace native extension installation testing in a disposable Chrome profile.
- No Chrome Web Store submission, public website deployment, Git commit or Git push was performed.

Remaining on 2026-09-19 before Chrome Web Store submission: developer contact email, owner review of privacy text, native extension installation smoke test, store submission and review. The public site, support URL, domain, and hosting privacy information are configured.

## Update — 2026-09-24

- Fixed the Select all control so a second click deselects all matches. The button label and pressed state follow the selection; row clicks also toggle an individual match.
- Prevented deletion of results from an earlier search after the query or match mode changes. Opening the full page with a selection now explains that the selection will not transfer.
- Refined the 390px and 320px manager layouts, removed its duplicate Open full page action, improved muted-text contrast, and labelled both dialogs with their explanatory text.
- Regenerated English and Chinese product screenshots and packaged the updated extension and website download.
- 14 Node tests and 98 isolated browser assertions passed. A separate native smoke test loaded the unpacked extension in a disposable Chromium profile, read two local test visits through the real history API, and deleted only one selected local visit. The user's browser profile was not used.
- No Chrome Web Store submission, public website deployment, Git commit or Git push was performed.

Remaining before submission: developer contact email, owner review of privacy text, submission and review.


## Update — 2026-09-28

- Added localized accessible names to the popup and workspace search input and match-mode selector.
- Moved confirmed deletion and per-URL verification into a Manifest V3 service worker. Chrome 110+ is required because extension API calls reset the worker idle timer. No permissions were added.
- Workspace search conditions use a one-time, expiring in-memory handoff. The tab URL contains only a transient routing ID, removed on load, never the search words. Expired handoffs produce an explicit retry message.
- Updated bilingual UI, website, privacy policy and store copy to describe temporary background state and continued deletion when the UI closes. Tasks do not resume after Chrome exits, extension reloads or unexpected worker termination. Updated the suggested store category to Tools.
- 19 Node tests passed, including 100,000 selected URL deletions with an unselected URL preserved, failed deletion and verification, message sender isolation and one-use handoff expiry. These use synthetic APIs and do not establish real Chrome throughput.
- 111 isolated browser assertions passed with installed Chrome. A synthetic scan of 100,000 URLs completed in 97ms on this machine; initial rendering remained limited to 100 rows and cancellation made no deletion requests. This is a local measurement, not a cross-device guarantee.
- Native smoke passed using cached Chromium in a disposable profile. It verified real history APIs, deletion after the initiating extension UI was closed, preservation of unselected visits, and full-page query/mode transfer with a clean URL. The user's browser profile was not accessed.
- Website publication, store submission, developer contact email and dashboard privacy/account settings were not changed. Browser/OS coverage remains limited to this macOS host.
- Static evidence: AceLens resolved the existing deletion symbol and its references before editing, and a focused post-edit impact summary reported no risks. Its automatic workflow readiness score did not pass: it reported missing pre-edit outline and post-edit ordering records. No claim of complete static safety is made; the passing checks above are runtime, syntax and packaging evidence.


## Update — deletion after an unpacked extension update

- Reproduced newly updated page code with a stale manifest that has no service-worker registration in a disposable native Chromium profile. Confirming deletion cannot reach a receiver; it does not alter history.
- Missing receiver and invalidated extension-context errors now show localized instructions to reload History Sweep at chrome://extensions and reopen the UI. Other rejected requests and unknown operation states retain their existing messages. Selection is preserved and no automatic retry/deletion fallback is introduced.
- The reload instructions wrap in the compact popup and are verified fully visible in English and Simplified Chinese.
- 19 Node tests, 118 isolated browser assertions and the native normal/stale-manifest scenarios passed. No real browser profile or user history was accessed. The actual toolbar popup target was not exposed to Playwright; native assertions use the extension popup page in an isolated tab.


## Update — actual toolbar popup deletion

- The earlier attribution to an unloaded worker did not establish the cause in the actual toolbar popup. A real headed Chromium popup reproduced a distinct code defect: its runtime MessageSender omits documentId, frameId and tab, while an extension page loaded in a normal tab has documentId. The worker previously rejected the real popup before starting deletion.
- Fixed the worker owner check to support only trusted toolbar popup URLs without those fields, using a per-popup UUID kept in page memory to isolate job access. Extension tabs still use Chrome-supplied documentId; missing tab identity, foreign origins, subframes and other popup instance IDs remain rejected.
- Added test:toolbar, which attaches to the actual popup target through CDP in a visible disposable browser. The real popup now passes cancellation, confirmed deletion, unselected-visit preservation, deletion after popup closure and query/mode handoff without sensitive URL parameters.
- Changed the browser fixture to match real toolbar sender metadata instead of pretending the popup is a tab. Added a unit test for popup instance isolation and rejection of missing/invalid identity.
- 20 Node tests, 118 browser assertions, the existing native scenarios, the actual toolbar scenario and syntax checks passed. Tests used local synthetic history only; no user browser profile was accessed. Other operating systems were not tested.
