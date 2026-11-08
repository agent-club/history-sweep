# Workspace tools

The workspace tools described below are included in v0.7.0 and later packages.

v1.0.0 extends cleaned-link copying with explicit opening, a website-rule editor, parameter and path exceptions, and optional per-site automatic cleanup. See [usage, encoding limits and verification](link-cleanup.md).

## Entry points and behavior

| Capability | Entry | Behavior and limits |
| --- | --- | --- |
| Saved searches | Saved searches in the search toolbar | Open the anchored menu to save a name, query, match mode, relative range, view and advanced conditions, or apply, rename or remove an entry. Applying performs a fresh search and restores no selection. Fixed custom dates cannot be saved. A hidden saved view must be enabled in Preferences before use. |
| Advanced filters | Filters in the search toolbar | Open the anchored panel to add up to 20 path or title/URL conditions, each containing or excluding text. All conditions must match in addition to the existing search. Ordinary multi-website matching keeps its existing semantics. Editing conditions blocks deletion of stale results until applied. Applying closes the panel; Escape returns focus to its trigger. |
| Exact-URL protection | Page actions; Keep rules → Kept URLs in the date-filter panel | Keep one complete URL, including query and fragment identity. It stays visible but cannot be selected or deleted. Website rules retain their existing broader scope. Manual deletion and scheduled cleanup both enforce URL protection in the worker. |
| Visit details | Page actions → Visit details | Expand the visits currently available for one URL in the list. Unknown times or navigation sources are not inferred. No page-content or history archive is created. |
| Deletion impact | Deletion confirmation → View visit impact | Read available visits for the actual pending URLs. Show visits outside the selected range and clearly mark incomplete data. Canceling stops further detail reads. This does not change deletion semantics. |
| Cleaned-link copying | Page actions → Copy a cleaned link | Enter exact parameter names for one hostname, preview and copy. Saving a website rule is a separate explicit action. Untouched query bytes and the fragment are preserved. No request interception, history replacement or automatic navigation is performed. Clipboard failures leave a selected full URL for manual copying. |
| Manual website labels | Website-heading label control or Page actions | Edit local labels and their visibility for one exact hostname. Select a label in the preview to set its own text/background colors, choose one of six color combinations, add one of three background textures or choose a local PNG/JPG/WebP image up to 8 MB. Images are cropped and reduced locally; cancel discards the draft, and Reset style affects only the chosen label. Labels do not inherit to subdomains or affect deletion/selection. This is separate from automatic classification and record-level tags. |
| Selected-result export | Export selection beside deletion | Preview plain-text URLs or CSV containing URL, optional title and optional last-visit time. Only selected records are exported. CSV neutralizes formula-like cells. The file is not uploaded or encrypted by this action, and clearing history or uninstalling does not remove it. |
| Local activity clearing | Preferences → Privacy | Explicitly clear Local activity totals and website summaries. This does not clear browser history or reset protection, task configuration, preferences or nameplates. Recording afterward follows Private cleanup. Recommendations using the cleared activity rebuild from new evidence. |
| Interrupted manual cleanup | Workspace notice | Persist only an unfinished-operation identifier and flag. Do not persist target URLs, counts or a resumable deletion queue. A fresh search lets users inspect current history; deletion never resumes automatically. Dismissing acknowledges the notice without claiming that the old operation completed. |
| Selective encrypted disk recovery | Sync & disk backup | Optional backup sections contain kept domains/URLs, browsing defaults and declarative task scopes. The restore preview shows selected sections, current versus backup protection and the replacement behavior. Tasks get new local IDs, remain globally and individually paused, and have no imported next-run time. Preview and enable them manually. Connection restoration is separately selectable when present. |

The recommendation bar's **View reasons** expands an inline category inside the normal results list, with nested groups by recommendation reason. It reads the actual current search matches and recommendation evidence, including records beyond the list's initial rendering limit. Each group can collapse or show more records. A URL matching several reasons can appear in several groups; the overall count remains the unique URL count. Viewing the list does not select or delete records.

