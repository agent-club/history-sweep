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

## Website preview
Run npm run dev and open http://127.0.0.1:4173/site/.
The default interface language is English, regardless of browser locale. The language picker remembers a manual choice.
A file:// preview is not recommended because ES modules require a suitable origin.

## Development
Requires Node.js 22+ and zip on PATH.
Run npm install, then npx playwright install chromium for isolated browser verification.
- npm test — search and translation tests.
- npm run assets — generate icons and product/store screenshots from synthetic data.
- npm run test:browser — test search, bulk selection, cancellation, deletion, failures, localization, popup handoff and responsive website.
- npm run build — create extension and website ZIP files, validate asset sizes, and include the extension download on the site.

Optional environment variables:
- HISTORY_SWEEP_NODE_MODULES: alternate directory containing playwright and sharp.
- HISTORY_SWEEP_CHROME: path to an installed Chrome executable for isolated headless tests.
- PORT: local preview port (default 4173).

The test harness uses a temporary browser context and an injected in-memory history API. It never attaches to the user's browser profile or operates on real history.

## Behavior and limits
The only Chrome permission is history. Search results stay in memory, language preference stays in localStorage. No history upload, account, tracking or remote code.
Each scan reads up to 100,000 URLs and displays a cap notice. Smart matching uses exact hostname labels for ASCII site terms, domain matching for full domains, and title/URL text for non-ASCII terms. Existing search semantics are preserved.
Select all covers every matching result, including rows outside the current render window. Closing the popup during an operation may interrupt it; keep the window open until completion or use the full page.
Deleting a URL removes all visits and may propagate through Chrome sync. Deletion needs explicit confirmation; completion is checked per selected URL.

## Release
Current version: 0.3.0, pre-release. The website is deployed at https://sweep.agentclub.dev; the extension has not been submitted to or listed on the Chrome Web Store.
Read store/submission.md for the ready-to-use fields, assets, and remaining owner-supplied details.
Public support: https://github.com/agent-club/history-sweep/issues. The site privacy page documents Cloudflare Pages hosting; the Chrome Web Store developer contact email still needs to be supplied in the dashboard.
No license grant is assumed; add the owner's chosen license before public source distribution.
