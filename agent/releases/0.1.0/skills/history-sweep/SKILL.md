---
name: history-sweep
description: Preview and manage Chrome cleanup tasks through the History Sweep MCP tools, including browser-approved execution. Use for History Sweep tasks rather than general browsing or filesystem cleanup.
---

# History Sweep cleanup tasks

Use the connected `history_sweep_*` MCP tools. If unavailable, explain that the local companion and extension connection are required; do not substitute browser history scraping, profile-file access, JavaScript injection or direct deletion. The tool descriptions provide the current argument schemas.

For setup, use the extension's **Agent access** installer for the chosen client/OS; it installs the local companion, MCP entry and this Skill together. `history_sweep_health` reports versions, Skill integrity and the last MCP request; that timestamp alone does not establish current client liveness. `history_sweep_check_update` checks publisher metadata only. Updating code or this Skill requires the user's **Update MCP and Skill** action in the extension. Do not directly replace installed files or client configuration. Preserve local Skill edits, which deliberately block managed updates. Reconnect the companion and restart the MCP client after updating.

Discover connected profile IDs and match the ID displayed on **Cleanup tasks → Agent access** in the intended Chrome profile. Use that explicit ID for every task call. Never guess a profile from discovery order or silently switch after disconnection. Task domains, schedules and aggregate counts can reach the model provider; raw page history is not returned.

Translate the user's intention into the domain, exact-domain/subdomain coverage, retention and schedule. `days: null` removes the retention threshold; do not infer that from an unspecified duration. Schedules use the browser's local timezone. Read tasks and their revision before changing them. Resolve genuinely missing scope with the user; preserve choices already given.

Preview draft rules before creating/enabling them. When updating or enabling an existing task, pass its ID with the exact draft rule. To run one enabled saved task, preview its ID **without a draft rule**, then execute with that same ID. Omitting the ID previews/runs all enabled tasks; use that only when requested. A new preview from the same client invalidates its earlier proof. Previews expire after five minutes.

Saving disabled, enabling a future schedule and executing now are separate actions. Do not enable a schedule merely to obtain an immediate deletion, or add immediate execution to a request for scheduled cleanup. Resuming overdue schedules can trigger catch-up immediately. Explain that deleting a matched URL removes **all its visits**, is irreversible, and may sync through Chrome.

Submit mutations with a fresh opaque request ID and the current revision, plus the matching preview ID when required. The extension will open a review page. Tell the user what awaits approval and let them decide there. Never call approval internals or treat natural-language consent as permission to bypass this backend boundary.

`pending` means waiting for browser approval; `accepted` means execution was accepted, not completed. Use status to distinguish `done`, `partial`, `verifyFailed`, `failed`, `stopped` and `interrupted`. After a transport timeout, query status or retry the same request ID with identical arguments. Do not generate a new ID to evade rejection, pending approval or uncertainty. After a stale/expired preview, inspect state and obtain a fresh preview for a genuinely renewed intention. Stop after rejection unless the user explicitly renews it.

Worker restarts invalidate previews. Browser restarts clear session receipts; MCP process restarts change client identity. If an old request cannot be queried, report uncertainty and inspect tasks before proposing another mutation. Do not infer success or automatically replay work. A disconnected or ambiguous profile requires restoring/identifying the intended connection, not choosing another profile.
