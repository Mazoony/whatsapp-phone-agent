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
GEMINI_API_KEY_FALLBACK_3=your_fourth_account_key_optional
GEMINI_API_KEY_FALLBACK_4=your_fifth_account_key_optional
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
OLLAMA_VISION_MODEL=
OWNER_NAME=Your Name
BUSINESS_NAME=Your Business Name
BOT_ROLE=Executive Assistant
DEBOUNCE_SECONDS=6
TYPING_WPM=40
ALLOWED_NUMBERS=all
BLOCKED_NUMBERS=
IGNORE_GROUPS=true
FOLLOWUPS_ENABLED=false
FOLLOWUP_MAX_CONTACTS=700
FOLLOWUP_INTERVAL_HOURS=72
FOLLOWUP_SEND_DELAY_SECONDS=30
FOLLOWUP_START_DELAY_SECONDS=60
```
*(Press `CTRL + O`, then `ENTER` to save, and `CTRL + X` to exit `nano`).*

The optional Gemini fallback keys are used in order after the primary key's model fallbacks fail. Keep all API keys private and never paste them into chat or commit `.env`.

On the Windows PC, install Ollama and download the `qwen3:4b` model for local task marking. In PowerShell, run `ollama pull qwen3:4b`, add `OLLAMA_BASE_URL=http://127.0.0.1:11434` and `OLLAMA_MODEL=qwen3:4b` to `.env`, then start Ollama and the agent on that same PC. Stop the Termux agent before starting the PC copy; do not keep two agent sessions connected to the same WhatsApp account. If the PC has no existing WhatsApp login, pair it from WhatsApp's **Linked devices** screen when the agent displays its QR. The live WhatsApp agent uses fixed, rule-based messages for lesson delivery and general routing; AI is reserved for interpreting and marking assigned task submissions. If marking fails, the agent tells the student the answer was not marked wrong and asks them to retry later. To analyze image submissions, install a vision-capable Ollama model and set its exact installed model name in `OLLAMA_VISION_MODEL`; the text-only `qwen3:4b` model cannot inspect images. Lesson scheduling, progress, and video sending are handled by regular app code and do not depend on AI. On an 8 GB PC, `qwen3:4b` is the recommended starting text model.

The agent simulates typing at the configured `TYPING_WPM` speed for short generated replies and task feedback. Prewritten lesson introductions and exercises are sent immediately without a simulated typing delay, so long exercises do not hold up delivery; video upload time and the brief gap after the video remain.

Personalized follow-up campaigns are disabled by default to keep the agent focused on assigned lessons and avoid unnecessary AI use. They can be explicitly enabled with `FOLLOWUPS_ENABLED=true`, but doing so adds messages outside the lesson-delivery and marking workflow.

### Lesson videos for each grade
The agent recognizes all Sudanese grade/stage combinations: grades 1–6 in ابتدائي, 1–3 in متوسط, and 1–3 in ثانوي. It uses fixed lesson-only replies rather than AI for general conversation. When a student's grade is known and matching lesson content is configured, the agent sends the lesson introduction, video, and exercise. If the grade is unknown, it asks for the grade and school stage. AI is reserved for marking assigned answers: accept equivalent wording, synonyms, and concise correct answers when they preserve the intended meaning and grammar; do not accept responses whose meaning changes, and ask for clarification when an answer is ambiguous. If all answers are correct, the next numbered lesson is scheduled 24 hours later; a wrong or incomplete submission must be corrected before progression. Any new lesson delivery, including a Treasure Island chapter or a manually scheduled lesson, is limited to one per student per 24 hours; overdue scheduled deliveries are deferred until that interval has passed. Resending the current video does not send another exercise or reset progress. Lesson entries in `lessons.json` must include a matching video under `media/lessons/<grade_key>/` (for example, `media/lessons/grade_3_secondary/lesson_1.mp4`), an exercise, and its answer key. Lesson videos in that folder are read in numeric order; an unconfigured lesson or missing number blocks later videos rather than skipping ahead. The available Grade 3 Secondary files are numbered 1–6 and 8–10; there is no video 7. Lessons 1 and 2 have sequential exercise-and-answer-key configuration; lesson 5 is standalone, and later videos are not automatically sent until their preceding lesson entries are configured. Other grades remain placeholders and will not receive another grade's lessons. A student with an active lesson can ask the agent to resend the current video (for example, “رسل لي الفيديو”); this resends only the video and does not reset lesson progress. Add each other grade's lesson videos and matching exercise/answer-key entries before enabling lesson delivery for that grade.

