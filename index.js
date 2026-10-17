import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { buildContactInsertArgs, getPhoneJid, isTermuxAndroid, openContactInsert } from './phonebook.js';
import { sendHumanizedMessage } from './humanization.js';
import { config } from './config.js';
import { historyManager } from './history.js';
import { generateClientResponse, learnFromTeacherReply } from './ai.js';
import { sudaneseArabicLearner } from './sudanese_arabic_learning.js';
import {
  hasLessonDeliveryConsent,
  isLessonDeliveryDecline,
  lessonManager
} from './lesson_manager.js';
import { contactSyncManager } from './contact_sync.js';
import { followUpManager, isFollowUpOptOutRequest } from './followup_manager.js';
import { broadcastManager } from './broadcast_manager.js';
import {
  grammarTutor,
  isGrammarCourseControlRequest,
  isGrammarCourseStartRequest
} from './grammar_tutor.js';
import {
  createIncomingMessageDeduplicator,
  shouldProcessIncomingUpsert
} from './incoming_message_utils.js';
import { IncomingChatQueue } from './incoming_chat_queue.js';
import { whatsappChatActivityStore } from './whatsapp_chat_activity.js';
import {
  WhatsAppPresenceManager
} from './whatsapp_presence.js';
import {
  applyWhatsAppPaidLabel,
  createContactPaymentLabelsStore,
  isExplicitPaidClaim
} from './contact_payment_labels.js';
import {
  clearAgentQr,
  consumeAgentControlRequest,
  readLastAgentAccount,
  readLastConnectedAt,
  writeAgentQr,
  writeAgentStatus
} from './agent_status.js';
import { installAgentLogCapture } from './agent_runtime.js';
import {
  reportMediaUploadProgress,
  wrapSocketWithMediaUploadProgress
} from './media_upload_progress.js';

// Debounce queue for client messages: Map<jid, { timer: NodeJS.Timeout, texts: string[], images: Array<{ data: Buffer, mimeType: string }>, pushName: string }>
installAgentLogCapture();
const debounceMap = new Map();
const isDuplicateIncomingMessage = createIncomingMessageDeduplicator();
const MAX_INCOMING_IMAGE_BYTES = 10 * 1024 * 1024;
let paymentLabelTimer = null;
let processingPaymentLabels = false;
let agentConnectionState = 'starting';
let lastConnectedAt;
let agentAccount = null;
let agentHeartbeatTimer = null;
let dashboardDisconnectRequested = false;
let agentRespondingEnabled = true;
const contactPaymentLabels = createContactPaymentLabelsStore();
const whatsappPresenceManager = new WhatsAppPresenceManager();

function saveWhatsAppContacts(contacts) {
  if (!Array.isArray(contacts)) return;
  for (const contact of contacts) {
    historyManager.saveWhatsAppContact(contact);
  }
}

try {
  lastConnectedAt = readLastConnectedAt();
  agentAccount = readLastAgentAccount();
} catch (error) {
  lastConnectedAt = null;
  agentAccount = null;
  console.error('[Agent Status] Could not read previous WhatsApp connection time:', error.message);
}

function getWhatsAppAccount(me) {
  if (!me || typeof me !== 'object') return null;
  const phoneJid = getPhoneJid(me.jid, me.id);
  const phoneNumber = phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0];
  if (!phoneNumber || !/^\d+$/.test(phoneNumber)) return null;
  const name = typeof me.name === 'string' && me.name !== '~' ? me.name.trim() : '';
  return { name, phoneNumber };
}

function updateAgentStatus(connectionState = agentConnectionState, account = agentAccount) {
  const newlyConnected = connectionState === 'connected' && agentConnectionState !== 'connected';
  agentConnectionState = connectionState;
  if (account) agentAccount = account;
  if (newlyConnected) lastConnectedAt = new Date().toISOString();
  try {
    writeAgentStatus(agentConnectionState, lastConnectedAt, agentAccount, undefined, agentRespondingEnabled);
  } catch (error) {
    console.error('[Agent Status] Could not save WhatsApp connection status:', error.message);
  }
}

