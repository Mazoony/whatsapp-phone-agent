# Complete Setup Guide: Running WhatsApp Agent on Honor X6b (MagicOS / Android)

This guide takes you step-by-step through setting up and running your autonomous WhatsApp agent directly on your **Honor X6b**.

---

## Part 1: Honor X6b (MagicOS) Battery Configuration (Crucial)

Honor's **MagicOS** aggressively kills background processes when the screen turns off. You must configure these settings so your agent can run 24/7 in the background:

### Step 1.1: Disable MagicOS App Killing for Termux
1. Open your phone's **Settings**.
2. Tap **Apps** > **App Launch** (or **Apps > Apps > Termux > Power details**).
3. Find **Termux** in the list.
4. Toggle it from **Manage automatically** to **Manage manually**.
5. Enable all 3 switches:
   - ✅ **Auto-launch** (Enabled)
   - ✅ **Secondary launch** (Enabled)
   - ✅ **Run in background** (Enabled)

### Step 1.2: Disable Battery Optimization
1. Go to **Settings** > **Battery** > **More battery settings** (or search "Battery Optimization").
2. Find **Termux** and set it to **Don't optimize** (or **Unrestricted**).

---

## Part 2: Installing Termux on Your Phone

> [!WARNING]
> **Do NOT install Termux from Google Play Store.** The Play Store version is obsolete and broken.

