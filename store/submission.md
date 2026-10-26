# Chrome Web Store submission pack

## Prepared update — v0.6.0

Use [the v0.6.0 release materials](v0.6.0-candidate.md), the current bilingual listing copy and versioned screenshots in `store/assets/v0.6.0/`. The package, website download, update metadata and release notes all target 0.6.0. Both release-note surfaces preset Published as requested by the owner; website deployment and store submission have not been performed in this preparation.

## Last verified public release — v0.5.0

Prepare the existing store item for v0.5.0: frequency browsing and defaults from [#8](https://github.com/agent-club/history-sweep/issues/8), completed local improvements, and WebDAV configuration sync plus encrypted disk recovery from [#14](https://github.com/agent-club/history-sweep/issues/14), explicitly included by the user on October 22, 2026. See [the candidate copy, privacy fields and package status](v0.5.0-candidate.md).

The historical v0.5.0 task authorized Chrome Web Store publication, Git commit/push and website/privacy deployment. Those receipts describe that release and do not establish authorization for v0.6.0 external actions.

The owner submitted the update on October 22, 2026. The existing item's Status page was directly verified as **Pending review** (“This draft is pending review.”). Website/privacy deployment, package upload, bilingual listing/privacy fields and screenshots are complete. That is the historical submission receipt. On October 25, 2026, the public [Chrome Web Store listing](https://chromewebstore.google.com/detail/bbccfejdhhcjmpfagjckiikgllpojhgm) showed version **0.5.0**, an **Add to Chrome** action and an October 23, 2026 update date. The store listing is the source of truth for the public version; the exact approval or publication timestamp is not inferred. The exact package checksum and validation are recorded in the linked v0.5.0 materials.

v0.4.0 is already published: [release checklist #6](https://github.com/agent-club/history-sweep/issues/6) records public release verification on October 20, 2026, confirmed again by the user and the developer dashboard on October 22. Exact submission, approval and publication timestamps are not inferred from the store’s updated date.

## Historical v0.4.0 preparation

The package sizes, checksums and checks below describe the October 18 preparation. They are retained as historical evidence and do not describe the v0.5.0 package.

## Release scope and deferred development

[Issue #14](https://github.com/agent-club/history-sweep/issues/14) adds WebDAV settings, manual configuration transfer and encrypted disk recovery to the local development source. It remains unassigned and is **excluded from v0.4.0**. `npm run build` stages the release without changing that source: it excludes the five sync/configuration files and the Preferences link, removes `options_ui` and optional HTTPS host permissions, and sets `connect-src` to `none` in the archived v0.4.0 package. The current v0.5.0 build includes sync and optional HTTPS permissions instead. Reserved, unused translation strings remain in the package. See [configuration sync and disk recovery](../docs/config-sync.md) for the development feature's data scope and persistence limits.

The v0.4.0 candidate includes the current activity panel and daily website summaries, single-row and batch deletion feedback, deletion-successor expansion, date/website grouping, recent-history refresh, and light/dark/automatic appearance. The default browse window remains the last three local calendar days. The planned frequency view, one-week default and website classification are excluded. The October 18 preparation recorded authorization for the v0.4.0 commit/push, Chrome Web Store submission and website deployment, excluding a GitHub Release. Current v0.5.0 authorization is stated above.

Prepared locally on 2026-10-16; UI and package refreshed on 2026-10-17 and release archives/screenshots refreshed on 2026-10-18. The pending-submission status recorded during that preparation is superseded by the published-release verification above; it is not the current store state.

## Official update channel — v0.5.0 preparation

The store-installed extension checks `https://sweep.agentclub.dev/extension-updates.json` when a popup, workspace or modal opens, with a shared 15-minute cooldown and a five-second website timeout. A newer version hint invokes `chrome.runtime.requestUpdateCheck()`; only Chrome-confirmed downloaded versions enable the existing Update button. Deletion and verification in any open view block reload. Chrome throttling, offline failures and missing metadata leave history operations available. No downloaded script or ZIP is executed by the extension.

`site/extension-updates.json` is independent of the manifest and build version. The October 22 deployment used `0.4.0` while v0.5.0 awaited review; the October 25 public verification supported `0.5.0`. For the current preparation, the owner explicitly requested `0.6.0` without waiting for website deployment. The local file and website archive therefore use `0.6.0`. This does not establish the live endpoint value or store availability. Preserve `site/_headers` for public CORS and no-store caching; verify those headers after an authorized deployment.

Reproduce update-specific checks with `node --test tests/update-check.test.mjs tests/background.test.mjs` and `node scripts/verify-updates.mjs`. The latter uses disposable Chrome profiles and synthetic metadata/store responses to verify opening, task guards, native CORS and the release CSP. It does not prove a signed store upgrade; verify that separately with a previous store-installed build after publishing. Existing installed versions need to receive this implementation through Chrome’s normal update cycle once before they can use the faster check.

## Package and validation

- Upload candidate: `dist/history-sweep-0.4.0.zip` (168811 bytes; 60 files).
- SHA-256: `f22d5226fc0e0d09294ac684a02d127b2268501d022aeabda886ed6fe8d3dfa8`.
- Website candidate: `dist/history-sweep-site-0.4.0.zip` (11792100 bytes; 61 files), SHA-256 `0ee255791b6559a132ed5b7214148c6d1bdf9d2e1376ce5deafaf37582801cd2`.
- Both ZIPs open successfully. The extension manifest is at the root, version 0.4.0, with exactly history, activeTab, scripting, contextMenus, storage and favicon permissions. No host permissions or configuration-sync entry are shipped.
- `npm test`: 75 source unit tests passed on 2026-10-18, including the deferred development feature's tests. This does not put that feature in the release.
- `npm run test:packages`: 120 packaged-file comparisons passed, including the two documented manifest/view transformations. The `dist` ZIP, website download and extension ZIP nested in the website archive are byte-identical. The complete website tree includes the current homepage modules, styles, fonts and media.
- Tests ran against the extracted release archives: 101 release assertions, 355 website assertions, 68 deletion-expansion assertions, native history/background deletion, real modal/popup/manager theme switching, persisted activity summaries after browser restart, 5 native row-animation assertions and 13 native batch-animation assertions passed. Browser profiles and browsing data were synthetic and isolated. Minimum Chrome 110 and other operating systems were not tested in this refresh.
- Three 1280×800 RGB PNG store screenshots were refreshed from the actual release ZIP on 2026-10-18 and visually checked: English date view, Chinese website view, and English popup. They use 12 synthetic pages served entirely in memory and show an unselected exception. No existing browser profile or real browsing data was used.
- Screenshot reproduction: `npm run assets:store` after building. Package verification: `npm run test:packages`. Set `HISTORY_SWEEP_CHROME` and `HISTORY_SWEEP_CHROMIUM` to an installed compatible Chrome for Testing executable when the Playwright browser is unavailable.
- Image dimensions and screenshot requirements were rechecked against the official [Chrome Web Store image guidance](https://developer.chrome.com/docs/webstore/images) on 2026-10-18. The screenshot refresh does not confirm any dashboard upload or acceptance.
- Historical checks before this refresh: 52 feature, 60 grouping, 65 autocomplete, 72 row-action, 106 extension-browser assertions and the native toolbar-popup check passed. These are not claimed as rerun on October 18. The old general verification script's website image-loading result is superseded for this candidate by the 355 assertions against the extracted website ZIP.
- UI polish: 93 layout assertions passed across popup, full page, modal and narrow viewports in both languages. Core (106), release behavior (101), row actions (72) and unit tests (55) were rerun on 2026-10-17.
- The installed local v0.4.0 extension was reloaded in Chrome; the store v0.3.2 copy remains disabled.

The favicon permission is used only to show a 16px website icon in each website group heading (both date and website views), using Chrome’s `_favicon` endpoint. Icons are decorative; failed loads are hidden. No external favicon service is used, and favicon resources are not exposed through web_accessible_resources. Real-extension and controlled failure/layout checks passed (59 assertions, disposable profile and synthetic data only).

A live-history refresh regression was fixed on 2026-10-17: idle views re-read after visits, removals, focus/visibility return and local midnight. Relative windows are recalculated; edits, selections and open confirmation dialogs defer automatic refresh. 39 synthetic freshness assertions and 101 release assertions passed; real Chrome onVisited/selection-deferral checks also passed in a disposable profile.

Grouping controls were corrected on 2026-10-17: date expand-all includes nested websites, compact layouts keep the expand/collapse label visible, and view changes reset result scrolling. Validation: 74 grouping assertions, 93 layout assertions, 101 release assertions, and trusted mouse input in a real toolbar popup using a disposable profile.

Search-button feedback added on 2026-10-17: a subtle 7.2-second idle sweep plus a 520ms click/keyboard ripple. Idle motion pauses while disabled or hidden; reduced-motion preferences suppress both effects. Searches do not wait for animation. Validation: 49 search-motion assertions and 101 release assertions passed with synthetic data.

Appearance switching corrected on 2026-10-17: the real modal entry was missing theme initialization, leaving its icon unresponsive. modal.mjs now loads theme.js after its trusted launch claim and before rendering the application. The header icon opens Automatic / Light / Dark choices with the current preference marked; Automatic can be restored after a manual choice. Preferences persist locally and synchronize across extension views. Validation: 98 theme assertions, 101 release assertions, 3 locale checks and a real-extension modal/popup/manager regression in a disposable profile passed. The native regression covers the previously missing modal entry point, system changes, cross-view synchronization, persistence and dismissal of the appearance menu from the host backdrop.

## Release notes (English)

- Review local cleanup and retained-history activity by year or three months. Verified cleanup totals and daily hostname/title/last-visit summaries stay on this device; complete deleted URLs are not retained.
- Remove one row without replacing an existing batch selection. Verified deletion uses interruptible visual feedback and expands the next surviving group where appropriate.
- Choose Automatic, Light or Dark from the header appearance icon; remember and synchronize the choice across extension views.

- Keep idle results current across local midnight and new history events; defer automatic replacement while editing, selecting or confirming.
- Browse the last three local calendar days immediately. Empty searches follow the same default, while explicit date ranges are honored. No automatic lookback when recent history is empty.
- Switch between date and website summaries over the same results. Page and website counts are shown, with URL selection preserved across views.
- Click outside help, filters or Preferences to dismiss them. Nested calendars close first, preserving the filter and main modal. Unsaved Preferences choices are cancelled.

- Recognize websites by their Chrome-provided icons in group headings, without repeating them on page rows.
- Clearer results hierarchy, aligned date context and compact view/selection controls. At 440×590, the result viewport grows from 164px to 218px.

## Reviewer steps for v0.4.0

1. In a disposable browser profile, visit test pages today and on earlier dates, then open History Sweep. Today, yesterday and the day before yesterday are the default range; nothing is automatically selected.
2. Submit an empty or whitespace query. Choose a custom range and repeat with no keyword; only that explicit range should be used.
3. Switch between By date and By website. Select a website or day, switch again and verify the URL selection is preserved. Counts are unique pages based on last visit, not counts of individual visit events.
4. Open custom-date filters and the calendar. Click outside once to close only the calendar, then again to close the filter. Repeat from the backdrop outside the in-page modal. Check internal controls do not dismiss their layer.
5. Change a Preferences radio choice, dismiss via backdrop and reopen: the saved choice must remain. Save a new preference separately to verify explicit saving.
6. Review selected URLs before deleting. Cancel must delete nothing; a confirmed deletion removes every visit to the selected URLs, including visits outside the filter range.
7. Select several rows, then use another row's trash button. Cancel leaves every row untouched; confirming removes only that row and keeps the other batch choices. Verify the completion and group-expansion behavior with motion enabled and reduced motion.
8. Open local activity. Check the verified cleanup totals and daily website summary, then reopen the browser to verify persistence. Existing retained-history counts use URL last-visit dates, not individual visit-event frequency.
9. Confirm Preferences has no configuration-sync entry and the packaged manifest requests no optional host access. Sync and encrypted recovery remain development-only.

## Store state and remaining actions

The existing item is `bbccfejdhhcjmpfagjckiikgllpojhgm`; update that item rather than creating another listing. Listing copy is in `listing-en.md` and `listing-zh-CN.md`. Initial recent-history browsing uses the existing history permission and remains local; website group icons use the new favicon permission and Chrome’s extension-origin favicon endpoint. There are no third-party icon requests. Version metadata requests are described below.

Before submitting, check the live dashboard version and current listing/privacy fields. The prepared package and field values are reviewable locally. Actual submission time, review result and publication time remain unset. Use deferred/manual publication for the agreed weekly release cadence; approval and timing must be observed in the dashboard.

Official guidance rechecked on 2026-10-16: [publishing and deferred publication](https://developer.chrome.com/docs/webstore/publish), [history API semantics](https://developer.chrome.com/docs/extensions/reference/api/history).

---

# Historical submission record — v0.3.2

Historical reference only. Use [the v0.5.0 candidate materials](v0.5.0-candidate.md) for current copy, permissions and data practices.

The following is the prior record, not the current v0.4.0 dashboard state.

Status: existing item is Published — public, version 0.3.1, verified in the dashboard on 2026-10-01. The dashboard has accepted the 0.3.2 draft package with all five permissions. English and Chinese listing text, screenshots, permission justifications, and test instructions are saved. Submission is at the final publication-mode choice; it is not yet in review.

Package SHA-256: `8a8707c5357123fabd61ece095e02705eeadf2f0b4f69c40a1bb78432a2c3fc7`.

Validation: 52 unit tests, 52 feature assertions, 65 suggestion assertions, native extension and toolbar checks, and 114 website assertions passed. ZIP contents match the packaged source. The website and version 0.3.2 privacy policy are deployed and the public policy was checked after deployment.

Existing item ID: bbccfejdhhcjmpfagjckiikgllpojhgm. Update this item rather than creating a new listing.

## Files
- Upload package: dist/history-sweep-0.3.2.zip. manifest.json is at the ZIP root.
- Listing copy: listing-en.md and listing-zh-CN.md.
- Store icon: assets/icon-128.png (128 × 128, transparent padding).
- Small promotional tile: assets/promo-small-440x280.png (required).
- Marquee: assets/promo-marquee-1400x560.png (optional).
- English screenshots: assets/screenshot-workspace-en-1280x800.png and assets/screenshot-popup-1280x800.png.
- Chinese screenshot: assets/screenshot-workspace-zh-1280x800.png.
- Privacy policy source: site/privacy.html (bilingual, deployed at the public privacy URL).

## Suggested listing fields
Name: History Sweep
Primary language: English
Category: Tools (工具); confirm the closest current dashboard category.
Website URL: https://sweep.agentclub.dev/
Privacy URL: https://sweep.agentclub.dev/privacy
Support URL: https://github.com/agent-club/history-sweep/issues
Developer contact email: existing account settings were preserved; the dashboard allows submission. Account contact verification was not separately audited.
Do not invent store URLs, publisher identity, ratings, installation counts, or approval status.

## Single purpose (paste-ready)
Help users search, review, select, and delete their Chrome browsing history in batches.

## history permission justification (paste-ready)
History Sweep uses chrome.history.search to provide local search suggestions and display history matching the user's query, chrome.history.deleteUrl to remove only URLs explicitly selected and confirmed by the user, and chrome.history.getVisits in its service worker to verify deletion. The worker continues confirmed operations when the popup closes; it does not recover tasks after Chrome exits. Processing happens locally. Browsing history is not transmitted to the developer or any third party.

## Remote code justification
No remotely hosted code. JavaScript, styles, translations, and icons are included in the extension package. The extension has no persistent host permissions, no analytics, and a connect-src policy limited to https://sweep.agentclub.dev. That origin serves only JSON version metadata to this feature; all update code is downloaded and installed by Chrome from the Chrome Web Store.

## Additional permission justifications (paste-ready)
- activeTab: Provides temporary access after the user invokes the extension, to read the current website URL for an exact-host search or display the user-selected in-page modal. No page content is collected.
- scripting: Inserts only the local modal host after a toolbar action when the user has selected the in-page modal opening method. It does not read page content.
- contextMenus: Adds a page right-click entry that opens the selected website's history search for review. It never deletes automatically.
- storage: Saves user-entered kept-domain rules and the opening preference in chrome.storage.local, on this device only. Rules exclude matching domains and subdomains from selection and are rechecked before deletion. Temporary modal authorization metadata uses chrome.storage.session. Local cleanup activity stores daily counts and one hostname/title/last-visit summary per website/day, without complete deleted URLs.

## Data practices to disclose accurately
- Accessed locally: browsing history URLs, titles, visit counts, last visit times, and the URL of the website for a user-invoked website search.
- Local memory: current search results, local Worker suggestion indexes and selections, one-time search handoffs, and confirmed deletion queues. Completed queue results are released by the page or discarded within 60 seconds; worker termination discards them sooner. These queues do not persist complete URLs.
- Persisted locally: language preference (localStorage), user-entered kept-domain rules, the opening preference, verified daily cleanup counts, and one hostname/latest-title/last-visit summary per website/day (chrome.storage.local). Complete deleted URLs are not saved. Search terms and date filters are not included in workspace URLs.
- Update requests: the store-installed extension makes a cookieless, referrer-free GET to https://sweep.agentclub.dev/extension-updates.json when opened, at most once per 15 minutes. No history, search terms or configuration is sent. Standard connection metadata reaches the website host. Newer hints trigger Chrome’s official update check; unpacked, forked and managed installations skip this check.
- Sale, advertising, profiling, credit decisions: none.
- Passwords, cookies, authentication information, payments, page contents: not accessed.
- Website: no added analytics or third-party resources. Hosted by Cloudflare; the privacy page links to Cloudflare's privacy policy and describes standard request processing.
- Use the current dashboard's definitions for data-collection checkboxes; do not describe “no upload” as “does not access history.” The history access is core functionality and must remain prominently disclosed.
- The privacy policy includes a Limited Use statement.

## Reviewer instructions (saved in dashboard; 499/500 characters)
No login needed. Use a disposable Chrome profile with visits to example.com. In the popup, test local suggestions, Exact domain, date filters, kept websites, select/deselect, and deletion preview. Cancel once, then confirm deletion of test URLs. Deletion removes all visits to selected URLs, even outside the date filter. Keep Chrome running; closing the UI does not stop deletion. Check English/Chinese, full-page handoff, current-site/context-menu search, and in-page modal in opening preferences.

## Detailed reviewer walkthrough
No account or login is required. Use a disposable Chrome profile and synthetic browsing history; deletion is permanent and removes every visit to each selected URL.

1. Install the extension, pin it, and visit https://example.com and https://www.iana.org/domains/reserved to create test history.
2. Open the toolbar popup. Switch between English and Simplified Chinese using the language controls.
3. Type example.com to check local search suggestions, choose Exact domain, and run the search. Suggestions do not select or delete anything.
4. Open filters. Check a preset or custom date range, then search again. Time filtering uses each URL's last visit; deleting a URL still removes all of its visits, including visits outside the filter.
5. Add example.com as a kept website, search again, and verify that its history is excluded from selection. Kept rules include subdomains. Remove the test rule before testing deletion.
6. Select all, deselect all, then select again and uncheck a page to keep. Review the grouped deletion preview. Cancel once and verify that nothing is removed.
7. Repeat deletion with disposable URLs and confirm. Keep Chrome running. Closing the popup does not stop the confirmed operation; reopen and search to review the result. Tasks do not resume after browser exit or extension reload.
8. Check Open full page and its search handoff, the current-website button, and the page context-menu entry. These entries search without automatic selection or deletion.
9. In opening preferences, select the in-page modal. Invoke the toolbar action on an ordinary HTTPS page and check the modal. Restricted pages use the full workspace instead. Restore the preferred opening method afterward.
10. All history processing, suggestions, kept rules, and opening preferences stay on this device. No test credentials are needed.

## Before submission
- Confirm product name and publisher details.
- Supply the developer contact email and review the final privacy policy.
- Use the deployed website, privacy, and support URLs listed above in the dashboard.
- Review the extension manually in a disposable Chrome profile. Automated tests cover mocked history up to 100,000 URLs and a native unpacked extension with local test visits, including deletion after the UI closes and search handoff without URL query data.
- Submit the extension ZIP and assets through the owner's developer account.
- The website links to the existing public store item; the store serves the currently published version until the update is approved and published.

## Official requirements checked on 2026-10-01
- Images: https://developer.chrome.com/docs/webstore/images
- Listing fields: https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- Privacy fields: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Limited Use: https://developer.chrome.com/docs/webstore/program-policies/limited-use

The pack supports submission preparation; it does not guarantee store approval.