async function processPendingPaymentLabels(sock) {
  if (processingPaymentLabels) return;
  processingPaymentLabels = true;
  try {
    for (const label of contactPaymentLabels.pendingActions()) {
      try {
        await applyWhatsAppPaidLabel(sock, label.jid, label.whatsappAction);
        if (label.whatsappAction === 'add') {
          contactPaymentLabels.markWhatsAppApplied(label.number);
        } else {
          contactPaymentLabels.markWhatsAppRemoved(label.number);
        }
        console.log(`[Contact Labels] Applied the ${label.label} status in WhatsApp for ${label.number.slice(-4)}.`);
      } catch (error) {
        console.error(`[Contact Labels] Could not apply the pending ${label.label} WhatsApp label for ${label.number.slice(-4)}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[Contact Labels] Could not read pending WhatsApp label changes:', error.message);
  } finally {
    processingPaymentLabels = false;
  }
}

async function startAgent() {
  try {
    clearAgentQr();
  } catch (error) {
    console.error('[Agent Status] Could not clear old WhatsApp pairing QR:', error.message);
  }
  updateAgentStatus('connecting');
  if (!agentHeartbeatTimer) {
    agentHeartbeatTimer = setInterval(() => updateAgentStatus(), 10_000);
    agentHeartbeatTimer.unref?.();
  }
  console.log('--------------------------------------------------');
  console.log(`Starting WhatsApp Autonomous Agent on Android`);
  console.log(`Owner: ${config.ownerName} | Business: ${config.businessName}`);
  console.log(`Debounce: ${config.debounceSeconds}s | Typing speed: ${config.typingWordsPerMinute} WPM`);
  console.log('--------------------------------------------------');

  const authDir = path.resolve('auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  updateAgentStatus('connecting', getWhatsAppAccount(state.creds.me));
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({
    version,
    logger, // Suppress internal verbose logs for a clean terminal on mobile
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
    syncFullHistory: true, // Enable full history sync from phone
    options: { onUploadProgress: reportMediaUploadProgress }
  });
  wrapSocketWithMediaUploadProgress(sock);
  const disconnectRequestTimer = setInterval(() => {
    try {
      const action = consumeAgentControlRequest();
      if (!action) return;
      if (action === 'disconnect') {
        dashboardDisconnectRequested = true;
        updateAgentStatus('disconnecting');
        console.log('[Connection] Dashboard requested an agent disconnect; keeping the WhatsApp device linked.');
        sock.end(new Error('Agent disconnected from the dashboard.'));
        return;
      }
      agentRespondingEnabled = action === 'resume_replies';
      updateAgentStatus();
      console.log(`[Agent Control] Automatic replies ${agentRespondingEnabled ? 'resumed' : 'paused'}; incoming messages will still be recorded.`);
    } catch (error) {
      console.error('[Agent Control] Could not process the dashboard disconnect request:', error.message);
    }
  }, 1000);
  disconnectRequestTimer.unref?.();
  const incomingChatQueue = new IncomingChatQueue();
  let processingChatQueue = false;
  const processNextQueuedChat = async () => {
    if (processingChatQueue) return;
    processingChatQueue = true;
    try {
      let entry;
      while ((entry = incomingChatQueue.takeNext())) {
        try {
          await entry.process();
        } catch (error) {
          console.error(`[Agent Queue] Could not process chat ${entry.jid}:`, error.message);
        } finally {
          incomingChatQueue.finish(entry);
        }
      }
    } finally {
      processingChatQueue = false;
    }
  };

  // Save auth state when credentials change
  sock.ev.on('creds.update', saveCreds);

  // Track contacts updates and new contacts from phonebook
  sock.ev.on('contacts.upsert', saveWhatsAppContacts);

  sock.ev.on('contacts.update', saveWhatsAppContacts);

  const saveWhatsAppChatActivity = chats => {
    try {
      whatsappChatActivityStore.record(chats);
    } catch (error) {
      console.error('[WhatsApp Chat Activity] Could not save chat timestamps:', error.message);
    }
  };
  sock.ev.on('chats.upsert', saveWhatsAppChatActivity);
  sock.ev.on('chats.update', saveWhatsAppChatActivity);
  sock.ev.on('presence.update', update => {
    try {
      whatsappPresenceManager.recordPresenceUpdate(update);
    } catch (error) {
      console.error('[WhatsApp Presence] Could not save presence update:', error.message);
    }
  });

  // Monitor connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        writeAgentQr(qr);
      } catch (error) {
        console.error('[Agent Status] Could not save WhatsApp pairing QR:', error.message);
      }
      console.log('\n[ACTION REQUIRED] Scan this QR code on your phone:');
      console.log('Open WhatsApp > Settings (or 3 dots) > Linked Devices > Link a Device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = !dashboardDisconnectRequested &&
        statusCode !== DisconnectReason.loggedOut;

      clearInterval(disconnectRequestTimer);
      followUpManager.stop(sock);
      broadcastManager.stop(sock);
      contactSyncManager.stop(sock);
      whatsappPresenceManager.stop();
      if (paymentLabelTimer) clearInterval(paymentLabelTimer);
      paymentLabelTimer = null;
      try {
        clearAgentQr();
      } catch (error) {
        console.error('[Agent Status] Could not clear WhatsApp pairing QR:', error.message);
      }
      updateAgentStatus('disconnected');
      console.log(`\n[Connection] Disconnected. Reason: ${lastDisconnect?.error?.message || 'Unknown'}`);
      if (shouldReconnect) {
        console.log('[Connection] Reconnecting in 5 seconds...');
        setTimeout(() => startAgent(), 5000);
      } else {
        console.log(dashboardDisconnectRequested
          ? '[Connection] Agent stopped by dashboard. Restart it with npm start to reconnect.'
          : '[Connection] Session logged out. Delete "auth_info_baileys" folder and restart to re-link.');
      }
    } else if (connection === 'open') {
      try {
        clearAgentQr();
      } catch (error) {
        console.error('[Agent Status] Could not clear WhatsApp pairing QR:', error.message);
      }
      updateAgentStatus('connected', getWhatsAppAccount(state.creds.me));
      const esList = historyManager.getEsContactsList();
      console.log('\n==================================================');
      console.log('  [SUCCESS] WhatsApp Agent is CONNECTED & ACTIVE');
      console.log(`  Permanent History: Active for ${esList.length} contacts containing "Es"`);
      console.log('  Listening for incoming client messages...');
      console.log('==================================================\n');
      followUpManager.start(sock);
      broadcastManager.start(sock);
      contactSyncManager.start(sock);
      whatsappPresenceManager.start(sock);
      if (paymentLabelTimer) clearInterval(paymentLabelTimer);
      paymentLabelTimer = setInterval(() => {
        processPendingPaymentLabels(sock).catch(error =>
          console.error('[Contact Labels] Queue processing failed:', error.message));
      }, 3000);
      paymentLabelTimer.unref?.();
      processPendingPaymentLabels(sock).catch(error =>
        console.error('[Contact Labels] Queue processing failed:', error.message));
    }
  });

  // Populate history and contacts from WhatsApp initial sync
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    saveWhatsAppContacts(contacts);
    saveWhatsAppChatActivity(chats);

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
  sock.ev.on('messages.upsert', async ({ messages, type, requestId }) => {
    if (!shouldProcessIncomingUpsert({ type, requestId })) return;
    if (requestId) {
      console.log(`[Catch-up] Processing ${messages.length} message(s) fetched after the linked device was unavailable.`);
    }

    for (const msg of messages) {
      if (isDuplicateIncomingMessage(msg)) continue;
      // 1. Ignore if message has no payload or is a status update
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;
      const alternateJid = msg.key.remoteJidAlt || '';
      const phoneJid = getPhoneJid(jid, alternateJid);
      try {
        whatsappChatActivityStore.recordMessage(jid, msg.messageTimestamp);
      } catch (error) {
        console.error('[WhatsApp Chat Activity] Could not save message timestamp:', error.message);
      }

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
      const senderNumber = phoneJid
        ? phoneJid.slice(0, -'@s.whatsapp.net'.length).split(':')[0]
        : jid.split('@')[0];
      if (!config.shouldReplyTo(senderNumber)) {
        continue;
      }

      // 5. Extract text and photo content, including images without captions.
      const messageContent = normalizeMessageContent(msg.message);
      const imageMessage = messageContent?.imageMessage;
      const text = messageContent?.conversation ||
                   messageContent?.extendedTextMessage?.text ||
                   imageMessage?.caption ||
                   (imageMessage ? 'أرسل صورة' : '');

      if (!text.trim()) continue;

      const pushName = msg.pushName || phoneJid?.split('@')[0] || senderNumber;
      const hadPriorConversation = historyManager.hasConversation(jid, alternateJid, phoneJid);
      const existingWelcomeState = historyManager.getWelcomeSampleState(jid, alternateJid, phoneJid);
      const isFirstWelcomeMessage = !hadPriorConversation && !existingWelcomeState;
      historyManager.saveContact(jid, pushName);
      historyManager.addMessage(jid, 'client', text.trim(), undefined, pushName);

      if (!agentRespondingEnabled) {
        console.log(`[Agent Control] Recorded incoming message from ${pushName}; automatic replies are paused.`);
        continue;
      }

      if (historyManager.isOwnerBlockedContact(jid, alternateJid)) {
        console.log(`[Ignored - Owner Block] ${pushName} (${senderNumber})`);
        continue;
      }

      const isEs = historyManager.isEsContact(jid, pushName);
      const isOwnerAllowed = historyManager.isOwnerAllowedContact(jid, alternateJid);
      const isSavedContact = historyManager.isSavedContact(jid, alternateJid);
      if (!isSavedContact && phoneJid && !historyManager.hasContactSavePrompted(jid, alternateJid)) {
        const contactName = `Es - ${pushName || phoneJid.split('@')[0]}`;
        if (isTermuxAndroid() && buildContactInsertArgs(phoneJid, contactName)) {
          try {
            await openContactInsert(phoneJid, contactName);
            historyManager.markContactSavePrompted(jid, alternateJid);
            console.log(`[Phonebook] Opened Android contact form for ${contactName}. Save it on the phone to add it.`);
          } catch (err) {
            console.error(`[Phonebook] Could not open contact form for ${phoneJid.split('@')[0].slice(-4)}:`, err.message);
          }
        }
      }

      if (!isEs && isSavedContact && !isOwnerAllowed) {
        console.log(`[Ignored - Saved Non-Es Contact] ${pushName} (${senderNumber})`);
        continue;
      }
      if (!isEs && !isOwnerAllowed) {
        console.log(`[Enabled - New Unsaved Contact] ${pushName} (${senderNumber})`);
      } else if (isOwnerAllowed) {
        console.log(`[Enabled - Owner Allowlist] ${pushName} (${senderNumber})`);
      }

      if (isFirstWelcomeMessage) {
        historyManager.setWelcomeSampleState('pending_grade', jid, alternateJid, phoneJid);
      }

      try {
        const learning = sudaneseArabicLearner.observe(text.trim());
        if (learning.newCues.length) {
          console.log(`[Arabic Learning] New Sudanese expressions observed: ${learning.newCues.join(', ')}`);
        }
      } catch (error) {
        console.error('[Arabic Learning] Could not record client language cues:', error.message);
      }

      let incomingImage = null;
      if (imageMessage) {
        try {
          const imageBuffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );
          if (imageBuffer.length > MAX_INCOMING_IMAGE_BYTES) {
            throw new Error('Incoming image exceeds the 10 MB limit');
          }
          incomingImage = {
            data: imageBuffer,
            mimeType: imageMessage.mimetype || 'image/jpeg'
          };
        } catch (err) {
          console.error(`[Image] Could not download image from ${pushName}:`, err.message);
          const reply = 'وصلتني الصورة، لكن ما قدرت أفتحها هسي. ممكن ترسلها مرة تانية كصورة واضحة؟';
          await sendHumanizedMessage(sock, jid, reply, config.typingWordsPerMinute);
          historyManager.addMessage(jid, 'agent', reply);
          continue;
        }
      }

      if (isFollowUpOptOutRequest(text)) {
        const newlyOptedOut = followUpManager.optOut(jid, alternateJid);
        if (newlyOptedOut) {
          const acknowledgement = 'تمام، وقفت رسائل المتابعة ليك. لو احتجت أي مساعدة في الإنجليزي، رسل لي في أي وقت.';
          try {
            await sendHumanizedMessage(sock, jid, acknowledgement, config.typingWordsPerMinute);
            historyManager.addMessage(jid, 'agent', acknowledgement);
          } catch (err) {
            console.error(`[Follow-up] Could not send opt-out confirmation to ${jid}:`, err.message);
          }
        }
        continue;
      }

      const esTag = ' [⭐ Es Contact - Permanent History]';
      console.log(`[Incoming] ${pushName} (${senderNumber})${esTag}: "${text.trim()}"`);

      // 6. Handle Debouncing (aggregate rapid bursts into a single reply)
      if (debounceMap.has(jid)) {
        const entry = debounceMap.get(jid);
        clearTimeout(entry.timer);
        entry.texts.push(text.trim());
        if (incomingImage) entry.images.push(incomingImage);
        incomingChatQueue.delay(entry.queueEntry);
      } else {
        debounceMap.set(jid, {
          pushName,
          texts: [text.trim()],
          images: incomingImage ? [incomingImage] : [],
          senderNumber,
          timer: null
        });
      }

      const currentEntry = debounceMap.get(jid);
      currentEntry.senderNumber = senderNumber;
      if (!currentEntry.queueEntry) {
        const queuedEntry = {
          jid,
          pushName: currentEntry.pushName,
          texts: currentEntry.texts,
          images: currentEntry.images,
          senderNumber: currentEntry.senderNumber,
          queuedAt: new Date().toISOString(),
          process: null
        };
        queuedEntry.process = async () => {
            if (!agentRespondingEnabled) {
              console.log(`[Agent Control] Recorded incoming message from ${queuedEntry.pushName}; automatic replies are paused.`);
              return;
            }
            const aggregatedText = queuedEntry.texts.join('\n');
          const queuedSenderNumber = queuedEntry.senderNumber;
          if (!config.shouldReplyTo(queuedSenderNumber)) {
            console.log(`[Ignored - Blocked Number] ${queuedSenderNumber.slice(-4)}`);
            return;
          }

          const paidClaim = isExplicitPaidClaim(aggregatedText);
          let paidLabel = null;
          try {
            if (paidClaim) {
              contactPaymentLabels.markPaid(queuedSenderNumber, jid);
            }
          } catch (error) {
            console.error('[Contact Labels] Could not save student-reported payment status:', error.message);
          }
          try {
            paidLabel = contactPaymentLabels.get(queuedSenderNumber);
          } catch (error) {
            console.error('[Contact Labels] Could not read payment label status:', error.message);
          }
          if ((paidClaim || paidLabel) && !paidLabel?.whatsappAppliedAt) {
            try {
              await applyWhatsAppPaidLabel(sock, jid);
              if (paidLabel) contactPaymentLabels.markWhatsAppApplied(queuedSenderNumber);
              console.log(`[Contact Labels] Applied the paid label to ${queuedEntry.pushName}.`);
            } catch (error) {
              console.error(`[Contact Labels] Could not apply WhatsApp paid label to ${queuedEntry.pushName}:`, error.message);
            }
          }

          try {
            const grammarStudent = grammarTutor.getStudent(jid, phoneJid);
            if (grammarStudent &&
                (grammarTutor.isActive(jid, phoneJid) ||
                  isGrammarCourseControlRequest(aggregatedText))) {
              const grammarGrade = lessonManager.detectGrade(aggregatedText) || grammarStudent.gradeKey;
              const grammarHandled = await grammarTutor.handleMessage(
                sock, jid, aggregatedText, grammarGrade, phoneJid
              );
              if (grammarHandled) return;
            }

            if (queuedEntry.images.length === 0 && lessonManager.isLessonVideoRequest(aggregatedText)) {
              await sock.sendPresenceUpdate('composing', jid);
              const resent = await lessonManager.resendCurrentLessonVideo(sock, jid, phoneJid);
              await sock.sendPresenceUpdate('paused', jid);
              if (resent) return;
            }

            if (lessonManager.hasActiveLesson(jid, phoneJid) && queuedEntry.images.length === 0) {
              await sock.sendPresenceUpdate('composing', jid);
              const isHandled = await lessonManager.handleTaskSubmission(
                sock, jid, aggregatedText, queuedEntry.pushName, phoneJid
              );
              await sock.sendPresenceUpdate('paused', jid);
              if (isHandled) return;
            }

            const detectedGrade = lessonManager.detectGrade(aggregatedText);
            let student = lessonManager.getStudent(jid, phoneJid);
            if (isGrammarCourseStartRequest(aggregatedText)) {
              if (lessonManager.hasActiveLesson(jid, phoneJid)) {
                await sendHumanizedMessage(
                  sock,
                  jid,
                  'Finish the video lesson exercise you already have first. Then ask me to start the grammar course.',
                  config.typingWordsPerMinute
                );
                return;
              }
              await grammarTutor.handleMessage(
                sock,
                jid,
                aggregatedText,
                detectedGrade ||
                  [...(historyManager.history[jid] || [])]
                    .reverse()
                    .filter(message => message.role === 'client')
                    .map(message => lessonManager.detectGrade(message.text))
                    .find(Boolean) ||
                  student?.grade,
                phoneJid
              );
              return;
            }

            const chatHistory = historyManager.history[jid] || [];
            const previousAgentMessage = [...chatHistory]
              .reverse()
              .find(message => message.role === 'agent')?.text || '';
            const explicitLessonRequest = lessonManager.isLessonDeliveryRequest(aggregatedText);
            if (isLessonDeliveryDecline(aggregatedText, previousAgentMessage)) {
              historyManager.setLessonDeliveryConsent(false, jid, alternateJid, phoneJid);
            } else if (explicitLessonRequest ||
                hasLessonDeliveryConsent(aggregatedText, previousAgentMessage)) {
              historyManager.setLessonDeliveryConsent(true, jid, alternateJid, phoneJid);
            }
            const hasLessonConsent = historyManager.hasLessonDeliveryConsent(jid, alternateJid, phoneJid);
            const gradeFromHistory = [...chatHistory]
              .reverse()
              .filter(message => message.role === 'client')
              .map(message => lessonManager.detectGrade(message.text))
              .find(Boolean);
            const requestedGrade = detectedGrade || gradeFromHistory || student?.grade;
            const gradeLessons = requestedGrade ? lessonManager.lessonsConfig[requestedGrade]?.lessons : null;
            const firstConfiguredLesson = requestedGrade
              ? lessonManager.getWelcomeSampleLesson(requestedGrade)
              : null;
            const nextConfiguredLesson = student?.status === 'awaiting_content' &&
              student.grade === requestedGrade && requestedGrade
              ? lessonManager.getNextSequentialLesson(
                requestedGrade,
                student.currentLessonId || gradeLessons?.[student.currentLessonIndex]?.id
              )
              : null;
            const welcomeState = historyManager.getWelcomeSampleState(jid, alternateJid, phoneJid);
            let welcomeSampleMode = null;
            let shouldSendWelcomeSample = false;
            if (welcomeState === 'pending_grade') {
              if (!requestedGrade) {
                welcomeSampleMode = 'ask_grade';
              } else {
                const canStartFreshSequence = !student || student.status === 'consulting' ||
                  (detectedGrade && student.grade !== detectedGrade);
                if (firstConfiguredLesson) {
                  if (canStartFreshSequence && !lessonManager.hasActiveLesson(jid, phoneJid) &&
                      queuedEntry.images.length === 0) {
                    welcomeSampleMode = 'sample';
                    shouldSendWelcomeSample = true;
                  } else {
                    if (lessonManager.hasActiveLesson(jid, phoneJid) || queuedEntry.images.length > 0) {
                      welcomeSampleMode = 'deferred';
                    }
                    historyManager.setWelcomeSampleState('deferred', jid, alternateJid, phoneJid);
                  }
                } else {
                  if (canStartFreshSequence) {
                    welcomeSampleMode = 'unavailable';
                  }
                  historyManager.setWelcomeSampleState(
                    canStartFreshSequence ? 'unavailable' : 'deferred',
                    jid,
                    alternateJid,
                    phoneJid
                  );
                }
              }
            }
            const wantsLessonNow = explicitLessonRequest || hasLessonConsent;
            const shouldStartAfterReply = !shouldSendWelcomeSample &&
              requestedGrade &&
              queuedEntry.images.length === 0 &&
              !lessonManager.hasActiveLesson(jid, phoneJid) &&
              ((firstConfiguredLesson && (!student || student.status === 'consulting' || wantsLessonNow ||
                (detectedGrade && student.grade !== detectedGrade))) ||
                nextConfiguredLesson?.status === 'ready');
            const lessonIndexToStart = nextConfiguredLesson?.status === 'ready'
              ? nextConfiguredLesson.lessonIndex
              : 0;

            if (detectedGrade && (!student || student.grade !== detectedGrade) &&
                !lessonManager.hasActiveLesson(jid, phoneJid)) {
              lessonManager.setStudentGrade(jid, detectedGrade, phoneJid);
              student = lessonManager.getStudent(jid, phoneJid);
            }

            if (requestedGrade && !gradeLessons?.length) {
              console.log(`[Lesson Setup] No lessons are configured yet for ${requestedGrade}. Continuing the conversation without sending a different grade's lesson.`);
            }

            console.log(`[Agent] Generating response for ${queuedEntry.pushName}...`);
            const reply = await generateClientResponse(
              jid,
              queuedEntry.pushName,
              aggregatedText,
              queuedEntry.images,
              requestedGrade || student?.grade || null,
              Boolean(shouldStartAfterReply || shouldSendWelcomeSample),
              Boolean(hasLessonConsent),
              phoneJid,
              grammarStudent && grammarTutor.isActive(jid, phoneJid)
                ? grammarTutor.getCurrentLesson(jid, phoneJid)?.title || null
                : null,
              welcomeSampleMode
            );
            if (!agentRespondingEnabled) {
              console.log(`[Agent Control] Skipped generated reply to ${queuedEntry.pushName}; automatic replies were paused.`);
              return;
            }
            await sendHumanizedMessage(sock, jid, reply, config.typingWordsPerMinute);
            console.log(`[Agent -> ${queuedEntry.pushName}]: "${reply}"`);
            historyManager.addMessage(jid, 'agent', reply);
            if (shouldSendWelcomeSample) {
              historyManager.setWelcomeSampleState('delivering', jid, alternateJid, phoneJid);
              try {
                await sock.sendPresenceUpdate('composing', jid);
                const delivered = await lessonManager.deliverLesson(sock, jid, requestedGrade, 0, phoneJid);
                await sock.sendPresenceUpdate('paused', jid);
                historyManager.setWelcomeSampleState(
                  delivered ? 'sent' : 'failed',
                  jid,
                  alternateJid,
                  phoneJid
                );
                if (delivered) {
                  historyManager.setLessonDeliveryConsent(false, jid, alternateJid, phoneJid);
                  console.log(`[Welcome Sample] Delivered the first lesson to ${queuedEntry.pushName} for ${requestedGrade}.`);
                }
              } catch (error) {
                historyManager.setWelcomeSampleState('failed', jid, alternateJid, phoneJid);
                throw error;
              }
            } else if (shouldStartAfterReply) {
              console.log(`[Lesson Auto-Start 🎓] Greeting ${queuedEntry.pushName} and delivering the next configured lesson for ${requestedGrade}...`);
              await sock.sendPresenceUpdate('composing', jid);
              const delivered = await lessonManager.deliverLesson(
                sock, jid, requestedGrade, lessonIndexToStart, phoneJid
              );
              await sock.sendPresenceUpdate('paused', jid);
              if (delivered) historyManager.setLessonDeliveryConsent(false, jid, alternateJid, phoneJid);
            } else if (hasLessonConsent && requestedGrade && !gradeLessons?.length) {
              console.log(`[Lesson Setup] Lesson consent saved for ${queuedEntry.pushName}; waiting for configured content for ${requestedGrade}.`);
            }
          } catch (err) {
            console.error(`[Error] Failed to reply to ${queuedEntry.pushName}:`, err.message);
            await sock.sendPresenceUpdate('paused', jid);
          }
        };
        currentEntry.queueEntry = incomingChatQueue.enqueue(queuedEntry);
      }

      const queuedEntry = currentEntry.queueEntry;
      currentEntry.texts = queuedEntry.texts;
      currentEntry.images = queuedEntry.images;
      queuedEntry.pushName = currentEntry.pushName;
      queuedEntry.senderNumber = currentEntry.senderNumber;
      currentEntry.timer = setTimeout(() => {
        debounceMap.delete(jid);
        incomingChatQueue.markReady(queuedEntry);
        processNextQueuedChat().catch(error =>
          console.error('[Agent Queue] Could not process incoming chat queue:', error.message));
      }, config.debounceSeconds * 1000);
    }
  });
}

startAgent().catch((err) => {
  console.error('Fatal initialization error:', err);
});