### Treasure Island course
The **Curriculum & Lessons** dashboard has a separate **Treasure Island** section for Grade 3 Secondary. Add each chapter there with its own title, video, exercise, and answer key; uploaded videos go into `media/lessons/grade_3_secondary/treasure_island/`. Students can ask for Treasure Island and choose a chapter by its displayed number or title. Each chapter is graded independently: its active task and completed chapter list are stored separately from the regular sequential English curriculum, and completing a chapter does not advance or reset regular lesson progress. Configure chapter videos and exercises in the dashboard before offering the course to students.

### Monthly subscription prices
The dashboard Payments page summarizes distinct students marked paid in the selected month at 17,000 SDG per student. Enter the SDG amount for 1 USD to see the equivalent total; the rate is saved in that browser.

### Grammar course
The separate interactive grammar course is not available through the live WhatsApp agent while it is limited to video lessons, assigned exercises, and marking.

### Saving new student phone numbers
When a previously unknown phone number messages the agent, Termux opens Android's prefilled contact form using `Es - <WhatsApp profile name>` (or the number if no profile name is available). Tap **Save** on the phone to add it to the address book. The agent cannot silently write to Android contacts through Baileys. This phonebook prompt is available only when running on Android in Termux.

In the **WhatsApp agent** live chat queue, pause handling to hold all waiting chats, or use **Cancel** on a specific waiting student to skip that queued batch. Incoming messages remain saved; an active response cannot be cancelled and will finish normally.

The local admin dashboard's metric cards are interactive: **Direct chats** opens the chat list, **Active in last 24h** opens a list filtered to recent activity, **Chats handled** opens the WhatsApp agent view, which lists direct chats with saved agent replies ordered by the latest agent reply, **Students tracked** opens lesson progress, and **Es contacts** opens a searchable list of contacts WhatsApp has synced and marked as saved in the address book. The separate **Permanent history** count matches the WhatsApp agent's startup count: it includes each local contact record flagged for permanent Es history, including aliases; **Es contacts** is narrower and includes only saved phone-book contacts, deduplicated by phone number. Both counts refresh when the local contacts file changes. In the Chats view, use **Sort** to order by newest or oldest activity, or put unread/read conversations first; **Show** can filter to all, unread, or read chats. Opening a conversation marks it read in this dashboard; a later incoming student message makes it unread again. Read markers are stored locally in `data/chat_read_state.json` and are separate from WhatsApp's read receipts. The overview's weekly graph labels daily unique direct chats with incoming messages and adds a separate line for new conversations, identified by the first saved incoming message in the local history. Linked phone-number and LID histories are counted as one chat. Dates use the browser's local timezone, and today may be incomplete. The **WhatsApp agent** sidebar tab and overview card open the same recent handled-chat list. At the top of that view, the **Live chat queue** shows the active conversation followed by chats in FIFO order; it refreshes live and animates position changes. A chat is added when a message arrives, waits through the configured debounce period, and leaves the queue when the agent finishes responding. New messages received during an active response create a fresh queue entry at the end. The list shows contact names and waiting/handling durations, not message contents. This view also shows recent terminal output from the agent, live media upload status and progress, and a scannable pairing QR while WhatsApp is requesting device linking; start or restart the agent with `npm start` to see new output or request a fresh QR. Media delivery results and progress are kept locally in `data/agent_media_activity.json`; terminal output is kept in a rolling log (up to 1 MB) and refreshes while the view is open; logs may include student message text. The QR is cleared after the agent connects and is only shown briefly after it is generated. The status card reports connected only while the agent's connection heartbeat is fresh; it refreshes every 10 seconds and retains the last successful connection time. It also shows the linked WhatsApp account name and phone number when available; Baileys does not expose the physical phone model. It shows **Unknown** when the agent has not reported status yet; restart the agent with `npm start` to enable status updates. The Es-contacts list reloads its saved records every 30 seconds. Click **Update from WhatsApp** to ask the connected agent to resync WhatsApp's contact app-state and refresh the saved contact list after the sync completes; use **Reload list** only to redraw contacts already stored locally. New contacts must first be saved on the phone and synced by WhatsApp to the linked agent. Select a direct chat to review its history, compose a one-to-one message, and view a 30- or 90-day 24-hour activity graph and weekday/hour heatmap. Click a student's name on the Es contacts page to view the same activity graph and heatmap. Activity uses incoming-message timestamps in the browser's timezone; it shows historical messaging patterns, not current online availability. Direct messages are queued for the connected agent, which checks the configured allow/block rules, owner blocks, and opt-outs before sending. The Es list reads the agent's local `data/contacts.json` records; it does not query Android's address book directly.

