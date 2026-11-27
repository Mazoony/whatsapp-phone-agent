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

In a configured lessons group, `/lesson` privately sends the student the available course tracks. The student must start the bot in a private chat first, then choose `/grammar`, `/spine`, or `/literature` there. `/grammar` in the group still starts the grammar lesson directly.

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

### Show phone Telegram data on the PC dashboard

The PC dashboard can use the Telegram agent's data and controls from a phone on the same Wi-Fi network. The dashboard stays open on the PC; run its API server on the phone alongside the Telegram bot so it can read and update the phone's local data.

1. Assign the phone a fixed/reserved Wi-Fi IP address, for example `192.168.1.50`. On the phone, generate a random bridge token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
2. From the Termux home directory (outside the repository), create a self-signed TLS certificate whose subject alternative name is the phone's Wi-Fi IP. Replace the sample IP in this command:

   ```sh
   openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 -keyout admin-bridge.key -out admin-bridge.crt -subj "/CN=eShool-dashboard" -addext "subjectAltName=IP:192.168.1.50"
   ```

   Keep `admin-bridge.key` private. Copy only `admin-bridge.crt` to the PC, and store both files outside the repository.
3. In the phone's `.env`, set `ADMIN_HOST=0.0.0.0`, `ADMIN_PORT=3002`, `ADMIN_BRIDGE_TOKEN` to the generated token, and `ADMIN_TLS_KEY_FILE` / `ADMIN_TLS_CERT_FILE` to the phone's key/certificate paths. Start the dashboard server on the phone with `npm run admin` and leave it running alongside the Telegram bot.
4. In the PC's `.env`, set `ADMIN_REMOTE_URL=https://192.168.1.50:3002`, `ADMIN_REMOTE_TOKEN` to the same token, and `ADMIN_REMOTE_CA_FILE` to the copied `admin-bridge.crt` path. Start the dashboard on the PC with `npm run admin`, then open `http://127.0.0.1:3001/`.
5. Set up or enter the dashboard password in the PC browser. The password and dashboard data remain on the phone; the bridge token is used only by the PC server and is not sent to the browser.

The phone API requires both the bridge token and dashboard password. Keep the token and private key secret, use a trusted private Wi-Fi network, and do not forward port 3002 from your router or expose it to the internet. If the phone's Wi-Fi IP changes, update the certificate and both device configurations. With no bridge settings, the dashboard remains loopback-only as before.

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
