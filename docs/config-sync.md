# Configuration sync and disk recovery

Implementation scope: [Issue #14](https://github.com/agent-club/history-sweep/issues/14). Included in **v0.5.0**, publicly available on the Chrome Web Store as verified on October 25, 2026. GitHub planning status is managed separately. This document describes the implementation, not provider certification.

## Persistence

Connection settings use `chrome.storage.local` under `syncConnection`. Language and appearance retain the existing extension-origin `localStorage` keys. Opening preference retains `launchMode`; reserved label configuration uses `syncMetadata`. Normal Chrome restarts and extension updates keep these stores. Uninstalling removes extension-owned storage; Chrome Sync does not provide a supported uninstall-recovery guarantee.

Use **Preferences → Sync & disk backup**, or the extension's Options page. Save a connection, then export an encrypted backup outside the extension directory. After reinstalling, import the file and enter its password. A restore preview requires confirmation. Backups are manual snapshots; export again after connection or preference changes. The extension cannot silently preserve files in a Chrome profile after uninstall, or rediscover a backup without user selection. No native companion or bookmark storage is introduced.

Disk backups contain the saved connection credentials and lightweight configuration. AES-256-GCM uses a fresh 12-byte IV and 16-byte salt for every backup; PBKDF2-SHA-256 derives the key with 310,000 iterations. Passwords must contain 12–1,024 characters and are neither stored nor recoverable. Local connection storage is not a password vault. Backups without a connection leave any existing connection unchanged when imported.

## WebDAV connection

**WebDAV:** enter the full HTTPS file URL, including a filename. The parent directory must exist. Username and app password are optional for servers permitting anonymous access. Authenticated requests use UTF-8 Basic authentication over HTTPS. This adapter uses GET and conditional PUT; it does not create directories or list remote files.
A Cloudflare Worker + R2 service can expose this same WebDAV interface. Configure its HTTPS file URL and WebDAV credentials in the extension. The service must support GET, conditional PUT (`If-Match` / `If-None-Match`), and strong ETags. The extension does not expose bucket/account settings, accept R2 access keys, or implement S3 signing. Implementing or deploying a Worker gateway is outside this change.

HTTPS host access is optional and requested only for the selected hostname when the user tests, uploads, or downloads. The Chrome host permission covers ports on that hostname; requests still use the exact saved file URL and port. Saving and exporting do not contact a server. Redirects, ambient cookies and referrers are disabled. Network requests time out after 20 seconds. A successful GET tests read access; an absent object does not prove write access.

## Transfer document

Only this allowlisted versioned JSON document is transferred, with a 128 KiB UTF-8 limit:

```json
{
  "format": "history-sweep-config",
  "version": 1,
  "preferences": { "language": "en", "theme": "system", "launchMode": "popup" },
  "historyTags": {},
  "domainLabels": {}
}
```

`historyTags` reserves configuration IDs (letters, numbers, underscores and hyphens, up to 80 characters) mapped to label arrays. It does not store visited URLs or history records. `domainLabels` reserves domain-name keys mapped to category-label arrays. Each map allows up to 1,000 entries, each array up to 30 non-empty labels of at most 80 characters. Tag editing, automatic classification and record-level tagging are future work, tracked separately in [#7](https://github.com/agent-club/history-sweep/issues/7) and [#11](https://github.com/agent-club/history-sweep/issues/11).

Unknown versions, unknown fields, malformed values and oversized responses are rejected before local application. Browsing history, cleanup activity, protected-domain rules, browsing defaults (`browsingPreferences`), Private cleanup preferences, connection credentials and temporary view state are excluded. No automatic background sync runs. Remote JSON is not encrypted at rest by this feature; the selected provider can read it. Keep buckets and DAV directories private.

Upload explicitly confirms replacement, reads and validates the current remote document, then uses its strong ETag in `If-Match`. New files use `If-None-Match: *`. Conflicts stop the upload; servers without strong ETags cannot replace existing files. Download previews the settings before replacing the corresponding local values; it does not merge configurations. Each successful upload is an intentional snapshot replacement, not a multi-device merge protocol.

## References

- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [WebDAV RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html)