In **Curriculum & Lessons**, each configured lesson with an available video has a **Send to inactive Es** action. It previews the eligible eShool contact count and, after confirmation, queues that lesson video individually for contacts whose latest saved WhatsApp activity is more than 10 days old. Contacts without an activity timestamp, blocked contacts, and students who opted out are excluded. The recipient list is rechecked at confirmation; if it changed, preview again. Broadcasts use the existing five-second per-recipient gap and can take hours for a large cohort. Monitor or stop a queued job on the **Broadcasts** page.

Students can ask the WhatsApp agent to send a configured lesson at a particular time. The agent asks for the grade if it is unknown, clarifies incomplete or ambiguous dates/times, then repeats the exact lesson and time in Sudan time (Africa/Khartoum) and waits for a clear yes before saving a one-time delivery. Schedules are stored locally and survive restarts; the agent must be running and connected for delivery. Review schedules on the **Scheduled lessons** page to edit the time, send now, or cancel. Interrupted deliveries are marked failed with an uncertain result rather than automatically resent, to avoid duplicate lesson videos.

Teachers can also create a one-time schedule from the **Scheduled lessons** page. Choose a student from saved direct-chat contacts or lesson-progress records, select one of that student's configured lessons, and set the delivery time in Sudan time. Only lessons with an available video, exercise, and answer key are offered. The selected time must be in the future.

The dashboard briefly caches selected summaries and lists in this browser tab's session storage to make reloads and repeated views faster. Live updates and manual refreshes invalidate the cache; locking the dashboard clears it. Chat message history, live agent status, and queue data are not cached.

When a student has no lesson-progress record, the agent checks saved outgoing WhatsApp history for a configured lesson video caption/marker or its exercise text. It uses that evidence to resume after the latest recognized lesson rather than automatically restarting at lesson one. Ordinary conversation or a student's own copied exercise answers do not count as evidence. For an established conversation without recognizable lesson history, it leaves lesson delivery paused rather than guessing and restarting at lesson one.

Student progress refreshes when lesson state changes and when a tracked student sends a message. Its **Last student message** column uses the latest incoming timestamp from saved chat history, merges linked phone-number and LID histories, and moves the most recently active students to the top. The **Texts received** column shows total saved incoming messages and counts for the last 7 and 30 days; **Active days (30d)** shows how many UTC calendar days included an incoming message in the last 30 days. These are incoming student messages only, not agent replies, and totals reflect the locally saved history. A new message updates activity time but does not change lesson status unless the agent successfully evaluates a task submission or delivers another lesson. The overview's weekly graph labels daily unique direct chats with incoming messages and adds a separate line for new conversations, identified by the first saved incoming message in the local history. Linked phone-number and LID histories are counted as one chat. Dates use the browser's local timezone, and today may be incomplete. The **WhatsApp agent** sidebar tab and overview card open the same recent handled-chat list. At the top of that view, the **Live chat queue** shows the active conversation followed by chats in FIFO order; it refreshes live and animates position changes. A chat is added when a message arrives, waits through the configured debounce period, and leaves the queue when the agent finishes responding. New messages received during an active response create a fresh queue entry at the end. The list shows contact names and waiting/handling durations, not message contents. This view also shows recent terminal output from the agent, live media upload status and progress, and a scannable pairing QR while WhatsApp is requesting device linking; start or restart the agent with `npm start` to see new output or request a fresh QR. Media delivery results and progress are kept locally in `data/agent_media_activity.json`; terminal output is kept in a rolling log (up to 1 MB) and refreshes while the view is open; logs may include student message text. The QR is cleared after the agent connects and is only shown briefly after it is generated. The status card reports connected only while the agent's connection heartbeat is fresh; it refreshes every 10 seconds and retains the last successful connection time. It also shows the linked WhatsApp account name and phone number when available; Baileys does not expose the physical phone model. It shows **Unknown** when the agent has not reported status yet; restart the agent with `npm start` to enable status updates. The Es-contacts list reloads its saved records every 30 seconds. Click **Update from WhatsApp** to ask the connected agent to resync WhatsApp's contact app-state and refresh the saved contact list after the sync completes; use **Reload list** only to redraw contacts already stored locally. New contacts must first be saved on the phone and synced by WhatsApp to the linked agent. Select a direct chat to review its history, compose a one-to-one message, and view a 30- or 90-day 24-hour activity graph and weekday/hour heatmap. Click a student's name on the Es contacts page to view the same activity graph and heatmap. Activity uses incoming-message timestamps in the browser's timezone; it shows historical messaging patterns, not current online availability. Direct messages are queued for the connected agent, which checks the configured allow/block rules, owner blocks, and opt-outs before sending. The Es list reads the agent's local `data/contacts.json` records; it does not query Android's address book directly.

