import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { config } from './config.js';
import { historyManager } from './history.js';
import { generateClientResponse, learnFromTeacherReply } from './ai.js';
import { lessonManager } from './lesson_manager.js';
import { followUpManager, isFollowUpOptOutRequest } from './followup_manager.js';

// Debounce queue for client messages: Map<jid, { timer: NodeJS.Timeout, texts: string[], pushName: string }>
const debounceMap = new Map();

async function startAgent() {
  console.log('--------------------------------------------------');
  console.log(`Starting WhatsApp Autonomous Agent on Android`);
  console.log(`Owner: ${config.ownerName} | Business: ${config.businessName}`);
  console.log(`Debounce: ${config.debounceSeconds}s | Typing Delay: ${config.typingDelayMs}ms`);
  console.log('--------------------------------------------------');

  const authDir = path.resolve('auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }), // Suppress internal verbose logs for a clean terminal on mobile
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
    syncFullHistory: true // Enable full history sync from phone
  });

  // Save auth state when credentials change
  sock.ev.on('creds.update', saveCreds);

  // Track contacts updates and new contacts from phonebook
  sock.ev.on('contacts.upsert', (contacts) => {
    if (!Array.isArray(contacts)) return;
    for (const c of contacts) {
      const name = c.name || c.notify || c.verifiedName;
      if (name) historyManager.saveContact(c.id, name);
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    if (!Array.isArray(updates)) return;
    for (const u of updates) {
      const name = u.name || u.notify || u.verifiedName;
      if (name) historyManager.saveContact(u.id, name);
    }
  });

  // Monitor connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[ACTION REQUIRED] Scan this QR code on your phone:');
      console.log('Open WhatsApp > Settings (or 3 dots) > Linked Devices > Link a Device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      followUpManager.stop(sock);
      console.log(`\n[Connection] Disconnected. Reason: ${lastDisconnect?.error?.message || 'Unknown'}`);
      if (shouldReconnect) {
        console.log('[Connection] Reconnecting in 5 seconds...');
        setTimeout(() => startAgent(), 5000);
      } else {
        console.log('[Connection] Session logged out. Delete "auth_info_baileys" folder and restart to re-link.');
      }
    } else if (connection === 'open') {
      const esList = historyManager.getEsContactsList();
      console.log('\n==================================================');
      console.log('  [SUCCESS] WhatsApp Agent is CONNECTED & ACTIVE');
      console.log(`  Permanent History: Active for ${esList.length} contacts containing "Es"`);
      console.log('  Listening for incoming client messages...');
      console.log('==================================================\n');
      followUpManager.start(sock);
    }
  });

  // Populate history and contacts from WhatsApp initial sync
  sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
    if (contacts && Array.isArray(contacts)) {
      for (const c of contacts) {
        const name = c.name || c.notify || c.verifiedName;
        if (name) historyManager.saveContact(c.id, name);
      }
    }

    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        const text = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text ||
                     msg.message?.imageMessage?.caption ||
                     '';
        if (text) {
          const role = msg.key.fromMe ? 'agent' : 'client';
          const timestamp = typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp * 1000
            : Date.now();
          const contactName = msg.pushName || '';
          historyManager.addMessage(jid, role, text, timestamp, contactName);
        }
      }
    }
    followUpManager.start(sock, 5000);
  });

  // Process incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // 1. Ignore if message has no payload or is a status update
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      // 2. When message is sent by yourself, learn from your reply!
      if (msg.key.fromMe) {
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text && !jid.endsWith('@g.us')) {
          const recentClientMessages = (historyManager.history[jid] || []).filter(m => m.role === 'client');
          const lastClientMsg = recentClientMessages.length > 0 ? recentClientMessages[recentClientMessages.length - 1].text : '';

          historyManager.addMessage(jid, 'agent', text);

          if (lastClientMsg) {
            learnFromTeacherReply(lastClientMsg, text).catch(() => {});
          }
        }
        continue;
      }

      // 3. Ignore group chats if configured
      if (config.ignoreGroups && jid.endsWith('@g.us')) {
        continue;
      }

      // 4. Check whitelist / blacklist
      const senderNumber = jid.split('@')[0];
      if (!config.shouldReplyTo(senderNumber)) {
        continue;
      }

      // 5. Extract text content
      const text = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text ||
                   msg.message.imageMessage?.caption ||
                   '';

      if (!text.trim()) continue;

      const pushName = msg.pushName || senderNumber;
      historyManager.saveContact(jid, pushName);
      historyManager.addMessage(jid, 'client', text.trim(), undefined, pushName);

      if (isFollowUpOptOutRequest(text)) {
        const newlyOptedOut = followUpManager.optOut(jid);
        if (newlyOptedOut) {
          const acknowledgement = 'تمام، وقفت رسائل المتابعة ليك. لو احتجت أي مساعدة في الإنجليزي، رسل لي في أي وقت.';
          try {
            await sock.sendMessage(jid, { text: acknowledgement });
            historyManager.addMessage(jid, 'agent', acknowledgement);
          } catch (err) {
            console.error(`[Follow-up] Could not send opt-out confirmation to ${jid}:`, err.message);
          }
        }
        continue;
      }

      const isEs = historyManager.isEsContact(jid, pushName);
      const esTag = isEs ? ' [⭐ Es Contact - Permanent History]' : '';
      console.log(`[Incoming] ${pushName} (${senderNumber})${esTag}: "${text.trim()}"`);

      // 6. Handle Debouncing (aggregate rapid bursts into a single reply)
      if (debounceMap.has(jid)) {
        const entry = debounceMap.get(jid);
        clearTimeout(entry.timer);
        entry.texts.push(text.trim());
      } else {
        debounceMap.set(jid, {
          pushName,
          texts: [text.trim()],
          timer: null
        });
      }

      const currentEntry = debounceMap.get(jid);
      currentEntry.timer = setTimeout(async () => {
        const aggregatedText = currentEntry.texts.join('\n');
        debounceMap.delete(jid);

        try {
          // 1. Check if student has an active lesson and is submitting their homework/task!
          if (lessonManager.hasActiveLesson(jid)) {
            await sock.sendPresenceUpdate('composing', jid);
            const isHandled = await lessonManager.handleTaskSubmission(sock, jid, aggregatedText, pushName);
            await sock.sendPresenceUpdate('paused', jid);
            if (isHandled) {
              return;
            }
          }

          // 2. Track student educational grade
          const detectedGrade = lessonManager.detectGrade(aggregatedText);
          if (detectedGrade) {
            lessonManager.setStudentGrade(jid, detectedGrade);
          }

          // Check if student is explicitly asking to start/receive their first lesson
          const wantsToStart = /(ابدأ|ابدا|رسل.*الحصة|عايز.*درس|جاهز|يلا|الحصة الاولى|الحصة الأولى|نبدأ|ابدأ معاي)/i.test(aggregatedText);
          const student = lessonManager.getStudent(jid);
          if (wantsToStart && student?.grade && student.status === 'consulting') {
            console.log(`[Lesson Requested 🎓] ${pushName} is ready for ${student.grade}. Delivering Lesson 1...`);
            await sock.sendPresenceUpdate('composing', jid);
            await lessonManager.deliverLesson(sock, jid, student.grade, 0);
            await sock.sendPresenceUpdate('paused', jid);
            return;
          }

          // Humanization: Show "typing..." presence
          console.log(`[Agent] Generating response for ${pushName}...`);
          await sock.sendPresenceUpdate('composing', jid);

          // Generate response with Gemini
          const reply = await generateClientResponse(jid, pushName, aggregatedText);

          // Wait typing delay to simulate realistic human speed
          if (config.typingDelayMs > 0) {
            await new Promise((res) => setTimeout(res, config.typingDelayMs));
          }

          // Send WhatsApp message
          await sock.sendMessage(jid, { text: reply });
          console.log(`[Agent -> ${pushName}]: "${reply}"`);

          // Record sent reply in history
          historyManager.addMessage(jid, 'agent', reply);

          // Reset presence to paused
          await sock.sendPresenceUpdate('paused', jid);
        } catch (err) {
          console.error(`[Error] Failed to reply to ${pushName}:`, err.message);
          await sock.sendPresenceUpdate('paused', jid);
        }
      }, config.debounceSeconds * 1000);
    }
  });
}

startAgent().catch((err) => {
  console.error('Fatal initialization error:', err);
});
