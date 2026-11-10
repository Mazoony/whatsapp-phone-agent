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
