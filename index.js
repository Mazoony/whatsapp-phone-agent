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
import { generateClientResponse } from './ai.js';
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
  createIncomingMessageDeduplicator,
  shouldProcessIncomingUpsert
} from './incoming_message_utils.js';
import { IncomingChatQueue } from './incoming_chat_queue.js';
import { readAgentMediaActivities, writeAgentMediaActivity } from './agent_media_activity.js';
import {
  consumeAgentMediaRetryRequests
} from './agent_media_retry.js';
import { whatsappChatActivityStore } from './whatsapp_chat_activity.js';
import {
  WhatsAppPresenceManager
} from './whatsapp_presence.js';
import {
  applyWhatsAppPaidLabel,
  createContactPaymentLabelsStore,
  isExplicitPaidClaim
} from './contact_payment_labels.js';
import { scanPaymentReceipt } from './payment_scanner.js';
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
import {
  createScheduledLessonStore,
  formatScheduledDateTime,
  isLessonScheduleRequest,
  isRecurringLessonScheduleRequest,
  looksLikeScheduleDateTime,
  parseScheduledDateTime,
  getNextDailyLessonTime
} from './scheduled_lessons.js';

// Debounce queue for client messages: Map<jid, { timer: NodeJS.Timeout, texts: string[], images: Array<{ data: Buffer, mimeType: string }>, pushName: string }>
installAgentLogCapture();
const debounceMap = new Map();
const isDuplicateIncomingMessage = createIncomingMessageDeduplicator();
const scheduledLessonStore = createScheduledLessonStore();
let scheduledLessonTimer = null;
let processingScheduledLessons = false;

function isScheduleConfirmation(text) {
  return /^(?:yes|yeah|yep|sure|okay|ok|confirm|please do|ايوة|أيوة|ايوه|أيوه|ايوا|اي|نعم|تمام|ماشي|موافق|موافقه|موافقة)[.!؟\s]*$/i
    .test(text.trim());
}

function isScheduleRejection(text) {
  return /^(?:no|nope|cancel|not now|لا|الغاء|إلغاء|ما داير|ما دايره)[.!؟\s]*$/i
    .test(text.trim());
}

function hasArabicText(text) {
  return /[\u0600-\u06FF]/.test(text);
}

function getSchedulableLesson(student, gradeKey, jid, phoneJid) {
  if (!gradeKey) return null;
  const lessons = lessonManager.lessonsConfig[gradeKey]?.lessons || [];
  let lessonIndex = 0;
  if (student && lessonManager.hasActiveLesson(jid, phoneJid)) {
    lessonIndex = student.currentLessonIndex;
  } else if (student?.currentLessonId) {
    if (!/^lesson_\d+$/.test(student.currentLessonId)) return null;
    const next = lessonManager.getNextSequentialLesson(gradeKey, student.currentLessonId);
    if (next.status !== 'ready') return null;
    lessonIndex = next.lessonIndex;
  }
  const lesson = lessons[lessonIndex];
  if (!lesson?.videoFile || typeof lesson.taskMessage !== 'string' || !lesson.taskMessage.trim() ||
      !Array.isArray(lesson.answerKey) || !lesson.answerKey.length) {
    return null;
  }
  return { lessonIndex, lesson };
}

function scheduleClarification(parsed, arabic) {
  if (parsed.status === 'ambiguous') {
    return parsed.missing?.includes('date')
      ? arabic
        ? 'حدد اليوم كمان، والساعة دي تقصدها صباحاً ولا مساءً؟'
        : 'Please also give the date and clarify whether that time is morning or evening.'
      : arabic
        ? 'تقصد الساعة دي صباحاً ولا مساءً؟'
        : 'Do you mean that time in the morning or evening?';
  }
  if (parsed.status === 'past') {
    return arabic
      ? 'الوقت دا فات. أرسل لي موعد جاي بالتاريخ والساعة بتوقيت السودان.'
      : 'That time has already passed. Please send a future date and time in Sudan time.';
  }
  if (parsed.status === 'invalid') {
    return arabic
      ? 'ما قدرت أحدد الساعة. أرسلها مثلاً ٤:٣٠ مساءً أو 16:30.'
      : 'I could not read the time. Please send it as 4:30 pm or 16:30.';
  }
  if (parsed.status === 'incomplete' && parsed.missing?.length === 1) {
    return parsed.missing[0] === 'date'
      ? arabic
        ? 'حدد اليوم والتاريخ المطلوب، مثلاً: بكرة أو يوم الخميس، بتوقيت السودان.'
        : 'Please specify the date, for example tomorrow or Thursday, in Sudan time.'
      : arabic
        ? 'حدد الساعة بالدقيقة وهل هي صباحاً أو مساءً، بتوقيت السودان.'
        : 'Please specify the exact time and whether it is am or pm, in Sudan time.';
  }
  return arabic
    ? 'حدد اليوم والساعة بالتحديد بتوقيت السودان، مثلاً: بكرة الساعة ٤ مساءً.'
    : 'Please give me the exact date and time in Sudan time, for example: tomorrow at 4 pm.';
}

