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
GEMINI_API_KEY_FALLBACK=your_second_account_key_optional
GEMINI_API_KEY_FALLBACK_2=your_third_account_key_optional
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
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

The optional Gemini fallback keys are used in order after the primary key's model fallbacks fail. Keep all API keys private and never paste them into chat or commit `.env`.

On the Windows PC, install Ollama and download the `qwen3:4b` model to enable local AI as a final fallback after Gemini. In PowerShell, run `ollama pull qwen3:4b`, add `OLLAMA_BASE_URL=http://127.0.0.1:11434` and `OLLAMA_MODEL=qwen3:4b` to `.env`, then start Ollama and the agent on that same PC. Stop the Termux agent before starting the PC copy; do not keep two agent sessions connected to the same WhatsApp account. If the PC has no existing WhatsApp login, pair it from WhatsApp's **Linked devices** screen when the agent displays its QR. The local model receives chat text only and cannot inspect image attachments; image replies require a working Gemini model. On an 8 GB PC, `qwen3:4b` is the recommended starting model.

The agent keeps the WhatsApp typing indicator active while it waits at the configured typing speed. The default `TYPING_WPM=40` estimates about 300 ms per character, with a one-second minimum and no maximum; long replies therefore take proportionally longer before sending.

When WhatsApp connects and its saved chat history is available, the agent starts a personalized follow-up campaign for up to 700 eligible one-to-one chats whose contact names contain "Es". It uses each chat's own history, waits 30 seconds between sends, and repeats the same cohort 72 hours after a campaign completes. Students can opt out by replying `إيقاف`, `stop`, or `unsubscribe`. To disable campaigns, set `FOLLOWUPS_ENABLED=false` in `.env` and restart the agent.

### Lesson videos for each grade
The agent recognizes all Sudanese grade/stage combinations: grades 1–6 in ابتدائي, 1–3 in متوسط, and 1–3 in ثانوي. For a new lesson sequence, the student must agree to lesson delivery and have a confirmed grade. If they agree before sharing their grade, that consent is remembered. Once both are known, the agent replies to the student's English difficulty with a concise practical tip, then sends the matching first lesson's introduction, video, and exercise. It corrects submitted answers and sends the next lesson after a successful attempt. Lesson delivery requires lesson entries in `lessons.json` and matching video files under `media/lessons/<grade_key>/` (for example, `media/lessons/grade_1_primary/lesson_1.mp4`). Currently, lesson videos and exercises are configured only for `grade_3_secondary`; the other grades are placeholders and will not receive another grade's lessons. A student with an active lesson can ask the agent to resend the current video (for example, “رسل لي الفيديو”); this resends only the video and does not reset lesson progress. The AI also loads an original Year 3 Secondary English reference for confirmed students in that grade, covering SPINE 6 study support, *Treasure Island*, grammar, and writing; it does not replace the assigned textbook or supply its passages. Add each other grade's lesson videos and matching exercise/answer-key entries before enabling lesson delivery for that grade.

### Monthly subscription prices
When a student directly asks about the monthly subscription, the agent selects the price from the WhatsApp phone number's country calling code: Sudan (+249) is 17,000 SDG; GCC countries Kuwait (+965), Saudi Arabia (+966), Oman (+968), UAE (+971), Bahrain (+973), and Qatar (+974) are 52,000 SDG; all other country codes are 27,000 SDG. The agent must not initiate a payment conversation.

### Optional grammar course
The structured English grammar course is separate from the existing video lessons and is available to confirmed first-, second-, and third-secondary students. Students explicitly opt in by asking the WhatsApp agent to start the grammar course. It teaches one concept at a time, gives an explanation and examples before exactly 10 exercises, saves numbered answers and course progress locally in `data/grammar_tutor_progress.json`, asks for missing answers, and requires corrections before moving on. The 20-lesson sequence includes present-simple forms, gerunds, make, let, and a mixed review at the end. The course does not replace or restart the student's existing video-lesson progress.

### Saving new student phone numbers
When a previously unknown phone number messages the agent, Termux opens Android's prefilled contact form using `Es - <WhatsApp profile name>` (or the number if no profile name is available). Tap **Save** on the phone to add it to the address book. The agent cannot silently write to Android contacts through Baileys. This phonebook prompt is available only when running on Android in Termux.