Recommendation settings and saved connections use dismissible notices beside their headings without moving the content. A blank connection form shows no unsolicited warning; edits show an unsaved notice, reverting clears it, and successful local saving shows temporary feedback. Save failures keep the draft. Settings and nested editors use a consistent full-arrow return button. Compact settings navigation shows every section in two columns.

With a mouse, hovering a website heading or any of its records reveals that group's **Create cleanup task** action. Record settings and deletion appear together when hovering or focusing a record, with aligned buttons and icons. The controls keep their layout space while hidden. Touch and other devices without hover keep these actions visible; record actions use 44px targets.

Deleting a URL still removes **all** its browser visits, including visits outside a filter range, and cannot be undone. A visit timeline, impact count or export is not an undo facility. Chrome may have incomplete visit details.

## Local data and portability

`workspaceTools` in `chrome.storage.local` stores the explicit saved criteria, exact kept URLs, hostname-specific parameter names and manual hostname labels. These settings may reveal browsing interests; they stay on this device and are excluded from WebDAV transfer. Individually kept URLs remain configuration until explicitly removed, even if browser history changes separately.

Manual label appearances are optional per-label `styles` inside the existing local label settings. Existing labels keep their default appearance until edited. Custom images are saved as 320 × 128 WebP thumbnails without the source filename or metadata; no image URL is fetched, and labels and their images are excluded from disk backups as well as WebDAV transfer.

`manualCleanupState` is a minimal operational marker without URLs, titles, visit counts or a history snapshot. Successful verified cleanup removes it. It can survive an interruption, including a private cleanup, so the UI can report an uncertain operation without recording completion activity.

Version-two encrypted disk files reuse the existing password-based encryption and add only the local sections explicitly checked at export. They never contain browsing-history records, cleanup activity, nameplates, pending operations or task execution results. Exact kept URLs are included only when protection is explicitly selected. The existing version-one files remain readable. Legacy lightweight configuration and any saved connection retain their existing backup scope; the new local sections never enter remote JSON.

Selective recovery changes only the checked categories. It leaves saved searches, link rules, manual labels, existing history and other unselected settings alone. Language, opening defaults and browsing defaults may require reopening the corresponding view, as with the existing settings. Saving a connection or restoring a file does not initiate a network transfer.

The current remote `history-sweep-config` version-one schema remains unchanged. Its reserved `historyTags` and `domainLabels` fields are distinct from the manual-label editor's local `workspaceTools.labels`; no automatic classification service is enabled.

## Verification

Run unit tests with `npm test`. The native flow suite is available as:

```sh
npm run test:workspace-tools
```

If Playwright's configured Chromium is unavailable, supply an installed compatible test browser:

```sh
npm run test:workspace-tools -- --browser /path/to/chromium
```

Run the dedicated UI state and geometry checks with `npm run test:design-refinements -- --browser /path/to/chromium`. This suite also uses an isolated native extension profile with synthetic history, covering anchored search tools, inline recommendations, notice timing and layout stability, failure feedback, return focus, compact layouts, 200% zoom, contrast samples and dark mode.

Run `node scripts/verify-label-appearance.mjs` for independent label colors, built-in/local images, save/cancel/reset, reload persistence, failed image decoding, keyboard focus, narrow layouts and English/dark-mode rendering. Set `HISTORY_SWEEP_CHROMIUM=/path/to/chromium` when a compatible browser executable is required.

The suite creates a new disposable profile, fulfills synthetic reserved-domain pages locally, and deletes only that profile's synthetic history. It uses no saved browser account, real WebDAV endpoint or external service. Each run creates its own temporary artifact directory; the profile is removed on completion. Screenshots cover the ten main scenes, English popup, dark theme and authenticated webpage-modal entry. Model tests cover invalid saved criteria, exact identity, encoding preservation, CSV formulas, partial visit data, serialized activity clearing and encrypted recovery. Worker and scheduled-cleanup tests check protection independently of the UI.

These checks do not establish compatibility with every browser/operating system, Chrome 110 specifically, signed store upgrades or production WebDAV providers. The v0.7.0 candidate needs separate submission and publication. Historical website and store media retain their documented versions; current candidate materials are in [the release pack](../store/v0.7.0-candidate.md).
