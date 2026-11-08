# Local agent integration

Agent access is included in the v1.0.0 extension package. The local companion targets Google Chrome on Windows, macOS and Linux, and MCP clients that support stdio. The downloadable installer configures Codex or Claude Code, the local MCP server and the companion Skill together. Native Windows and Linux verification is pending.

## One-step installation

Open **Agent access** in the extension toolbar and choose your operating system. On macOS, download the ZIP from GitHub Releases, extract it, and open **History Sweep Agent Installer.app**. The app is signed and notarized for Apple silicon and Intel Macs. Choose Codex or Claude Code in the installer. For an unpacked extension, use the extension ID displayed next to the download button; the Chrome Web Store ID is prefilled for store users.

On Windows and Linux, choose the client in the extension, download the ZIP, and run the included `.cmd` or `.sh` launcher. These launchers carry the extension's exact ID and check the published bootstrap and release files against their expected hashes. The macOS app carries its own copy of the MCP and Skill. All three installers use Node 22+ when available; otherwise they download a private, checksum-verified [Node 24.22.2 runtime](https://nodejs.org/en/blog/release/v24.22.2) under `.history-sweep/runtime`. They leave the global Node installation and PATH alone and preserve existing mismatched client entries and edited Skills.

The selected client must already be installed. Setup uses the client's own MCP CLI, verifies the saved entry, and installs the Skill into `.agents/skills/history-sweep` for Codex or `.claude/skills/history-sweep` for Claude Code. See the official [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex Skill locations](https://learn.chatgpt.com/docs/build-skills), and [Claude Code MCP CLI](https://code.claude.com/docs/en/mcp). On Windows the automatic client setup currently expects standalone `codex.exe` / `claude.exe`; other stdio clients can use the printed generic configuration.

`scripts/build-agent-release.mjs` prepares the Windows and Linux bootstrap files and update metadata. These must be published under the site's `/agent/` directory for Windows and Linux setup and version checks on all platforms. The macOS download and initial installation are independent of this publication.

When the installer or bundled companion changes, rebuild the Mac app with `node scripts/build-agent-macos-installer.mjs NEW_OUTPUT_DIRECTORY`. Sign it with Developer ID Application and hardened runtime, submit its archive to Apple, and staple the accepted ticket to the app. Archive the stapled app with `ditto -c -k --norsrc --keepParent` as `History-Sweep-Agent-Installer-macOS.zip`. Verify a fresh extraction and publish the ZIP as an installer release asset. Update the pinned release tag in `extension/agent-installers.mjs` and check the download from the extension. Keep the verified local ZIP at `extension/History-Sweep-Agent-Installer-macOS.zip` when running `scripts/verify-agent.mjs`.

## Connect

1. Load this checkout's `extension/` as an unpacked extension. Find its ID in `chrome://extensions`; unpacked IDs can differ from the store ID.
2. From the repository root, run the installer with that exact ID:

   ```sh
   node agent/install.mjs --extension-id YOUR_EXTENSION_ID --client codex --install
   ```

   For source-based installation, Node 22+ is required. The command copies an immutable release into the user's `.history-sweep/companion/releases` directory and registers `dev.agentclub.history_sweep` for the specified extension ID. Installing another ID for the same companion adds it alongside the existing IDs. Stable launchers select the active release atomically. On Windows it writes an HKCU registration, without requiring administrator access. On macOS/Linux it writes Chrome's user-level Native Messaging manifest. Use `--client claude-code` for Claude Code, repeat `--client` to install both, or omit it for manual MCP configuration. `--directory PATH` selects a different installation directory. Keep Node at its installed absolute path. The installer refuses to overwrite differing companion files or unrelated registrations.

   To prepare files without registering with Chrome or configuring a client, use `--prepare` instead of `--install`. The printed `mcp` object contains the exact executable and arguments for a stdio MCP server. Client configuration changes occur only for explicitly selected `--client` options during installation.

3. Add the printed command/arguments to the MCP client of your choice. The same server works with Codex and other stdio MCP hosts. For example, a generic client configuration has this shape (replace both paths with the installer output):

   ```json
   {
     "mcpServers": {
       "history-sweep": {
         "command": "ABSOLUTE_PATH_TO_NODE",
         "args": ["ABSOLUTE_PATH_TO_COMPANION/mcp.mjs"]
       }
     }
   }
   ```

4. Open **Agent access** in the extension toolbar and choose **Connect companion**. Chrome requests the optional Native Messaging permission. Rejecting permission does not enable the bridge. Copy the browser profile ID displayed on this page.
5. In the agent, discover the tools, choose the explicit profile ID, preview the intended scope and submit a request. Review changes in the extension's Agent access page. An agent cannot approve its own request through MCP.

