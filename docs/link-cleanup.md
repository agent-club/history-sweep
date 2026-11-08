# Link cleanup

History Sweep v1.0.0 adds per-site link-cleanup rules, an option to open the cleaned link, and opt-in automatic cleanup for individual sites. The v0.7.0 package contains the earlier manual cleaner.

## Manual preview, copying and opening

Use **Page actions → Clean a link**. Enter the exact parameter names to remove, inspect the original and cleaned URLs, then copy or explicitly open the cleaned link in a new tab. Full-page and floating views open a foreground tab; the toolbar popup opens a background tab to retain the popup and its in-memory selection. Opening normally visits that destination and may add a visit; it never replaces or deletes the old history record.

An enabled saved rule supplies the initial parameter names and its preservation/path exceptions. A disabled rule is visibly identified and is not applied silently. Entering names allows a one-time manual preview; saving does not silently re-enable a disabled saved rule. **Manage website rules** opens the dedicated Preferences page.

Untouched query segments retain their original order and encoding; fragments remain intact. Every occurrence of a selected parameter name is removed, except names explicitly marked to be kept. Parameter names match exactly, including case. No built-in tracking list is selected automatically, and missing parameters are not inferred.

## Website rules

Open **Preferences → Link cleanup** to add, edit, enable, disable or delete an exact-hostname rule. Subdomains do not inherit a rule. Saving applies only that rule and preserves unrelated searches, protection, labels and task settings.

- **Remove these parameters:** exact names separated by commas or new lines.
- **Always keep these parameters:** takes precedence over removal.
- **Skip these paths:** serialized pathname prefixes with segment boundaries. `/checkout` matches `/checkout` and `/checkout/...`, but not `/checkout-v2`. A trailing slash matches that path and descendants. `/` excludes all paths. Encoded path spelling and case are significant; matching does not decode the pathname.
- **Try a link:** previews the current draft without saving the sample URL.

Cancel, Back and closing an edited settings tab protect unsaved changes with a discard confirmation. A failed save retains the draft. A stale rule edited in another window is rejected rather than overwritten. Rule deletion has a separate confirmation. Legacy rules retain their manual behavior and do not gain automatic activation.

## Optional automatic cleanup

Automatic cleanup starts off. Save and enable a website rule, then choose **Allow site access and enable**. Chrome requests HTTPS access to that exact website. A pre-existing WebDAV site grant alone does not activate cleanup. The extension declares `declarativeNetRequestWithHostAccess`; website access remains optional and is requested only from the explicit action.

Once enabled, the browser applies the saved rule to future HTTPS top-level GET navigations for that hostname. It does not process HTTP pages, POST submissions, frames or fetch/resource requests. Each redirect preserves parameter values outside the removal list and respects the configured path exceptions. It does not read response bodies or send a browsing log to a service.

**Encoding limitation:** automatic cleanup skips the entire navigation if any query parameter name contains percent encoding or `+`. Use manual preview for those links; the manual cleaner decodes names before matching. Values may still contain percent encoding or `+`. Rules with unsupported parameter-name syntax or unsupported browser regular expressions are not activated. The UI reports unavailable/apply-error states instead of claiming success.

**Pause all automatic cleanup** removes this feature's effective browser rules while retaining its configuration. Per-site disabling, rule disabling/deletion and hostname changes stop automatic cleanup for the affected hostname. Browser-side permission revocation also cancels its automatic intent: a later grant for WebDAV cannot reactivate cleanup without a new explicit enable action. Turning cleanup off does not revoke shared website access used by another feature.

Browser rule installation and local configuration are separate operations. Startup, permission changes and settings changes reconcile them. If applying fails, actual installed rules remain visible as an error; a requested stop is not reported as completed while old rules remain. Feature-owned rule IDs are managed separately from foreign dynamic rules. Path exceptions are not installed if their allow actions could bypass another feature's existing dynamic rules.

The browser's outgoing request, address bar and history are distinct results. Automatic request cleanup does not promise that the original URL never appears in history, and cannot recall parameters already sent to a server.

## Data boundaries and release preparation

Website names, removal/preservation names, excluded paths, enabled state, automatic host choices and global pause state stay in `chrome.storage.local`. They are excluded from WebDAV and existing disk-backup sections. Preview samples are not persisted. No visit log, complete request URL archive or automatic history replacement is added.

Historical URL replacement remains deferred. The current implementation offers no lossless editing of visit times, visit counts or navigation sources, and no new undo facility.

Before distributing these changes, review store permission justification and the privacy copy for optional per-site automatic rewriting, validate the signed upgrade and native permission dialog, assign an agreed release version and rebuild the package. Existing downloaded archives, public update metadata and historical release materials remain unchanged by this implementation.

## Verification

Model and worker tests:

```sh
node --test tests/link-cleanup-rules.test.mjs tests/automatic-link-cleanup.test.mjs tests/workspace-tools.test.mjs tests/background.test.mjs
```

Focused native UI and local HTTPS integration:

```sh
node scripts/verify-link-cleanup.mjs --browser /path/to/chrome-for-testing
```

Run the additional manual-open and selection-preservation scenarios separately:

```sh
node scripts/verify-link-cleanup.mjs --browser /path/to/chrome-for-testing --manual-only true
```

The browser suite stages a copy of the current extension and pregrants access only to the reserved synthetic test hostname in that fixture. This exercises actual dynamic rules and local HTTPS requests without operating a real account or browsing history. The manual-open cases check the popup presentation and its background-tab flag using `popup.html` in an extension tab; they do not operate Chrome's native toolbar popup window. The tests do not establish native permission-dialog behavior or signed store upgrade behavior. The manifest still declares Chrome 110; checks on a newer Chrome do not establish minimum-version compatibility.