The local admin dashboard's metric cards are interactive: **Direct chats** opens the chat list, **Active in last 24h** opens a list filtered to recent activity, **Chats handled** opens the WhatsApp agent view, which lists direct chats with saved agent replies ordered by the latest agent reply, **Students tracked** opens lesson progress, and **Es contacts** opens a searchable list of contacts WhatsApp has synced and marked as saved in the address book. The separate **Permanent history** count matches the WhatsApp agent's startup count: it includes each local contact record flagged for permanent Es history, including aliases; **Es contacts** is narrower and includes only saved phone-book contacts, deduplicated by phone number. Both counts refresh when the local contacts file changes. In the Chats view, use **Sort** to order by newest or oldest activity, or put unread/read conversations first; **Show** can filter to all, unread, or read chats. Opening a conversation marks it read in this dashboard; a later incoming student message makes it unread again. Read markers are stored locally in `data/chat_read_state.json` and are separate from WhatsApp's read receipts. The overview also includes a line graph of unique direct chats with an incoming message on each of the last seven calendar days, using the browser's local timezone; today may be incomplete. The **WhatsApp agent** sidebar tab and overview card open the same recent handled-chat list. At the top of that view, the **Live chat queue** shows the active conversation followed by chats in FIFO order; it refreshes live and animates position changes. A chat is added when a message arrives, waits through the configured debounce period, and leaves the queue when the agent finishes responding. New messages received during an active response create a fresh queue entry at the end. The list shows contact names and waiting/handling durations, not message contents. This view also shows recent terminal output from the agent, live media upload status and progress, and a scannable pairing QR while WhatsApp is requesting device linking; start or restart the agent with `npm start` to see new output or request a fresh QR. Media delivery results and progress are kept locally in `data/agent_media_activity.json`; terminal output is kept in a rolling log (up to 1 MB) and refreshes while the view is open; logs may include student message text. The QR is cleared after the agent connects and is only shown briefly after it is generated. The status card reports connected only while the agent's connection heartbeat is fresh; it refreshes every 10 seconds and retains the last successful connection time. It also shows the linked WhatsApp account name and phone number when available; Baileys does not expose the physical phone model. It shows **Unknown** when the agent has not reported status yet; restart the agent with `npm start` to enable status updates. The Es-contacts list reloads its saved records every 30 seconds. Click **Update from WhatsApp** to ask the connected agent to resync WhatsApp's contact app-state and refresh the saved contact list after the sync completes; use **Reload list** only to redraw contacts already stored locally. New contacts must first be saved on the phone and synced by WhatsApp to the linked agent. Select a direct chat to review its history, compose a one-to-one message, and view a 30- or 90-day 24-hour activity graph and weekday/hour heatmap. Click a student's name on the Es contacts page to view the same activity graph and heatmap. Activity uses incoming-message timestamps in the browser's timezone; it shows historical messaging patterns, not current online availability. Direct messages are queued for the connected agent, which checks the configured allow/block rules, owner blocks, and opt-outs before sending. The Es list reads the agent's local `data/contacts.json` records; it does not query Android's address book directly.

Student progress refreshes when lesson state changes and when a tracked student sends a message. Its **Last student message** column uses the latest incoming timestamp from saved chat history, merges linked phone-number and LID histories, and moves the most recently active students to the top. The **Texts received** column shows total saved incoming messages and counts for the last 7 and 30 days; **Active days (30d)** shows how many UTC calendar days included an incoming message in the last 30 days. These are incoming student messages only, not agent replies, and totals reflect the locally saved history. A new message updates activity time but does not change lesson status unless the agent successfully evaluates a task submission or delivers another lesson. The overview also includes a line graph of unique direct chats with an incoming message on each of the last seven calendar days, using the browser's local timezone; today may be incomplete. The **WhatsApp agent** sidebar tab and overview card open the same recent handled-chat list. At the top of that view, the **Live chat queue** shows the active conversation followed by chats in FIFO order; it refreshes live and animates position changes. A chat is added when a message arrives, waits through the configured debounce period, and leaves the queue when the agent finishes responding. New messages received during an active response create a fresh queue entry at the end. The list shows contact names and waiting/handling durations, not message contents. This view also shows recent terminal output from the agent, live media upload status and progress, and a scannable pairing QR while WhatsApp is requesting device linking; start or restart the agent with `npm start` to see new output or request a fresh QR. Media delivery results and progress are kept locally in `data/agent_media_activity.json`; terminal output is kept in a rolling log (up to 1 MB) and refreshes while the view is open; logs may include student message text. The QR is cleared after the agent connects and is only shown briefly after it is generated. The status card reports connected only while the agent's connection heartbeat is fresh; it refreshes every 10 seconds and retains the last successful connection time. It also shows the linked WhatsApp account name and phone number when available; Baileys does not expose the physical phone model. It shows **Unknown** when the agent has not reported status yet; restart the agent with `npm start` to enable status updates. The Es-contacts list reloads its saved records every 30 seconds. Click **Update from WhatsApp** to ask the connected agent to resync WhatsApp's contact app-state and refresh the saved contact list after the sync completes; use **Reload list** only to redraw contacts already stored locally. New contacts must first be saved on the phone and synced by WhatsApp to the linked agent. Select a direct chat to review its history, compose a one-to-one message, and view a 30- or 90-day 24-hour activity graph and weekday/hour heatmap. Click a student's name on the Es contacts page to view the same activity graph and heatmap. Activity uses incoming-message timestamps in the browser's timezone; it shows historical messaging patterns, not current online availability. Direct messages are queued for the connected agent, which checks the configured allow/block rules, owner blocks, and opt-outs before sending. The Es list reads the agent's local `data/contacts.json` records; it does not query Android's address book directly.

