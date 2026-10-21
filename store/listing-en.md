# History Sweep

Prepared for the v0.5.0 update; not a claim of current store availability.

## Summary (Chrome Web Store)
Find, select, and delete browsing history in batches. A calmer, more private way to tidy up Chrome.

## Detailed description
Five hundred pages shouldn't take five hundred clicks.

History Sweep helps you find the browsing history you want to remove, select all matching URLs, and clear them in batches.

FIND EXACTLY WHAT YOU MEAN
Choose smart matching, an exact domain, a domain with its subdomains, or text in a title or URL. Type X to match the x domain label, including x.com. Use comma-separated domains to include multiple sites.

SELECT ONCE, REVIEW BEFORE REMOVING
Select every matching URL with one click, even when the list is longer than the current preview. Uncheck pages you want to keep. Review the number of selected URLs before confirming deletion.

FIND FREQUENTLY VISITED PAGES
Choose By frequency to rank pages by visits within the selected period, with the last visit in that period as the tie-breaker. Pages visited again later can still appear. Incomplete visit reads produce an error, not a partial ranking. Deleting a URL still removes all of its visits.

SMALL OR SPACIOUS
With no saved opening preference, History Sweep opens as a modal over the current webpage. Existing opening choices are preserved. Use the toolbar popup for quick tasks, open the full workspace with your current query and date filters, or choose an in-page modal in opening preferences. Preferences shows Chrome’s current keyboard shortcut and links to its shortcut settings; Chrome must be focused. Use Back to top after browsing a long result list. Start an exact-domain search from the current-website button or page right-click menu; these entries never select or delete automatically.

NARROW BY DATE, KEEP IMPORTANT WEBSITES
Filter by last visit using a preset or an inclusive custom date range. Save kept websites to exclude a domain and its subdomains from selection. First use opens By website for today and the previous six local calendar days, without selecting anything. Save your default view and relative time range in Preferences. Temporary filters leave saved defaults unchanged; custom dates are temporary. Keyword searches use all time unless you choose a range. Date and website views count unique pages by their last visit. Inspect selected pages in the deletion preview.

LOCAL SEARCH SUGGESTIONS
As you type, suggestions from your browsing history help complete domains and find titles or URLs. Suggestions and their indexes are processed locally in memory, with no remote service.

LOCAL ACTIVITY AND PRIVATE CLEANUP
View local browsing and cleanup activity. Browsing history appears first; scroll up to collapse the panel. Enable and save Private cleanup to stop new cleanups from saving counts or website details. Existing local activity is retained.

MANUAL SETTINGS SYNC AND ENCRYPTED BACKUP
In Preferences → Sync & disk backup, save an HTTPS WebDAV file URL to transfer language, appearance and opening preferences manually. Browsing history, cleanup activity, kept websites, browsing defaults and Private cleanup preferences are excluded. Request access only to your chosen host when testing or transferring. The provider can read remote JSON. Export a password-encrypted backup outside the extension folder for manual recovery after uninstall; Chrome removes extension storage on uninstall. Backups are manual snapshots, not automatic sync.

PRIVATE BY DESIGN
History is processed in your browser and never uploaded by the extension. No account, analytics, or ads. The history permission lets it read and remove browsing history; activeTab supports user-invoked website searches and the in-page modal, scripting inserts the chosen modal host, contextMenus adds the website right-click entry, storage saves kept-domain rules, the opening preference, and daily cleanup counts with hostname/latest-title/last-visit summaries only on this device, without complete deleted URLs; favicon displays Chrome-provided website icons in group headings and local activity. It does not read website passwords, cookies, bookmarks, or webpage contents. WebDAV connection credentials you enter are saved locally and used only to authenticate to your selected server; backup files encrypt them. The optional HTTPS host access supports user-initiated WebDAV operations.

The official store installation requests public version metadata at most once per 15 minutes when opened, then asks Chrome to check for an update when appropriate. No history, search terms or settings are sent; the host receives standard connection metadata. Only Chrome-confirmed downloads enable Update; deletion and verification block reload. Unpacked installations skip these requests. No remote scripts are executed.

ENGLISH AND SIMPLIFIED CHINESE
The interface starts in English. Switch languages in either view; your preference is saved locally.

PLEASE NOTE
Deleting a URL removes all its visits, including visits outside the chosen date range, and cannot be undone. Chrome may sync deletions across signed-in devices. Confirmed deletion continues if you close the extension window. Keep Chrome running; reopen and search to review the result. Tasks cannot resume after Chrome exits. Scans are limited to 100,000 distinct URLs; a notice appears when the limit is reached. The extension verifies selected URLs after deletion and identifies those still present.

Screenshots use illustrative data, not real browsing history.