1. On your Honor X6b browser, go to **[F-Droid Termux Page](https://f-droid.org/en/packages/com.termux/)**.
2. Download the latest APK (scroll down to "Download APK") and install it.
3. Open the **Termux** app.

---

## Part 3: Installing Node.js & Setting Up the Agent in Termux

Inside the Termux terminal, run the following commands one by one:

### 3.1: Acquire Wake Lock (Keeps CPU alive when screen is off)
```bash
termux-wake-lock
```
*(You will see a persistent notification from Termux in your status bar indicating wake lock is active).*

### 3.2: Update Termux and Install Node.js & Git
```bash
pkg update -y && pkg install -y nodejs-lts git
```

### 3.3: Set Up the Project Folder
You can transfer the files from your PC or clone/create the directory in Termux:
```bash
mkdir -p ~/whatsapp-agent
cd ~/whatsapp-agent
```

If you copy the files created on your PC directly to your phone:
- Connect phone to PC via USB, copy the `whatsapp-phone-agent` folder into your phone's `Download` folder.
- In Termux, run:
```bash
termux-setup-storage
cp -r /sdcard/Download/whatsapp-phone-agent/* ~/whatsapp-agent/
cd ~/whatsapp-agent
```

### 3.4: Install Dependencies
```bash
npm install
```

### 3.5: Configure Your `.env` File
Create or edit your `.env` file:
```bash
nano .env
```
Fill in your details:
```env
GEMINI_API_KEY=AIzaSy...your_actual_key_from_google_ai_studio
OWNER_NAME=Your Name
BUSINESS_NAME=Your Business Name
BOT_ROLE=Executive Assistant
DEBOUNCE_SECONDS=6
TYPING_WPM=40
ALLOWED_NUMBERS=all
BLOCKED_NUMBERS=
IGNORE_GROUPS=true
FOLLOWUPS_ENABLED=true
FOLLOWUP_MAX_CONTACTS=700
FOLLOWUP_INTERVAL_HOURS=72
FOLLOWUP_SEND_DELAY_SECONDS=30
FOLLOWUP_START_DELAY_SECONDS=60
```
*(Press `CTRL + O`, then `ENTER` to save, and `CTRL + X` to exit `nano`).*

The agent keeps the WhatsApp typing indicator active while it waits at the configured typing speed. The default `TYPING_WPM=40` estimates about 300 ms per character, with a one-second minimum and no maximum; long replies therefore take proportionally longer before sending.

When WhatsApp connects and its saved chat history is available, the agent starts a personalized follow-up campaign for up to 700 eligible one-to-one chats whose contact names contain "Es". It uses each chat's own history, waits 30 seconds between sends, and repeats the same cohort 72 hours after a campaign completes. Students can opt out by replying `إيقاف`, `stop`, or `unsubscribe`. To disable campaigns, set `FOLLOWUPS_ENABLED=false` in `.env` and restart the agent.

### Lesson videos for each grade
The agent recognizes all Sudanese grade/stage combinations: grades 1–6 in ابتدائي, 1–3 in متوسط, and 1–3 in ثانوي. Lesson delivery requires each grade's lesson entries in `lessons.json` and matching video files under `media/lessons/<grade_key>/` (for example, `media/lessons/grade_1_primary/lesson_1.mp4`). Currently, lesson videos and exercises are configured only for `grade_3_secondary`; the other grades are placeholders and will not receive another grade's lessons. Add each grade's lesson videos and matching exercise/answer-key entries before enabling delivery for that grade.

### Saving new student phone numbers
When a previously unknown phone number messages the agent, Termux opens Android's prefilled contact form using `Es - <WhatsApp profile name>` (or the number if no profile name is available). Tap **Save** on the phone to add it to the address book. The agent cannot silently write to Android contacts through Baileys. This phonebook prompt is available only when running on Android in Termux.

The local admin dashboard's metric cards are interactive: **Direct chats** opens the chat list, **Active in last 24h** opens a list filtered to recent activity, **Chats handled** opens the WhatsApp agent view, which lists direct chats with saved agent replies ordered by the latest agent reply, **Students tracked** opens lesson progress, and **Es contacts** opens a searchable list of contacts WhatsApp has synced and marked as saved in the address book. The **WhatsApp agent** sidebar tab and overview card open the same recent handled-chat list. This view also shows recent terminal output from the agent and a scannable pairing QR while WhatsApp is requesting device linking; start the agent with `npm start` to see new output or request a fresh QR. Terminal output is kept locally in a rolling log (up to 1 MB) and refreshes while the view is open; logs may include student message text. The QR is cleared after the agent connects and is only shown briefly after it is generated. The status card reports connected only while the agent's connection heartbeat is fresh; it refreshes every 10 seconds and retains the last successful connection time. It also shows the linked WhatsApp account name and phone number when available; Baileys does not expose the physical phone model. It shows **Unknown** when the agent has not reported status yet; restart the agent with `npm start` to enable status updates. The Es-contacts list reloads its saved records every 30 seconds and has a manual **Reload saved contacts** button; neither action requests a fresh phone-book sync from WhatsApp. New contacts appear after WhatsApp sends their contact update to the running agent. Select a direct chat to review its history, compose a one-to-one message, and view a 30- or 90-day 24-hour activity graph and weekday/hour heatmap. Click a student's name on the Es contacts page to view the same activity graph and heatmap. Activity uses incoming-message timestamps in the browser's timezone; it shows historical messaging patterns, not current online availability. Direct messages are queued for the connected agent, which checks the configured allow/block rules, owner blocks, and opt-outs before sending. The Es list reads the agent's local `data/contacts.json` records; it does not query Android's address book directly.

On the Es contacts page, click a student's name to see their 30- or 90-day incoming-message activity heatmap; contacts with no saved incoming messages show an empty activity state. Select individual saved Es recipients or all contacts matching the search, write a message, and confirm the recipient count. Contacts do not need to have messaged first; explicit opt-outs, owner-blocked contacts, configured blocked numbers, and your own number remain excluded. The agent rechecks eligibility before each send. Bulk messages are queued locally and sent individually with a 5-second gap while the WhatsApp agent is connected; faster sending may increase the risk of WhatsApp rate limits or account restrictions. You can stop a queued or active campaign from the dashboard. A stopped campaign may have already delivered messages to recipients shown in its sent count.

---

## Part 4: Linking to Your WhatsApp Account

> [!TIP]
> **How to scan the QR code when it is on the same phone:**
> 1. In Termux, start the agent:
>    ```bash
>    npm start
>    ```
> 2. When the QR code appears in the Termux screen, take a **Screenshot** of your phone screen.
> 3. Send that screenshot to a laptop/second screen or friend's phone.
> 4. Open **WhatsApp** on your Honor X6b > **Three dots (top right)** > **Linked Devices** > **Link a device** and scan the QR code from the second screen!
> 
> *Alternatively:* You can run `npm start` on your PC first, scan the QR code with your phone to log in, and then copy the generated `auth_info_baileys` folder into your phone's Termux. Once authenticated, it does not need to be scanned again!

---

## Part 5: Running 24/7 in the Background

To keep the agent running even if you accidentally close the Termux app:

1. Install `pm2` (lightweight process manager):
   ```bash
   npm install -g pm2
   ```
2. Start the agent with pm2:
   ```bash
   pm2 start index.js --name "wa-agent"
   ```
3. To view live logs:
   ```bash
   pm2 logs wa-agent
   ```
4. To stop the agent:
   ```bash
   pm2 stop wa-agent
   ```