On the Es contacts page, choose **Eligible Es contacts** to message eligible Es contacts saved in the phone book, or **Non-Es** to target tracked one-to-one chats, including unsaved contacts. Both groups exclude opted-out, owner-blocked, configured-blocked, dashboard-blocked, owner, and disallowed numbers; eligibility is rechecked before each recipient. Select all is limited to 5,000 recipients per broadcast. If more than 5,000 are eligible, the page explicitly selects only the first 5,000; queue that broadcast, then use **Select batch** to replace the current selection with the next 5,000 before queuing another message. Use the formatting toolbar above the bulk-message box for bold, italic, strikethrough, monospace, lists, links, and clear formatting. The style buttons insert WhatsApp text formatting (`*bold*`, `_italic_`, `~strikethrough~`, or triple-backtick monospace); Ctrl+B, Ctrl+I, and Ctrl+Shift+X are also supported. Select text before applying a style, or click a style with no selection to type inside its markers. Use **Attach media or file** to add up to five images, videos, audio files, or supported documents (300 MB maximum per file), or choose **Record voice note** and allow microphone access. Microphone recording requires a secure browser context: use `http://localhost:3001` on the computer running the dashboard, or serve the dashboard over HTTPS when accessing it from another device. After you stop recording, its preview appears immediately while the upload completes. Review and remove queued attachments before sending. A message accompanies the first image, video, or document as its caption; with audio-only attachments, the text is sent separately. Recorded audio is sent as a WhatsApp voice note when supported by the browser's recording format. Broadcasts are sent individually with the same five-second recipient gap.

When a student explicitly says in a message that they have paid (in supported English or Arabic phrases), the agent adds a **paid** WhatsApp chat label and the dashboard displays **Paid · student-reported** for that phone number. This is based on the student's statement, not payment verification; a receipt image by itself does not trigger the label. You can also use **Mark paid** or **Mark unpaid** beside any Es contact to manage the dashboard status manually; the connected agent will add or remove the matching WhatsApp chat label. Each manual **Mark paid** action records a one-month payment period in the **Payments** calendar, where you can see which students were marked paid on each date and when that month ends. Existing manually marked paid labels use their saved mark date; student-reported labels are not included in the calendar. The dashboard confirms when a manual change is saved and shows the same paid badge in the Chats list and conversation header. Baileys applies WhatsApp labels to chats, not to the Android address-book contact card.

Baileys may identify a saved contact using both a phone-number JID and an LID. The agent preserves this link so the dashboard can display the contact and resolve its phone number; newly saved or renamed phone contacts appear after WhatsApp syncs the contact update to the linked agent.

While the Chats list is open, the connected agent subscribes gradually to the visible direct chats' WhatsApp presence; opening an individual chat also requests its presence. The chat list and header show **Online**, **Offline**, a last-seen time, or **Status unavailable** when WhatsApp provides no current status. The student activity metrics now keep a local history of observed status events and show online/offline intervals, durations, and unknown gaps for the selected 30- or 90-day period. History starts with the first update recorded by this version and cannot reconstruct earlier changes. Durations are estimates from updates WhatsApp provides; missed updates, disconnections, or privacy settings can leave unknown time, which is not counted as online or offline. A missing status is never assumed to mean offline.

The dashboard uses a local server-sent event stream to refresh views when chat history, contacts, lesson progress, agent status, media delivery, or message queues change. It reconnects automatically and performs a full refresh every 15 seconds as a fallback. Incoming agent-chat queue state is stored in `data/incoming_chat_queue.json` and is only available through the authenticated dashboard API. Chat read markers are stored separately in `data/chat_read_state.json`.

The eligible-recipient list shows each chat's latest WhatsApp activity date and time when WhatsApp provides one; otherwise it falls back to the latest saved incoming-message timestamp, and shows **Unavailable** if neither exists. The source is labeled in the list. Baileys chat timestamps from full-history sync and live chat/message updates are saved locally in `data/whatsapp_chat_activity.json` and refreshed live in the dashboard. The date filter uses the browser's timezone and counts only chats with a saved incoming student message on the selected date; WhatsApp's general chat activity timestamps do not count. The date count is exact for incoming messages present in the local saved conversation history. Restart the agent with `npm start` to request WhatsApp's initial full-history sync after installing this feature. WhatsApp may not provide a timestamp for every chat, so unavailable dates are left blank rather than estimated.