On the Es contacts page, choose **Eligible Es contacts** to message eligible Es contacts saved in the phone book, or **Non-Es** to target tracked one-to-one chats, including unsaved contacts. Both groups exclude opted-out, owner-blocked, configured-blocked, dashboard-blocked, owner, and disallowed numbers; eligibility is rechecked before each recipient. Select all is limited to 5,000 recipients per broadcast. If more than 5,000 are eligible, the page explicitly selects only the first 5,000; queue that broadcast, then use **Select batch** to replace the current selection with the next 5,000 before queuing another message. Use the formatting toolbar above the bulk-message box for bold, italic, strikethrough, monospace, lists, links, and clear formatting. The style buttons insert WhatsApp text formatting (`*bold*`, `_italic_`, `~strikethrough~`, or triple-backtick monospace); Ctrl+B, Ctrl+I, and Ctrl+Shift+X are also supported. Select text before applying a style, or click a style with no selection to type inside its markers. Use **Attach media or file** to add up to five images, videos, audio files, or supported documents (20 MB maximum per file), or choose **Record voice note** and allow microphone access. Microphone recording requires a secure browser context: use `http://localhost:3001` on the computer running the dashboard, or serve the dashboard over HTTPS when accessing it from another device. After you stop recording, its preview appears immediately while the upload completes. Review and remove queued attachments before sending. A message accompanies the first image, video, or document as its caption; with audio-only attachments, the text is sent separately. Recorded audio is sent as a WhatsApp voice note when supported by the browser's recording format. Broadcasts are sent individually with the same five-second recipient gap.

When a student explicitly says in a message that they have paid (in supported English or Arabic phrases), the agent adds a **paid** WhatsApp chat label and the dashboard displays **Paid · student-reported** for that phone number. This is based on the student's statement, not payment verification; a receipt image by itself does not trigger the label. You can also use **Mark paid** or **Mark unpaid** beside any Es contact to manage the dashboard status manually; the connected agent will add or remove the matching WhatsApp chat label. The dashboard confirms when a manual change is saved and shows the same paid badge in the Chats list and conversation header. Baileys applies WhatsApp labels to chats, not to the Android address-book contact card.

Baileys may identify a saved contact using both a phone-number JID and an LID. The agent preserves this link so the dashboard can display the contact and resolve its phone number; newly saved or renamed phone contacts appear after WhatsApp syncs the contact update to the linked agent.

While the Chats list is open, the connected agent subscribes gradually to the visible direct chats' WhatsApp presence; opening an individual chat also requests its presence. The chat list and header show **Online**, **Offline**, a last-seen time, or **Status unavailable** when WhatsApp provides no current status. Presence is best-effort and depends on the contact's privacy settings and an active WhatsApp connection; a missing status is never assumed to mean offline. Only recently received presence updates are treated as current.

The dashboard uses a local server-sent event stream to refresh views when chat history, contacts, lesson progress, agent status, media delivery, or message queues change. It reconnects automatically and performs a full refresh every 15 seconds as a fallback. Incoming agent-chat queue state is stored in `data/incoming_chat_queue.json` and is only available through the authenticated dashboard API. Chat read markers are stored separately in `data/chat_read_state.json`.

The eligible-recipient list shows each chat's latest WhatsApp activity date and time when WhatsApp provides one; otherwise it falls back to the latest saved incoming-message timestamp, and shows **Unavailable** if neither exists. The source is labeled in the list. Baileys chat timestamps from full-history sync and live chat/message updates are saved locally in `data/whatsapp_chat_activity.json` and refreshed live in the dashboard. The date filter uses the browser's timezone and matches a chat's latest WhatsApp activity on that date or an incoming message in saved history on that date. Restart the agent with `npm start` to request WhatsApp's initial full-history sync after installing this feature. WhatsApp may not provide a timestamp for every chat, so unavailable dates are left blank rather than estimated.