For Chrome with a custom user-data directory, Chrome for Testing or Chromium, prepare the companion and place its generated manifest in that browser's `NativeMessagingHosts` directory. The automatic installer currently registers regular Google Chrome. See [Chrome's Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

To unregister this installation:

```sh
node agent/install.mjs --extension-id YOUR_EXTENSION_ID --unregister
```

Use the same `--directory` if one was supplied. This removes the specified ID from Chrome's registration and keeps any other IDs, companion files, and tasks. Disconnect in the extension to stop reconnect attempts. Approved work may finish; pause tasks separately if future scheduled cleanup should stop.

## Tools and workflow

Every task tool requires `profileId`; there is no default-profile fallback.

| Tool | Input and result |
| --- | --- |
| `history_sweep_profiles` | Discover connected opaque profile IDs; match the ID shown in the intended Chrome profile. |
| `history_sweep_health` | Read running/installed versions, managed Skill integrity and last MCP request. A last-request timestamp does not prove the client is still running. |
| `history_sweep_check_update` | Check the fixed publisher for a newer MCP/Skill bundle. It cannot install an update. |
| `history_sweep_list` | Read tasks, global pause state, next occurrence and configuration revision. |
| `history_sweep_preview` | Supply a draft `rule` (and saved `id` when editing/enabling), a saved enabled task `id`, or neither for all enabled tasks. Returns rule scope, aggregate matching/protected counts, revision, preview ID and expiry. |
| `history_sweep_save` | Request approval to create/update a task. Requires `requestId`, `revision`, `rule`, `enabled`; include `id` to update. Enabling requires the matching draft preview ID. Saving disabled does not schedule cleanup. |
| `history_sweep_toggle` | Request approval to enable/disable a saved task. Enabling requires a draft preview of that task's exact rule and ID. |
| `history_sweep_pause` | Request approval to pause/resume all tasks at the supplied revision. Resuming overdue schedules can trigger immediate catch-up. |
| `history_sweep_execute` | Request approval to execute a saved-task preview. Include the same `id` for a single task, or omit it for all enabled tasks. Requires `requestId`, `revision` and `previewId`. |
| `history_sweep_status` | Query the originating client's request ID. `pending` and `accepted` do not mean completion. |

A rule requires `domain`, `includeSubdomains` and `days`. `days: null` means no retention threshold; a positive integer means days without a visit. Optional schedules support `once` (`at`, epoch milliseconds), `daily` (`time`, HH:mm), `weekly` (`time`, `weekday` 0–6, Sunday = 0), or `monthly` (`time`, `day` 1–31). Schedules use the browser's local timezone, not the model's timezone. Omitting schedule preserves the engine's 24-hour interval semantics. Domain-overlap checks and protected sites/URLs remain authoritative.

Create → enable → execute are separate intentions. Enabling a task approves future scheduled deletion; it does not perform an immediate manual run. Describe retention, subdomain coverage and scheduling to the user before submitting a request.

## Approval, retries and lifecycle

- Mutation requests return `pending` and open/focus the extension review page. Decisions can be made there or on the Agent access page in an authenticated extension window. Rejection, disconnect, expiry and changed revisions do not execute the request.
- Previews expire after five minutes and bind the client, current profile's engine, exact rule/task scope, configuration revision and protection configuration. A new preview from the same client invalidates its earlier engine preview. Do not replace previews while their approval is pending.
- Immediate agent executions freeze the reviewed matching URL set and scan cutoff. If matches change before execution owns the deletion queue, the execution fails before deleting anything. Final visit/protection checks can skip URLs that become ineligible. No URL snapshot is written to storage.
- Chrome removes **all visits to each matched URL**; deletion is irreversible and may sync across signed-in devices. The tool does not promise deletion of just one date range or visit.
- Generate a fresh opaque request ID for a new intention. Repeat the same ID and identical arguments after a timeout; never invent a new ID to bypass a pending/rejected/uncertain request. The same ID with changed arguments fails. Decisions and receipts survive worker restarts in session storage; a receipt is written before side effects. There is a limit of 20 pending approvals and 256 receipts per browser session.
- `accepted` means the engine accepted execution. Poll `status` for `done`, `partial`, `verifyFailed`, `failed`, `stopped` or `interrupted`. Private cleanup still exposes the minimal execution phase, without persisting the engine's completed history statistics. Uncertain receipts are never automatically replayed. Inspect task state before a genuinely new request.
- Worker restart invalidates in-memory previews; obtain a new preview if the old proof is unavailable. An established Native Messaging port normally keeps the worker alive. The enabled connection is restored on worker/browser startup and checked by a one-minute alarm after disconnection. Disconnecting stops reconnection and rejects pending requests.
- A full browser restart clears session receipts and a restarted MCP process has a new client identity. Do not assume an old request is queryable after either event; inspect tasks and establish new user intent before submitting another mutation. Interrupted immediate agent executions are not replayed. Independently enabled schedules retain the existing engine's catch-up behavior.
- Each browser profile has its own opaque ID. Duplicate active IDs (for example, a copied browser profile) are rejected as ambiguous. A disconnected selected profile is an error; another profile is never selected automatically.