The admin dashboard asks you to create a password the first time it is opened. Use at least 12 characters; the dashboard stores only a salted scrypt hash in `data/admin_auth.json`. Login protects dashboard APIs and live updates as well as the page. Sessions expire after 12 hours and whenever the dashboard process restarts, and five failed password attempts trigger a five-minute lockout. Use **Lock** to end your session immediately. If you forget the password, stop the dashboard, remove only `data/admin_auth.json`, restart the dashboard, and set a new password. The dashboard remains bound to this computer (`127.0.0.1`); the password is additional local protection, not a way to expose it safely over the network.

When the agent reconnects after the linked WhatsApp device was unavailable, it processes messages WhatsApp explicitly fetches for that unavailable-device session and replies using the normal eligibility, opt-out, and conversation flow. It ignores ordinary old-history sync messages, so reconnecting does not trigger replies to past conversations. Messages are only recovered when WhatsApp delivers them to the linked device.

The agent does not ask students about English difficulties or ask permission before sending lessons. It greets students first and automatically sends matching configured content when their grade is known; if the grade is unknown, it asks only for their grade and school stage.

The Es contacts page lets you **Ban** a number or **Delete** it from the local contact records. Both actions persist the number in `data/blocked_contacts.json`, which the agent checks before replying, following up, or sending queued messages. Delete also removes matching phone/LID aliases from `data/contacts.json`; it does not erase chat history or Android's address book. Use **Allow again** to remove a number from the block list. The contacts table's gender selector supports manual Female, Male, or Not identified values, stored by phone number in `data/contact_gender.json`; selecting Auto restores inference from client messages. Gender is also shown on dashboard chat cards and in the open conversation header. The Overview shows Female, Male, and Not identified counts and percentages across saved Es phone-book contacts, along with how many values were manually set or inferred. These statistics update live when synced contacts or gender values change. Automatic gender is inferred only when messages contain a clear first-person gendered self-description (for example, "أنا طالبة"); it does not guess from the contact name and may be wrong.

The agent also builds a local, aggregate Sudanese Arabic style profile from incoming client messages. It counts occurrences of a curated set of conversational expressions and supplies the most common cues to response generation as optional style examples, never as instructions. It does not retain the original message text in this profile; the counts are stored in `data/sudanese_arabic_style.json`. New observations appear in the agent log. This adapts to expressions in the messages it receives but is not a general-purpose Arabic language trainer.

The Student progress page provides a downloadable local Excel workbook at `data/students.xlsx`. It contains a consolidated Students sheet (contact details, lesson progress, and latest-message summary) and a Conversation History sheet (all currently saved direct-chat messages). The workbook is generated when the dashboard starts and regenerated when contacts, chat history, lesson progress, or lesson configuration changes; its status and download link are shown in the dashboard. This workbook contains private contact details and chat text; keep the local file secure and do not share it without authorization.

Outgoing images, videos, audio, documents, and stickers show upload progress in the agent terminal and the dashboard's Agent view. The dashboard shows the student's saved contact name and refreshes progress immediately from local live updates, with a five-second polling fallback while the Agent view is open. Interactive terminals show a live progress bar; non-interactive terminals log completion or failure.

On the Es contacts page, click a student's name to see their 30- or 90-day incoming-message activity heatmap; contacts with no saved incoming messages show an empty activity state. Use the date filter to show eligible Es contacts who sent a message on that calendar day in your browser's timezone, then select individual chats or **Select all** for that date and queue a bulk message to them. Each matching chat shows its latest incoming-message date and time for that day; the queued broadcast passes this per-recipient activity timestamp, date, and timezone to the agent, which records it as it sends. You can also select individual saved Es recipients or all contacts matching the search without a date filter. Contacts do not need to have messaged first; explicit opt-outs, owner-blocked contacts, configured blocked numbers, and your own number remain excluded. The agent rechecks eligibility before each send. Bulk messages are queued locally and sent individually with a 5-second gap while the WhatsApp agent is connected; faster sending may increase the risk of WhatsApp rate limits or account restrictions. You can stop a queued or active campaign from the dashboard. A stopped campaign may have already delivered messages to recipients shown in its sent count.

The **WhatsApp agent** dashboard tab includes a chat-style feed of the latest saved incoming direct-chat messages and agent replies, in time order, alongside the live terminal output. The feed updates while the tab is open and reflects messages persisted in the local chat history.

---

## Part 4: Linking to Your WhatsApp Account

After initial setup, open the dashboard's WhatsApp agent view and use **Connect agent** or **Disconnect agent** to start or stop the local agent. Disconnecting stops the agent without unlinking the WhatsApp device; connect it again from the dashboard when needed.

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