async function processDueScheduledLessons(sock) {
  if (processingScheduledLessons) return;
  processingScheduledLessons = true;
  try {
    let schedule;
    while ((schedule = scheduledLessonStore.claimDue())) {
      const phoneJid = getPhoneJid(schedule.jid, schedule.phoneJid);
      const phoneNumber = phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0] || '';
      const lastLessonDelivery = lessonManager.getLatestLessonDeliveryAt(schedule.jid, schedule.phoneJid);
      if (lastLessonDelivery !== null &&
          Date.now() - lastLessonDelivery < 24 * 60 * 60 * 1000) {
        try {
          scheduledLessonStore.reschedule(
            schedule.id,
            getNextDailyLessonTime(lastLessonDelivery)
          );
          console.log(`[Scheduled Lesson] Deferred ${schedule.lessonTitle} for ${schedule.studentName} until the 24-hour lesson interval has passed.`);
        } catch (error) {
          scheduledLessonStore.complete(schedule.id, 'failed', error.message);
          console.error(`[Scheduled Lesson] Could not defer ${schedule.lessonTitle}:`, error.message);
        }
        continue;
      }
      const contact = Object.entries(historyManager.contacts).find(([jid, item]) =>
        jid === schedule.jid || getPhoneJid(jid, item.jid) === phoneJid)?.[1];
      const ownPhone = sock.user?.id?.split('@')[0].split(':')[0];
      const optedOut = (followUpManager.state.optedOutJids || []).some(jid =>
        jid === schedule.jid || (phoneJid && getPhoneJid(jid, historyManager.contacts[jid]?.jid) === phoneJid));
      if (!phoneNumber || !config.shouldReplyTo(phoneNumber) || contact?.ownerBlocked ||
          optedOut || phoneNumber === ownPhone) {
        scheduledLessonStore.complete(schedule.id, 'failed', 'Student is unavailable, blocked, opted out, or not eligible for automated delivery.');
        continue;
      }

      try {
        const delivered = await lessonManager.deliverLesson(
          sock,
          schedule.jid,
          schedule.gradeKey,
          schedule.lessonIndex,
          schedule.phoneJid
        );
        scheduledLessonStore.complete(
          schedule.id,
          delivered ? 'sent' : 'failed',
          delivered ? null : 'Lesson delivery did not complete successfully.'
        );
        console.log(`[Scheduled Lesson] ${schedule.lessonTitle} for ${schedule.studentName}: ${delivered ? 'sent' : 'failed'}.`);
      } catch (error) {
        scheduledLessonStore.complete(schedule.id, 'failed', error.message);
        console.error(`[Scheduled Lesson] Could not deliver ${schedule.lessonTitle} to ${phoneNumber.slice(-4)}:`, error.message);
      }
    }
  } finally {
    processingScheduledLessons = false;
  }
}
const MAX_INCOMING_IMAGE_BYTES = 10 * 1024 * 1024;
let paymentLabelTimer = null;
let processingPaymentLabels = false;
let agentConnectionState = 'starting';
let lastConnectedAt;
let agentAccount = null;
let agentHeartbeatTimer = null;
let mediaRetryTimer = null;
let dashboardDisconnectRequested = false;
let agentRespondingEnabled = true;
let agentQueuePaused = false;
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
    writeAgentStatus(
      agentConnectionState,
      lastConnectedAt,
      agentAccount,
      undefined,
      agentRespondingEnabled,
      agentQueuePaused
    );
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
      if (typeof action === 'object' && action.action === 'cancel_queued_chat') {
        const pendingChat = debounceMap.get(action.jid);
        const cancelledEntry = incomingChatQueue.cancelWaiting(action.jid);
        if (cancelledEntry) {
          if (pendingChat?.queueEntry === cancelledEntry) {
            clearTimeout(pendingChat.timer);
            debounceMap.delete(action.jid);
          }
          console.log(`[Agent Queue] Cancelled queued handling for ${cancelledEntry.pushName || action.jid}; incoming messages remain saved.`);
        } else {
          console.log(`[Agent Queue] Could not cancel ${action.jid}; it is no longer waiting in the queue.`);
        }
        updateAgentStatus();
        return;
      }
      if (action === 'disconnect') {
        dashboardDisconnectRequested = true;
        updateAgentStatus('disconnecting');
        console.log('[Connection] Dashboard requested an agent disconnect; keeping the WhatsApp device linked.');
        sock.end(new Error('Agent disconnected from the dashboard.'));
        return;
      }
      if (action === 'pause_queue' || action === 'resume_queue') {
        agentQueuePaused = action === 'pause_queue';
        incomingChatQueue.setPaused(agentQueuePaused);
        updateAgentStatus();
        console.log(`[Agent Queue] New chat handling ${agentQueuePaused ? 'paused' : 'resumed'}; the current chat will finish normally.`);
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
  let processingMediaRetries = false;
  mediaRetryTimer = setInterval(async () => {
    if (processingMediaRetries) return;
    processingMediaRetries = true;
    try {
      const requests = consumeAgentMediaRetryRequests();
      for (const request of requests) {
        const activity = readAgentMediaActivities().find(item => item.id === request.activityId);
        if (!activity || activity.status !== 'retrying') continue;
        try {
          await lessonManager.resendMediaActivity(sock, activity);
        } catch (error) {
          console.error(`[Media retry] Could not resend activity ${activity.id}:`, error.message);
          const latestActivity = readAgentMediaActivities().find(item => item.id === activity.id) || activity;
          writeAgentMediaActivity({
            ...latestActivity,
            status: 'failed',
            retryError: error.message,
            updatedAt: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      console.error('[Media retry] Could not process queued video retries:', error.message);
    } finally {
      processingMediaRetries = false;
    }
  }, 1000);
  mediaRetryTimer.unref?.();
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
      if (mediaRetryTimer) clearInterval(mediaRetryTimer);
      mediaRetryTimer = null;
      if (scheduledLessonTimer) clearInterval(scheduledLessonTimer);
      scheduledLessonTimer = null;
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
          ? '[Connection] Agent stopped by dashboard. The dashboard can start it again when requested.'
          : '[Connection] Session logged out. Delete "auth_info_baileys" folder and start the agent again to re-link.');
        if (agentHeartbeatTimer) clearInterval(agentHeartbeatTimer);
        agentHeartbeatTimer = null;
        process.exit(0);
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
      try {
        scheduledLessonStore.recoverInterrupted();
      } catch (error) {
        console.error('[Scheduled Lesson] Could not recover the persisted schedule queue:', error.message);
      }
      if (scheduledLessonTimer) clearInterval(scheduledLessonTimer);
      scheduledLessonTimer = setInterval(() => {
        processDueScheduledLessons(sock).catch(error =>
          console.error('[Scheduled Lesson] Queue processing failed:', error.message));
      }, 5000);
      scheduledLessonTimer.unref?.();
      processDueScheduledLessons(sock).catch(error =>
        console.error('[Scheduled Lesson] Queue processing failed:', error.message));
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

        const messageContent = normalizeMessageContent(msg.message);
        const videoCaption = messageContent?.videoMessage?.caption;
        const text = messageContent?.conversation ||
                     messageContent?.extendedTextMessage?.text ||
                     messageContent?.imageMessage?.caption ||
                     videoCaption ||
                     messageContent?.documentMessage?.caption ||
                     '';
        if (text) {
          const role = msg.key.fromMe ? 'agent' : 'client';
          const timestamp = typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp * 1000
            : Date.now();
          const contactName = msg.pushName || '';
          const savedText = role === 'agent' && videoCaption
            ? `🎬 [فيديو: ${videoCaption}]\n${videoCaption}`
            : text;
          historyManager.addMessage(jid, role, savedText, timestamp, contactName);
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

      // 2. Save messages sent by the account owner.
      if (msg.key.fromMe) {
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text && !jid.endsWith('@g.us')) {
          historyManager.addMessage(jid, 'agent', text);
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
          hadPriorConversation,
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
          let scannedPayment = null;
          if (queuedEntry.images && queuedEntry.images.length > 0) {
            try {
              console.log(`[Payment Scanner] Scanning ${queuedEntry.images.length} incoming image(s) from ${queuedEntry.pushName} (${queuedSenderNumber})...`);
              const scanResult = await scanPaymentReceipt(queuedEntry.images, aggregatedText);
              if (scanResult?.isPayment) {
                scannedPayment = scanResult;
                console.log(`[Payment Scanner] ✅ Verified payment receipt from ${queuedEntry.pushName} (${queuedSenderNumber}):`, scanResult.details || scanResult.reason);
                contactPaymentLabels.recordScannedPayment(queuedSenderNumber, jid, scanResult);
              } else {
                console.log(`[Payment Scanner] Image from ${queuedEntry.pushName} is not a payment receipt (${scanResult?.reason || 'unrecognized'}).`);
              }
            } catch (scanError) {
              console.error(`[Payment Scanner] Could not scan image from ${queuedEntry.pushName}:`, scanError.message);
            }
          }

          let paidLabel = null;
          try {
            if (paidClaim && !scannedPayment) {
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
          if ((paidClaim || scannedPayment || paidLabel) && !paidLabel?.whatsappAppliedAt) {
            try {
              await applyWhatsAppPaidLabel(sock, jid);
              if (paidLabel) contactPaymentLabels.markWhatsAppApplied(queuedSenderNumber);
              console.log(`[Contact Labels] Applied the paid label to ${queuedEntry.pushName}.`);
            } catch (error) {
              console.error(`[Contact Labels] Could not apply WhatsApp paid label to ${queuedEntry.pushName}:`, error.message);
            }
          }

          try {
            const hasScheduledLessonConversation = Boolean(scheduledLessonStore.getPending(jid)) ||
              isLessonScheduleRequest(aggregatedText);

            const replyForSchedule = async text => {
              await sendHumanizedMessage(sock, jid, text, config.typingWordsPerMinute);
              historyManager.addMessage(jid, 'agent', text);
            };
            let pendingSchedule = scheduledLessonStore.getPending(jid);
            const schedulingRequest = isLessonScheduleRequest(aggregatedText);
            const isScheduleResponse = isScheduleConfirmation(aggregatedText) ||
              isScheduleRejection(aggregatedText);
            if (pendingSchedule && !schedulingRequest && !isScheduleResponse &&
                !looksLikeScheduleDateTime(aggregatedText) &&
                !(pendingSchedule.step === 'awaiting_grade' && lessonManager.detectGrade(aggregatedText))) {
              scheduledLessonStore.clearPending(jid);
              pendingSchedule = null;
            }
            if (!pendingSchedule && schedulingRequest &&
                isRecurringLessonScheduleRequest(aggregatedText)) {
              await replyForSchedule(hasArabicText(aggregatedText)
                ? 'حالياً بقدر أجدول إرسال حصة واحدة لمرة واحدة. أرسل لي اليوم والساعة لو داير موعد واحد.'
                : 'I can schedule a lesson one time at the moment. Tell me the date and time if you want a one-time delivery.');
              return;
            }
            if (pendingSchedule || schedulingRequest) {
              const arabic = hasArabicText(aggregatedText);
              if (pendingSchedule) pendingSchedule.arabic = arabic;
              if (!pendingSchedule) {
                pendingSchedule = {
                  jid,
                  phoneJid,
                  studentName: queuedEntry.pushName,
                  arabic,
                  requestText: aggregatedText,
                  createdAt: new Date().toISOString()
                };
              }

              if (pendingSchedule.step === 'confirm' && isScheduleConfirmation(aggregatedText)) {
                let saved;
                try {
                  saved = scheduledLessonStore.create(pendingSchedule);
                } catch (error) {
                  console.error('[Scheduled Lesson] Could not save the confirmed delivery:', error.message);
                  await replyForSchedule(arabic
                    ? 'ما قدرت أحفظ الموعد. جرّب تطلب الجدولة مرة تانية بعد شوية.'
                    : 'I could not save that delivery. Please try scheduling it again in a little while.');
                  return;
                }
                const when = formatScheduledDateTime(saved.scheduledAt, arabic ? 'ar-SD' : 'en-GB');
                const response = arabic
                  ? `تمام، حأرسل ليك "${saved.lessonTitle}" يوم ${when} بتوقيت السودان.`
                  : `Done. I’ll send "${saved.lessonTitle}" on ${when} Sudan time.`;
                await replyForSchedule(response);
                console.log(`[Scheduled Lesson] Confirmed ${saved.lessonTitle} for ${saved.studentName} at ${saved.scheduledAt}.`);
                return;
              }
              if (pendingSchedule.step === 'confirm' && isScheduleRejection(aggregatedText)) {
                scheduledLessonStore.clearPending(jid);
                await replyForSchedule(arabic
                  ? 'تمام، ما حأجدول الحصة.'
                  : 'Okay, I will not schedule the lesson.');
                return;
              }
              if (pendingSchedule.step === 'confirm') {
                await replyForSchedule(arabic
                  ? 'رد بنعم لتأكيد الموعد أو لا لإلغائه. لو داير وقت مختلف، ألغِ الموعد واطلبه من جديد.'
                  : 'Reply yes to confirm or no to cancel. To choose a different time, cancel and request it again.');
                return;
              }

              const knownStudent = lessonManager.getStudent(jid, phoneJid);
              const requestedGrade = lessonManager.detectGrade(aggregatedText) ||
                pendingSchedule.gradeKey ||
                knownStudent?.grade;
              if (!requestedGrade) {
                pendingSchedule.step = 'awaiting_grade';
                if (pendingSchedule.requestText !== aggregatedText) {
                  pendingSchedule.requestText = `${pendingSchedule.requestText}\n${aggregatedText}`;
                }
                scheduledLessonStore.setPending(jid, pendingSchedule);
                await replyForSchedule(arabic
                  ? 'أكيد. إنت في أي صف ومرحلة؟'
                  : 'Sure. Which grade and school stage are you in?');
                return;
              }

              const lessonStudent = knownStudent?.grade === requestedGrade ? knownStudent : null;
              const selectedLesson = getSchedulableLesson(lessonStudent, requestedGrade, jid, phoneJid);
              if (!selectedLesson) {
                scheduledLessonStore.clearPending(jid);
                await replyForSchedule(arabic
                  ? 'ما لقيت حصة جاهزة بتمارينها للصف دا عشان أجدولها حالياً.'
                  : 'I could not find a configured lesson with its exercise to schedule for that grade yet.');
                return;
              }

              const combinedRequest = pendingSchedule.requestText === aggregatedText
                ? aggregatedText
                : `${pendingSchedule.requestText}\n${aggregatedText}`;
              const parsed = parseScheduledDateTime(combinedRequest);
              pendingSchedule = {
                ...pendingSchedule,
                step: parsed.status === 'valid' ? 'confirm' : 'awaiting_time',
                gradeKey: requestedGrade,
                lessonIndex: selectedLesson.lessonIndex,
                lessonId: selectedLesson.lesson.id,
                lessonTitle: selectedLesson.lesson.title || selectedLesson.lesson.id,
                requestText: combinedRequest,
                ...(parsed.status === 'valid' ? { scheduledAt: parsed.scheduledAt } : {})
              };
              scheduledLessonStore.setPending(jid, pendingSchedule);
              if (parsed.status !== 'valid') {
                await replyForSchedule(scheduleClarification(parsed, arabic));
                return;
              }

              const when = formatScheduledDateTime(parsed.scheduledAt, arabic ? 'ar-SD' : 'en-GB');
              const confirmation = arabic
                ? `أجدول ليك "${pendingSchedule.lessonTitle}" يوم ${when} بتوقيت السودان؟ رد بنعم أو لا.`
                : `Should I schedule "${pendingSchedule.lessonTitle}" for ${when} Sudan time? Reply yes or no.`;
              await replyForSchedule(confirmation);
              return;
            }

            const resendVideo = queuedEntry.images.length === 0 &&
              lessonManager.isLessonVideoRequest(aggregatedText);
            const resendTask = queuedEntry.images.length === 0 &&
              lessonManager.isLessonTaskRequest(aggregatedText);
            if (resendVideo || resendTask) {
              await sock.sendPresenceUpdate('composing', jid);
              try {
                let handled = false;
                if (resendVideo) {
                  handled = await lessonManager.resendCurrentLessonVideo(sock, jid, phoneJid) || handled;
                }
                if (resendTask) {
                  handled = await lessonManager.resendCurrentLessonTask(sock, jid, phoneJid) || handled;
                }
                if (handled) return;
              } finally {
                await sock.sendPresenceUpdate('paused', jid);
              }
            }

            if (queuedEntry.images.length === 0 &&
                await lessonManager.handleTreasureIslandMessage(
                  sock, jid, aggregatedText, queuedEntry.pushName, phoneJid
                )) {
              return;
            }

            if (lessonManager.hasActiveLesson(jid, phoneJid) &&
                !lessonManager.hasActiveTreasureIslandLesson(jid, phoneJid) &&
                queuedEntry.images.length === 0) {
              await sock.sendPresenceUpdate('composing', jid);
              const isHandled = await lessonManager.handleTaskSubmission(
                sock,
                jid,
                aggregatedText,
                queuedEntry.pushName,
                phoneJid,
                async ({ gradeKey, lessonIndex, lesson, studentName }) => {
                  const pending = scheduledLessonStore.list().find(schedule =>
                    schedule.jid === jid &&
                    schedule.lessonId === lesson.id &&
                    ['scheduled', 'sending'].includes(schedule.status));
                  if (pending) return pending;
                  return scheduledLessonStore.create({
                    jid,
                    phoneJid,
                    studentName,
                    gradeKey,
                    lessonIndex,
                    lessonId: lesson.id,
                    lessonTitle: lesson.title,
                    scheduledAt: getNextDailyLessonTime()
                  });
                }
              );
              await sock.sendPresenceUpdate('paused', jid);
              if (isHandled) return;
            }

            const detectedGrade = lessonManager.detectGrade(aggregatedText);
            let student = lessonManager.getStudent(jid, phoneJid);

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
            if (requestedGrade && (!student || student.status === 'consulting')) {
              student = lessonManager.reconcileProgressFromHistory(jid, phoneJid, requestedGrade);
            }
            const gradeLessons = requestedGrade ? lessonManager.lessonsConfig[requestedGrade]?.lessons : null;
            const firstConfiguredLesson = requestedGrade
              ? lessonManager.getWelcomeSampleLesson(requestedGrade)
              : null;
            const nextConfiguredLesson = ['awaiting_content', 'completed'].includes(student?.status) &&
              student.grade === requestedGrade && requestedGrade
              ? lessonManager.getNextSequentialLesson(
                requestedGrade,
                student.currentLessonId || gradeLessons?.[student.currentLessonIndex]?.id
              )
              : null;
            const welcomeState = historyManager.getWelcomeSampleState(jid, alternateJid, phoneJid);
            let shouldSendWelcomeSample = false;
            if (welcomeState === 'pending_grade') {
              if (requestedGrade) {
                const canStartFreshSequence = ((!student || student.status === 'consulting') &&
                  !queuedEntry.hadPriorConversation) ||
                  (detectedGrade && student && student.grade !== detectedGrade);
                if (firstConfiguredLesson) {
                  if (canStartFreshSequence && !lessonManager.hasActiveLesson(jid, phoneJid) &&
                      (queuedEntry.images.length === 0 || scannedPayment)) {
                    shouldSendWelcomeSample = true;
                  } else {
                    historyManager.setWelcomeSampleState('deferred', jid, alternateJid, phoneJid);
                  }
                } else {
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
              (queuedEntry.images.length === 0 || scannedPayment) &&
              !lessonManager.hasActiveLesson(jid, phoneJid) &&
              !lessonManager.hasActiveTreasureIslandLesson(jid, phoneJid) &&
              ((firstConfiguredLesson && ((!student || student.status === 'consulting') &&
                !queuedEntry.hadPriorConversation ||
                (detectedGrade && student && student.grade !== detectedGrade))) ||
                (nextConfiguredLesson?.status === 'ready' &&
                  (student.status !== 'completed' || wantsLessonNow)));
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

            if (student?.historyReconciled &&
                ['awaiting_content', 'completed'].includes(student.status) &&
                wantsLessonNow && nextConfiguredLesson?.status !== 'ready') {
              const response = hasArabicText(aggregatedText)
                ? 'إنت أرسلت ليك كل الحصص المتوفرة حالياً. أول ما أجهز الحصة الجديدة وتمارينها حأرسلها ليك.'
                : 'You have already received all configured lessons for your grade. I’ll send the next lesson once its video and exercise are ready.';
              await sendHumanizedMessage(sock, jid, response, config.typingWordsPerMinute);
              historyManager.addMessage(jid, 'agent', response);
              return;
            }

            if (!agentRespondingEnabled) {
              console.log(`[Agent Control] Skipped lesson reply to ${queuedEntry.pushName}; automatic replies were paused.`);
              return;
            }
            const arabic = hasArabicText(aggregatedText);
            let reply;
            if (scannedPayment) {
              if (shouldSendWelcomeSample || shouldStartAfterReply) {
                reply = arabic
                  ? 'وصل إيصال التحويل، تسلم يا رب وبارك الله فيك. حأرسل ليك فيديو الحصة والتمرين هسي.'
                  : 'Payment receipt received, thank you! I’ll send your lesson video and exercise now.';
              } else if (!requestedGrade) {
                reply = arabic
                  ? 'وصل إيصال التحويل، تسلم يا رب وبارك الله فيك. أرسل لي صفك ومرحلتك الدراسية عشان أختار ليك الدرس المناسب.'
                  : 'Payment receipt received, thank you! Tell me your grade and school stage so I can choose the right lesson.';
              } else if (lessonManager.hasActiveLesson(jid, phoneJid) ||
                  lessonManager.hasActiveTreasureIslandLesson(jid, phoneJid)) {
                reply = arabic
                  ? 'وصل إيصال التحويل، تسلم يا رب وبارك الله فيك. أرسل إجابات التمرين الحالي عشان أصححها ليك.'
                  : 'Payment receipt received, thank you! Let’s focus on your current lesson. Send your exercise answers and I’ll mark them.';
              } else {
                reply = arabic
                  ? 'وصل إيصال التحويل، تسلم يا رب وبارك الله فيك. حنواصل في حصصنا وتماريننا طوالي.'
                  : 'Payment receipt received, thank you! Let’s continue with our lessons.';
              }
            } else if (shouldSendWelcomeSample || shouldStartAfterReply) {
              reply = arabic
                ? 'أهلاً بيك، حأرسل ليك فيديو الحصة والتمرين هسي.'
                : 'Welcome! I’ll send your lesson video and exercise now.';
            } else {
              if (config.geminiApiKeys.length > 0) {
                try {
                  console.log(`[Agent] Generating response as Mr. Mazen for ${queuedEntry.pushName}...`);
                  reply = await generateClientResponse(
                    jid,
                    queuedEntry.pushName,
                    aggregatedText,
                    queuedEntry.images,
                    requestedGrade || student?.grade || null,
                    Boolean(shouldStartAfterReply || shouldSendWelcomeSample),
                    Boolean(hasLessonConsent),
                    phoneJid
                  );
                } catch (aiErr) {
                  console.warn(`[Agent Warning] AI response generation failed (${aiErr.message}). Using warm teacher fallback.`);
                }
              }

              if (!reply) {
                if (!requestedGrade) {
                  reply = arabic
                    ? 'و عليكم السلام ورحمة الله وبركاته، أهلين بيك يا رب! مستر مازن معاك. إنت في أي صف ومرحلة دراسية عشان أظبط ليك الدروس المناسبة إن شاء الله؟'
                    : 'Welcome! Mr. Mazen here. Which grade and school stage are you in so I can prepare the right lessons for you?';
                } else if (lessonManager.hasActiveLesson(jid, phoneJid) ||
                    lessonManager.hasActiveTreasureIslandLesson(jid, phoneJid)) {
                  reply = arabic
                    ? 'أهلاً بيك، مستر مازن معاك. مركز معاك في درسنا الشغالين فيه هسي؛ رسل لي إجاباتك عشان نراجعها سوا.'
                    : 'Mr. Mazen here! Let’s keep going with our current lesson. Send over your exercise answers so we can review them.';
                } else if (!gradeLessons?.length) {
                  reply = arabic
                    ? 'أهلاً بيك يا غالي، المنهج الخاص بالصف دا جاري تجهيزه حالياً وحنزله ليكم أول بأول إن شاء الله.'
                    : 'Welcome! The curriculum for this grade is currently being prepared and will be available soon.';
                } else {
                  reply = arabic
                    ? 'أهلاً بيك، مستر مازن معاك. معاك ومتابع معاك خطوة بخطوة إن شاء الله؛ لو جاهز للدرس أو عندك أي تمرين، رسل لي طوالي.'
                    : 'Hello! Mr. Mazen here. I’m with you step by step; whenever you’re ready for the lesson or have your exercise answers, send them right over.';
                }
              }
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
  if (agentHeartbeatTimer) clearInterval(agentHeartbeatTimer);
  agentHeartbeatTimer = null;
  updateAgentStatus('disconnected');
  process.exitCode = 1;
});
