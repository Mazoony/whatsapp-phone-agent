# eShool learning agents

This repository contains the eShool WhatsApp and Telegram learning agents, a local admin dashboard, and the shared lesson and student services they use.

## Requirements

- Node.js with npm
- A Gemini API key, or a configured local Ollama instance, for AI-powered replies
- WhatsApp and/or Telegram credentials for the agent you want to run

## Setup

From the repository root, install dependencies and create your local environment file:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and add only the credentials and settings needed for your setup. Never commit `.env`, Telegram sessions, WhatsApp authentication folders, or private student data.

For Telegram, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_GROUP_ID`. To route additional class groups, set `TELEGRAM_CLASS_GROUPS` to a JSON object mapping group IDs to grade keys, for example:

```text
TELEGRAM_CLASS_GROUPS={"-1001234567890":"grade_2_secondary"}
```

For sending Telegram announcements from a personal account, configure `TELEGRAM_CLIENT_API_ID` and `TELEGRAM_CLIENT_API_HASH`, then start the separate sender described below.

### Google Sheets Overview history (optional)

The admin dashboard can mirror the local daily Overview Excel history to a Google spreadsheet with the same three tabs. To enable it:

1. Enable the Google Sheets API and Google Drive API in a Google Cloud project.
2. Create a service account and store its JSON key in the deployment's `GOOGLE_SERVICE_ACCOUNT_JSON` secret. Do not commit the key.
3. Optionally set `GOOGLE_SHEETS_SHARE_WITH` to your Google account email. The generated spreadsheet is shared with that account as a viewer.
4. Start the admin dashboard. It creates a spreadsheet, syncs the three tabs once a day, and shows the link and status in Overview.

The spreadsheet ID is saved in `data/overview_google_sheet.json`. If the deployment does not preserve `data/` between restarts, copy the spreadsheet ID from the Google Sheets URL into `GOOGLE_SHEETS_SPREADSHEET_ID` so the app keeps syncing the same spreadsheet.

## Run

Run commands from the repository root:

| Command | Purpose |
| --- | --- |
| `npm start` or `npm run whatsapp` | Start the WhatsApp agent |
| `npm run telegram` | Start the Telegram bot |
| `npm run telegram-broadcast` | Start the personal-account Telegram announcement sender |
| `npm run admin` | Start the local admin dashboard at `http://127.0.0.1:3001/` |
| `npm run web` | Start the web chat |
| `npm run chat` | Run the chat simulator |
| `npm test` | Run the project tests |

The WhatsApp agent uses a QR code to link its account on first startup. Keep the corresponding process running while that agent is in use. Telegram bot, Telegram personal-account sender, and dashboard are separate processes; start only the ones you need.

### Private read-only dashboard access

The dashboard has a separate viewer page at `/viewer`. To set its password, sign in to the admin dashboard locally, then open `http://127.0.0.1:3001/viewer` in the same browser and create a viewer password. Share only that password with the viewer; it does not unlock the admin dashboard.

For private remote access, install and sign in to Tailscale on the dashboard computer and the viewer's device, then use Tailscale Serve to publish the local dashboard only inside your tailnet:

```powershell
tailscale serve --bg http://127.0.0.1:3001
```

Give the viewer the HTTPS address Tailscale reports, with `/viewer` appended. Do not use Tailscale Funnel or otherwise expose the admin dashboard to the public internet. Viewer sessions can read dashboard data but cannot change records or send messages. To revoke the viewer password, stop the dashboard, remove `data/admin_viewer_auth.json`, restart it, and set a new password from the local admin session.

## Project layout

```text
apps/
  whatsapp-agent/   WhatsApp entry point and WhatsApp-specific modules
public/             Admin dashboard interface
data/               Local runtime state and student data (not source-controlled)
media/              Lesson and broadcast media
lessons.json        Shared lesson curriculum
telegram_agent.js   Telegram bot entry point
admin_dashboard.js  Admin dashboard server
```

Shared services and configuration remain at the repository root because they are used by multiple agents or the dashboard. Start the WhatsApp app from the repository root so shared configuration and data paths resolve consistently.

See [apps/whatsapp-agent/README.md](./apps/whatsapp-agent/README.md) for details about the WhatsApp app folder.