The admin dashboard asks you to create a password the first time it is opened. Use at least 12 characters; the dashboard stores only a salted scrypt hash in `data/admin_auth.json`. Login protects dashboard APIs and live updates as well as the page. Sessions expire after 12 hours and whenever the dashboard process restarts, and five failed password attempts trigger a five-minute lockout. Use **Lock** to end your session immediately. If you forget the password, stop the dashboard, remove only `data/admin_auth.json`, restart the dashboard, and set a new password. The dashboard remains bound to this computer (`127.0.0.1`); the password is additional local protection, not a way to expose it safely over the network.

When the agent reconnects after the linked WhatsApp device was unavailable, it processes messages WhatsApp explicitly fetches for that unavailable-device session and replies using the normal eligibility, opt-out, and conversation flow. It ignores ordinary old-history sync messages, so reconnecting does not trigger replies to past conversations. Messages are only recovered when WhatsApp delivers them to the linked device.

For a student's first reply, the agent asks in English whether it may send a lesson now and what the student's biggest difficulty in English is. It waits for an affirmative response before delivering a grade-specific lesson; knowing the student's grade alone is not permission. A direct request to send a lesson also counts as permission.

The Es contacts page lets you **Ban** a number or **Delete** it from the local contact records. Both actions persist the number in `data/blocked_contacts.json`, which the agent checks before replying, following up, or sending queued messages. Delete also removes matching phone/LID aliases from `data/contacts.json`; it does not erase chat history or Android's address book. Use **Allow again** to remove a number from the block list. The contacts table's gender selector supports manual Female, Male, or Not identified values, stored by phone number in `data/contact_gender.json`; selecting Auto restores inference from client messages. Gender is also shown on dashboard chat cards and in the open conversation header. The Overview shows Female, Male, and Not identified counts and percentages across saved Es phone-book contacts, along with how many values were manually set or inferred. These statistics update live when synced contacts or gender values change. Automatic gender is inferred only when messages contain a clear first-person gendered self-description (for example, "أنا طالبة"); it does not guess from the contact name and may be wrong.

The agent also builds a local, aggregate Sudanese Arabic style profile from incoming client messages. It counts occurrences of a curated set of conversational expressions and supplies the most common cues to response generation as optional style examples, never as instructions. It does not retain the original message text in this profile; the counts are stored in `data/sudanese_arabic_style.json`. New observations appear in the agent log. This adapts to expressions in the messages it receives but is not a general-purpose Arabic language trainer.

The Student progress page provides a downloadable local Excel workbook at `data/students.xlsx`. It contains a consolidated Students sheet (contact details, lesson progress, and latest-message summary) and a Conversation History sheet (all currently saved direct-chat messages). The workbook is generated when the dashboard starts and regenerated when contacts, chat history, lesson progress, or lesson configuration changes; its status and download link are shown in the dashboard. This workbook contains private contact details and chat text; keep the local file secure and do not share it without authorization.

Outgoing images, videos, audio, documents, and stickers show upload progress in the agent terminal. Interactive terminals show a live progress bar; non-interactive terminals log completion or failure.

On the Es contacts page, click a student's name to see their 30- or 90-day incoming-message activity heatmap; contacts with no saved incoming messages show an empty activity state. Use the date filter to show eligible Es contacts who sent a message on that calendar day in your browser's timezone, then select individual chats or **Select all** for that date and queue a bulk message to them. Each matching chat shows its latest incoming-message date and time for that day; the queued broadcast passes this per-recipient activity timestamp, date, and timezone to the agent, which records it as it sends. You can also select individual saved Es recipients or all contacts matching the search without a date filter. Contacts do not need to have messaged first; explicit opt-outs, owner-blocked contacts, configured blocked numbers, and your own number remain excluded. The agent rechecks eligibility before each send. Bulk messages are queued locally and sent individually with a 5-second gap while the WhatsApp agent is connected; faster sending may increase the risk of WhatsApp rate limits or account restrictions. You can stop a queued or active campaign from the dashboard. A stopped campaign may have already delivered messages to recipients shown in its sent count.

The **WhatsApp agent** dashboard tab includes a chat-style feed of the latest saved incoming direct-chat messages and agent replies, in time order, alongside the live terminal output. The feed updates while the tab is open and reflects messages persisted in the local chat history.

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
