# Apple Reminders iCloud MCP

An unofficial MCP server for reading and managing Apple Reminders through iCloud.com. It runs locally with Node.js and Chrome, so **macOS is not required**.

The server automates the public iCloud Reminders web app rather than calling private iCloud APIs. Apple can change that interface at any time, so selectors may occasionally need maintenance.

## What it can do

- List reminder lists and reminders
- Create reminders, including notes and due dates
- Complete reminders
- Update reminder notes
- Create and rename reminder lists

Deletion, shared-list administration, attachments, subtasks, tags, recurrence, location reminders, and background synchronization are not supported.

## Requirements

- Node.js 22 or newer
- Google Chrome
- An Apple Account with iCloud Reminders enabled

The project is tested on Windows. The implementation does not depend on macOS, and the browser/profile paths can be overridden for other systems.

## Install and authenticate

```powershell
git clone https://github.com/ivanbard/apple-reminders-icloud-mcp.git
cd apple-reminders-icloud-mcp
npm ci
npm run check
npm run auth
```

Sign in and complete two-factor authentication in the Chrome window. The window closes when Reminders is ready.

Your Apple password and verification code stay in Apple's sign-in flow. This server does not read, store, log, or transmit them. Session cookies are kept in a dedicated Chrome profile at `%LOCALAPPDATA%\apple-reminders-icloud-mcp\profile` on Windows, or `~/apple-reminders-icloud-mcp/profile` when `LOCALAPPDATA` is unavailable.

## Connect an MCP client

Build the server:

```powershell
npm run build
```

For Codex, register the local STDIO server with an absolute path:

```powershell
codex mcp add apple-reminders-icloud -- node C:\absolute\path\to\apple-reminders-icloud-mcp\dist\index.js
```

Or add it to a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.apple-reminders-icloud]
command = "node"
args = ["C:/absolute/path/to/apple-reminders-icloud-mcp/dist/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 120
```

Other MCP clients can use the same command and absolute `dist/index.js` argument. Restart the client after changing its MCP configuration.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_reminder_lists` | List available reminder lists |
| `list_reminders` | List reminders in the selected or specified list |
| `create_reminder` | Create a reminder with optional list, notes, and ISO 8601 due date-time |
| `complete_reminder` | Mark a reminder complete |
| `update_reminder_notes` | Replace or clear a reminder's notes |
| `create_reminder_list` | Create a private reminder list |
| `rename_reminder_list` | Rename a reminder list |

Example prompts:

```text
List my reminder lists.
Create a reminder called "Renew passport" due 2026-10-01T09:00:00-04:00.
Mark reminder <reminderId> in list <listId> complete.
```

Reminder reads and writes return this shape:

```json
{
  "reminders": [
    {
      "id": "11111111-2222-4333-8444-555555555555",
      "listId": "derived:0123456789abcdef",
      "title": "Example reminder",
      "notes": null,
      "due": "10/1/2026, 9:00 AM",
      "completed": false
    }
  ]
}
```

List IDs are deterministic `derived:` values based on a list's name and duplicate-name position. They can change when a list is renamed or reordered. Reminder IDs come from iCloud's reminder-row identifiers.

## Configuration

- `ICLOUD_PROFILE_DIR`: location of the dedicated Chrome profile
- `ICLOUD_BROWSER_PATH`: path to a specific Chromium executable

If the server returns `AUTH_REQUIRED` or `TWO_FACTOR_REQUIRED`, run `npm run auth` and retry. Other errors indicate an unavailable list or reminder, a failed write, or an iCloud page change.

## Development

```powershell
npm run check
```

`npm run test:live` is opt-in and uses the authenticated account. It reads every list and intentionally leaves a timestamped reminder, test list, and updated reminder for inspection.

## Security and privacy

- Keep the Chrome profile private; it contains the authenticated iCloud session.
- Only configure this server in MCP clients and projects you trust, because its tools can read and change reminders.
- Do not commit copied profiles, cookies, logs, or local environment files.

## License

[MIT](LICENSE)
