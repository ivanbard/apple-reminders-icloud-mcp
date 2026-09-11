# Apple Reminders iCloud MCP

A local Windows MCP server that reads and manages Apple Reminders through the visible iCloud.com web app. This is unofficial and may need selector maintenance when Apple changes the site.

## Tools

- `list_reminder_lists`
- `list_reminders` (optional `listId`; otherwise uses the selected list)
- `create_reminder` (`title`, optional `listId` and `notes`)
- `complete_reminder` (`listId`, `reminderId`)
- `update_reminder_notes` (`listId`, `reminderId`, `notes`; use `""` to clear)
- `create_reminder_list` (`name`)
- `rename_reminder_list` (`listId`, `name`)

Reminder reads and writes return the same shape:

```json
{
  "reminders": [
    {
      "id": "11111111-2222-4333-8444-555555555555",
      "listId": "_icloud-list-id",
      "title": "Example reminder",
      "notes": null,
      "due": "9/11/2026, 5:00 PM",
      "completed": false
    }
  ]
}
```

The server uses native list IDs found in reminder-row DOM IDs. Empty lists have deterministic `derived:` IDs based on name and duplicate-name position; those IDs can change if a list is renamed or reordered.

## Observed iCloud workflow

Verified on September 11, 2026:

- `https://www.icloud.com/reminders/` hosts Reminders in `iframe#early-child`.
- The sidebar is a `role="tree"` named `Reminder Lists`; each list is a direct `role="treeitem"` child.
- The visible list name is `.inline-editable-label`.
- Reminder rows expose IDs shaped like `reminder-item-<list-id> Reminder/<reminder-id>`.
- Reminder title and notes are accessible textboxes; completion is a labeled `button.mark-completed`.
- List creation uses the visible `Add List` dialog. List names are edited through the sidebar's inline text field.
- The list action menu currently exposes deletion only. The server does not use it.
- Signed-out sessions show Apple's sign-in iframe. Password and two-factor authentication stay entirely in that visible Apple browser flow.
- A sanitized network observation showed private CloudKit `com.apple.reminders` record query/lookup calls plus the Reminders `/rd/state` service. Headers, cookies, query strings, and bodies were not captured.

No private iCloud endpoints are used. Their authentication, mutation, and compatibility behavior has not been tested independently enough to replace the browser boundary.

## Setup

Requires Node.js 22+ and an installed Google Chrome.

```powershell
npm install
npm run check
```

The first tool call opens a visible, dedicated Chrome profile. Sign in and complete two-factor authentication there, then call the tool again. Session cookies remain only in `%LOCALAPPDATA%\apple-reminders-icloud-mcp\profile`; the server never reads, stores, logs, or transmits your password or verification code.

Build and register the STDIO server with Codex:

```powershell
npm run build
codex mcp add apple-reminders-icloud -- node C:\absolute\path\to\apple-reminders-icloud-mcp\dist\index.js
```

Or add this to a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.apple-reminders-icloud]
command = "node"
args = ["C:/absolute/path/to/apple-reminders-icloud-mcp/dist/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 120
```

Restart the local Codex client after changing MCP configuration.

## Errors

- `AUTH_REQUIRED`: sign in in the visible browser, then retry.
- `TWO_FACTOR_REQUIRED`: finish Apple's two-factor prompt in the browser, then retry.
- `LISTS_UNAVAILABLE`: Reminders or its lists are unavailable for the current account/session.
- `LIST_NOT_FOUND`: the requested list ID is unavailable.
- `REMINDER_NOT_FOUND`: the requested reminder ID is unavailable in that list.
- `INVALID_ARGUMENT`: a required string is missing or blank.
- `WRITE_FAILED`: iCloud did not confirm a requested edit.
- `PAGE_STRUCTURE_CHANGED`: Apple's DOM no longer matches the verified selectors.

Set `ICLOUD_PROFILE_DIR` to move the dedicated browser profile, or `ICLOUD_BROWSER_PATH` to use a specific Chromium executable.

## Scope

Deletion, shared-list administration, attachments, subtasks, tags, recurrence, location reminders, and background synchronization are intentionally excluded. Reminder listing covers iCloud's normal active-list view; completed-history expansion is not implemented.
