# Chrome Web Store submission pack — v0.3.2

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
No remotely hosted code. JavaScript, styles, translations, and icons are included in the extension package. The extension has no persistent host permissions, no analytics, and a connect-src 'none' policy.

## Additional permission justifications (paste-ready)
- activeTab: Provides temporary access after the user invokes the extension, to read the current website URL for an exact-host search or display the user-selected in-page modal. No page content is collected.
- scripting: Inserts only the local modal host after a toolbar action when the user has selected the in-page modal opening method. It does not read page content.
- contextMenus: Adds a page right-click entry that opens the selected website's history search for review. It never deletes automatically.
- storage: Saves user-entered kept-domain rules and the opening preference in chrome.storage.local, on this device only. Rules exclude matching domains and subdomains from selection and are rechecked before deletion. Temporary modal authorization metadata uses chrome.storage.session. No history copy is saved.

## Data practices to disclose accurately
- Accessed locally: browsing history URLs, titles, visit counts, last visit times, and the URL of the website for a user-invoked website search.
- Local memory: current search results, local Worker suggestion indexes and selections, one-time search handoffs, and confirmed deletion queues. Completed queue results are released by the page or discarded within 60 seconds; worker termination discards them sooner. No persistent history copy.
- Persisted locally: language preference (localStorage), user-entered kept-domain rules and the opening preference (chrome.storage.local). Search terms and date filters are not included in workspace URLs.
- Transmitted by extension: none.
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
