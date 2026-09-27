# Chrome Web Store submission pack — v0.3.0

Status: website deployed; extension prepared locally but NOT submitted or listed.

## Files
- Upload package: dist/history-sweep-0.3.0.zip. manifest.json is at the ZIP root.
- Listing copy: listing-en.md and listing-zh-CN.md.
- Store icon: assets/icon-128.png (128 × 128, transparent padding).
- Small promotional tile: assets/promo-small-440x280.png (required).
- Marquee: assets/promo-marquee-1400x560.png (optional).
- English screenshots: assets/screenshot-workspace-en-1280x800.png and assets/screenshot-popup-1280x800.png.
- Chinese screenshot: assets/screenshot-workspace-zh-1280x800.png.
- Privacy policy source: site/privacy.html (bilingual, publish a public URL before submission).

## Suggested listing fields
Name: History Sweep
Primary language: English
Category: Tools (工具); confirm the closest current dashboard category.
Website URL: https://sweep.agentclub.dev/
Privacy URL: https://sweep.agentclub.dev/privacy
Support URL: https://github.com/agent-club/history-sweep/issues
Developer contact email: owner must supply this in the dashboard before submission.
Do not invent store URLs, publisher identity, ratings, installation counts, or approval status.

## Single purpose (paste-ready)
Help users search, review, select, and delete their Chrome browsing history in batches.

## history permission justification (paste-ready)
History Sweep uses chrome.history.search to display history matching the user's query, chrome.history.deleteUrl to remove only URLs explicitly selected and confirmed by the user, and chrome.history.getVisits in its service worker to verify deletion. The worker continues confirmed operations when the popup closes; it does not recover tasks after Chrome exits. Processing happens locally. Browsing history is not transmitted to the developer or any third party.

## Remote code justification
No remotely hosted code. JavaScript, styles, translations, and icons are included in the extension package. The extension has no host permissions, no analytics, and a connect-src 'none' policy.

## Data practices to disclose accurately
- Accessed locally: browsing history URLs, titles, visit counts, and last visit times.
- Local memory: current search results and selections, one-time search handoffs, and confirmed deletion queues. Completed queue results are released by the page or discarded within 60 seconds; worker termination discards them sooner. No persistent history copy.
- Persisted locally: language preference only (localStorage). Search terms are not included in workspace URLs.
- Transmitted by extension: none.
- Sale, advertising, profiling, credit decisions: none.
- Passwords, cookies, authentication information, payments, page contents: not accessed.
- Website: no added analytics or third-party resources. Hosted by Cloudflare Pages; the privacy page links to Cloudflare's privacy policy and describes standard request processing.
- Use the current dashboard's definitions for data-collection checkboxes; do not describe “no upload” as “does not access history.” The history access is core functionality and must remain prominently disclosed.
- The privacy policy includes a Limited Use statement.

## Reviewer instructions
1. Load/install the extension in a test profile.
2. Visit a disposable page such as https://example.com.
3. Open the toolbar popup. It starts in English; switch language using EN/简中.
4. Search example.com using Exact domain. Review the listed URLs.
5. Use Select all, click it again to deselect all, then select all and uncheck any page to keep.
6. Click Delete selected. Cancel once to verify no change. Repeat and confirm only with disposable test data.
7. Wait for the verification message. Use Open full page to inspect the larger view.
8. No account or login is required.

## Before submission
- Confirm product name and publisher details.
- Supply the developer contact email and review the final privacy policy.
- Use the deployed website, privacy, and support URLs listed above in the dashboard.
- Review the extension manually in a disposable Chrome profile. Automated tests cover mocked history up to 100,000 URLs and a native unpacked extension with local test visits, including deletion after the UI closes and search handoff without URL query data.
- Submit the extension ZIP and assets through the owner's developer account.
- After approval, replace the website's pre-release CTA with the real store link.

## Official requirements checked on 2026-09-19
- Images: https://developer.chrome.com/docs/webstore/images
- Listing fields: https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- Privacy fields: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Limited Use: https://developer.chrome.com/docs/webstore/program-policies/limited-use

The pack supports submission preparation; it does not guarantee store approval.