## Updates and monitoring

The **Agent access** page displays the running companion version, installed MCP/Skill bundle, managed Skill integrity, last MCP request and the most recent version-check result. Automatic checks are optional and run at most once per day while the companion is connected. Turning the checkbox off stops these scheduled checks; manual checks remain available. The checks send no profile ID, task data or browsing history, and do not report telemetry to a monitoring service.

Choose **Check for updates**, then **Update MCP and Skill** when a version is available. Only the trusted extension page can request installation through Native Messaging. MCP exposes health and metadata checks, not update installation. Downloaded files must match the fixed publisher origin, exact release paths, complete file allowlist, size limits and SHA-256 hashes. A newer bundle is staged before activation; older/same versions are not installed. The managed Skill copies are updated with the MCP bundle. Local edits to any managed Skill block the update.

Installation, updates and recovery share an OS-process lock. An active updater cannot be rolled back by another profile starting its launcher. Recovery uses `active.json` as the commit point and restores uncommitted changes from a controlled journal; an already committed version stays active. Previous release directories are retained. Reconnect the native companion and restart MCP clients to load new runtime code; existing processes do not silently swap their loaded modules.

For maintenance without the extension UI, run the installed `manage.mjs` launcher with `--check`, `--update`, or no flag for health. Publishing resources is a separate action:

```sh
node scripts/build-agent-release.mjs --output /absolute/new/staging-directory
```

The command prepares `latest.json`, the verified bootstrap and versioned release files. It also refreshes the extension's pinned bootstrap checksum. Uploading/deploying this staging tree is not part of the build. Keep the extension checksum and published bootstrap consistent; mismatches fail closed.

The public update files live under `agent/` on the repository's [`feature/agent-updates` branch](https://github.com/agent-club/history-sweep/tree/feature/agent-updates/agent). Publish the new version directory and `latest.json` in the same commit and retain earlier version directories. The [compatibility Worker](../deploy/agent-updates/worker.mjs) fetches these files from GitHub and serves them at the original `/agent/` URLs. Existing companions require those URLs and reject redirects.

The companion Skill is included at `agent/skills/history-sweep/SKILL.md`. Its frontmatter/structure has been validated. Formal repeated model-behavior regression with independent scoring remains incomplete; code/transport tests do not substitute for that Skill evaluation.

## Data and transport

MCP receives task domains/schedules, approval summaries and aggregate counts. It does not receive page URLs, page titles, visit timestamps, protected-site lists or a pending deletion queue. Task metadata and counts can still be sensitive and may reach the chosen agent/model provider. The extension discloses this before connection.

Chrome launches the local native host. The companion uses a random-port, authenticated loopback TCP channel with newline-delimited JSON, and a private discovery directory under `.history-sweep/agents`. Discovery authentication material is generated at runtime, never printed through MCP, and removed on normal host exit. The protocol has bounded messages/connections/timeouts. It is a local same-OS-user trust boundary, not isolation from other applications with the same user's filesystem access. Do not read or share discovery files with an agent. No local HTTP server or public network listener is added. Outbound installation/update downloads use the fixed History Sweep publisher and, when needed, official Node runtime downloads.

MCP uses the [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports); Native Messaging uses Chrome's length-prefixed UTF-8 JSON framing. Installation does not grant execution consent; the extension review remains necessary.

## Verification

```sh
node --test tests/agent*.test.mjs tests/auto-cleanup.test.mjs tests/background.test.mjs
node scripts/verify-agent.mjs
```

Set `HISTORY_SWEEP_CHROMIUM` to a Chrome for Testing executable if the Playwright browser is unavailable. The browser suite runs with a temporary extension copy, browser profile, native-host registration and synthetic history. It pre-grants the optional permission in that fixture so it can run unattended; the interactive optional-permission prompt still needs native user verification. `HISTORY_SWEEP_AGENT_SCREENSHOTS` selects an optional output directory. No real history or ordinary browser settings are used. Native-host registration in this browser suite currently targets POSIX browsers; Windows end-to-end verification requires a Windows runner.
