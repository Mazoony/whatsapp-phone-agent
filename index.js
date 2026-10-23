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
import { config, resolveStudentGrade } from './config.js';
import { historyManager } from './history.js';
import { sudaneseArabicLearner } from './sudanese_arabic_learning.js';
import {
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
  createStudentPaymentLedger,
  formatStudentPaymentStatus
} from './student_payment_ledger.js';
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
  getNextDailyLessonTime
} from './scheduled_lessons.js';
import {
  deliverWhatsAppLessonSkipRequest,
  LessonSkipQueue,
  WHATSAPP_LESSON_SKIP_REQUESTS_FILE
} from './lesson_skip_queue.js';
import {
  getDueLessonAnswerReminders,
  LESSON_ANSWER_REMINDER_CHECK_INTERVAL_MS,
  LESSON_ANSWER_REMINDER_MESSAGE,
  markLessonAnswerReminderSent
} from './lesson_answer_reminders.js';

// Debounce queue for client messages: Map<jid, { timer: NodeJS.Timeout, texts: string[], images: Array<{ data: Buffer, mimeType: string }>, pushName: string }>
installAgentLogCapture();
const debounceMap = new Map();
const isDuplicateIncomingMessage = createIncomingMessageDeduplicator();
const scheduledLessonStore = createScheduledLessonStore();
const whatsappLessonSkipQueue = new LessonSkipQueue(WHATSAPP_LESSON_SKIP_REQUESTS_FILE);
let scheduledLessonTimer = null;
let processingScheduledLessons = false;
let lessonSkipTimer = null;
let processingLessonSkips = false;
let lessonAnswerReminderTimer = null;
let processingLessonAnswerReminders = false;

function getWhatsAppMessageText(messageContent) {
  const text = messageContent?.conversation ||
    messageContent?.extendedTextMessage?.text ||
    messageContent?.imageMessage?.caption ||
    messageContent?.videoMessage?.caption ||
    messageContent?.documentMessage?.caption ||
    messageContent?.documentWithCaptionMessage?.message?.documentMessage?.caption;
  if (text) return text;
  if (messageContent?.imageMessage) return 'أرسل صورة';
  if (messageContent?.videoMessage) return '[Video]';
  if (messageContent?.audioMessage) return '[Voice message]';
  if (messageContent?.documentMessage) {
    return `[File: ${messageContent.documentMessage.fileName || 'document'}]`;
  }
  if (messageContent?.stickerMessage) return '[Sticker]';
  if (messageContent?.locationMessage || messageContent?.liveLocationMessage) return '[Shared location]';
  if (messageContent?.contactMessage || messageContent?.contactsArrayMessage) return '[Shared contact]';
  return '';
}

function normalizeWhatsAppTimestamp(value) {
  const timestamp = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now();
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
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
          schedule.phoneJid,
          { includeIntro: false }
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

async function processPendingLessonSkips(sock, canProcessRequest = () => true) {
  if (processingLessonSkips) return;
  processingLessonSkips = true;
  try {
    let request;
    while ((request = whatsappLessonSkipQueue.claimNext(canProcessRequest))) {
      await deliverWhatsAppLessonSkipRequest({
        request,
        sock,
        lessonManager,
        queue: whatsappLessonSkipQueue
      });
    }
  } finally {
    processingLessonSkips = false;
  }
}

async function processPendingLessonAnswerReminders(sock, incomingChatQueue) {
  if (processingLessonAnswerReminders) return;
  processingLessonAnswerReminders = true;
  try {
    const getPhoneIdentity = jid => getPhoneJid(
      jid,
      historyManager.contacts[jid]?.phoneJid,
      historyManager.contacts[jid]?.jid
    ) || jid;
    const reminders = getDueLessonAnswerReminders(
      lessonManager.progress,
      Date.now(),
      { getIdentity: getPhoneIdentity }
    );

    for (const reminder of reminders) {
      const entries = [...reminder.entries].sort((left, right) =>
        Number(right.studentKey.endsWith('@s.whatsapp.net')) -
        Number(left.studentKey.endsWith('@s.whatsapp.net')));
      const target = entries[0];
      const phoneJid = getPhoneJid(
        target.studentKey,
        target.student.phoneJid,
        historyManager.contacts[target.studentKey]?.phoneJid,
        historyManager.contacts[target.studentKey]?.jid
      );
      const phoneNumber = phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0] || '';
      const ownerBlocked = entries.some(({ studentKey }) =>
        historyManager.contacts[studentKey]?.ownerBlocked);
      const optedOut = (followUpManager.state.optedOutJids || []).some(jid =>
        jid === target.studentKey || getPhoneIdentity(jid) === reminder.identity);
      const isBusy = entry => entry.jid === target.studentKey ||
        getPhoneIdentity(entry.jid) === reminder.identity;
      if (!phoneNumber || !config.shouldReplyTo(phoneNumber) ||
          ownerBlocked || optedOut ||
          (incomingChatQueue.active && isBusy(incomingChatQueue.active)) ||
          incomingChatQueue.waiting.some(isBusy)) {
        continue;
      }

      try {
        const currentReminder = getDueLessonAnswerReminders(
          lessonManager.progress,
          Date.now(),
          { getIdentity: getPhoneIdentity }
        ).find(candidate => candidate.identity === reminder.identity);
        if (!currentReminder) continue;

        await sock.sendMessage(target.studentKey, { text: LESSON_ANSWER_REMINDER_MESSAGE });
        markLessonAnswerReminderSent(currentReminder);
        lessonManager.saveProgress();
        console.log(`[Lesson Reminder] Sent an eight-hour unanswered lesson reminder to ${phoneNumber.slice(-4)}.`);
      } catch (error) {
        console.error(`[Lesson Reminder] Could not remind ${phoneNumber.slice(-4)} about the pending lesson:`, error.message);
      }
    }
  } finally {
    processingLessonAnswerReminders = false;
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
const studentPaymentLedger = createStudentPaymentLedger();
const whatsappPresenceManager = new WhatsAppPresenceManager();

function isPaymentClaimCommand(text) {
  return /^\/paid(?:\s|$)/i.test(String(text || '').trim());
}

function isPaymentStatusRequest(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return /^\/(?:payment|paystatus)(?:\s|$)/i.test(normalized) ||
    /\b(?:payment status|am i paid|have you received my payment|did you receive my payment)\b/.test(normalized) ||
    /(?:حالة الدفع|هل وصل التحويل|هل استلمت.*(?:الدفع|التحويل))/.test(normalized);
}

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
  const requestedHistoryCursors = new Set();
  const disconnectRequestTimer = setInterval(() => {
    try {
      const action = consumeAgentControlRequest();
      if (!action) return;
      if (typeof action === 'object' && action.action === 'fetch_message_history') {
        const cursor = `${action.messageKey.remoteJid}:${action.messageKey.id}`;
        if (requestedHistoryCursors.has(cursor)) {
          console.log(`[History] An older-history request is already in progress for ${action.jid}.`);
          return;
        }
        requestedHistoryCursors.add(cursor);
        sock.fetchMessageHistory(
          100,
          action.messageKey,
          action.timestamp
        ).then(() => {
          console.log(`[History] Requested up to 100 older WhatsApp messages for ${action.jid}.`);
        }).catch(error => {
          requestedHistoryCursors.delete(cursor);
          console.error(`[History] Could not request older WhatsApp messages for ${action.jid}:`, error.message);
        });
        return;
      }
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
  const isLessonSkipTargetBusy = request => {
    const matchesStudent = entry => entry.jid === request.jid ||
      (request.phoneJid && getPhoneJid(
        entry.jid,
        historyManager.contacts[entry.jid]?.phoneJid,
        historyManager.contacts[entry.jid]?.jid
      ) === request.phoneJid);
    return Boolean(
      (incomingChatQueue.active && matchesStudent(incomingChatQueue.active)) ||
      incomingChatQueue.waiting.some(matchesStudent)
    );
  };
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
      if (lessonSkipTimer) clearInterval(lessonSkipTimer);
      lessonSkipTimer = null;
      if (lessonAnswerReminderTimer) clearInterval(lessonAnswerReminderTimer);
      lessonAnswerReminderTimer = null;
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
      try {
        const recovered = whatsappLessonSkipQueue.recoverProcessing();
        if (recovered) console.log(`[Lesson Skip] Recovered ${recovered} interrupted WhatsApp request(s).`);
      } catch (error) {
        console.error('[Lesson Skip] Could not recover queued WhatsApp requests:', error.message);
      }
      if (lessonSkipTimer) clearInterval(lessonSkipTimer);
      lessonSkipTimer = setInterval(() => {
        processPendingLessonSkips(sock, request => !isLessonSkipTargetBusy(request)).catch(error =>
          console.error('[Lesson Skip] WhatsApp queue processing failed:', error.message));
      }, 1000);
      lessonSkipTimer.unref?.();
      processPendingLessonSkips(sock, request => !isLessonSkipTargetBusy(request)).catch(error =>
        console.error('[Lesson Skip] WhatsApp queue processing failed:', error.message));
      if (lessonAnswerReminderTimer) clearInterval(lessonAnswerReminderTimer);
      lessonAnswerReminderTimer = setInterval(() => {
        processPendingLessonAnswerReminders(sock, incomingChatQueue).catch(error =>
          console.error('[Lesson Reminder] Reminder queue processing failed:', error.message));
      }, LESSON_ANSWER_REMINDER_CHECK_INTERVAL_MS);
      lessonAnswerReminderTimer.unref?.();
      processPendingLessonAnswerReminders(sock, incomingChatQueue).catch(error =>
        console.error('[Lesson Reminder] Reminder queue processing failed:', error.message));
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

    let restoredMessages = 0;
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        const messageContent = normalizeMessageContent(msg.message);
        const text = getWhatsAppMessageText(messageContent);
        if (text) {
          const role = msg.key.fromMe ? 'agent' : 'client';
          const timestamp = normalizeWhatsAppTimestamp(msg.messageTimestamp);
          const contactName = msg.pushName || historyManager.contacts[jid]?.name || '';
          const phoneJid = getPhoneJid(
            jid,
            msg.key.remoteJidAlt,
            historyManager.contacts[jid]?.phoneJid
          );
          const beforeCount = historyManager.history[jid]?.length || 0;
          historyManager.addMessage(
            jid,
            role,
            text,
            timestamp,
            contactName,
            msg.key.id,
            phoneJid
          );
          if ((historyManager.history[jid]?.length || 0) > beforeCount) restoredMessages += 1;
        }
      }
    }
    if (restoredMessages > 0) {
      console.log(`[History] Restored ${restoredMessages} WhatsApp message(s) across ${chats?.length || 0} synced chat(s).`);
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
        const text = getWhatsAppMessageText(normalizeMessageContent(msg.message));
        if (text && !jid.endsWith('@g.us')) {
          historyManager.addMessage(
            jid,
            'agent',
            text,
            normalizeWhatsAppTimestamp(msg.messageTimestamp),
            msg.pushName || '',
            msg.key.id,
            phoneJid
          );
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
      const text = getWhatsAppMessageText(messageContent);

      if (!text.trim()) continue;

      const pushName = msg.pushName || phoneJid?.split('@')[0] || senderNumber;
      const hadPriorConversation = historyManager.hasConversation(jid, alternateJid, phoneJid);
      const existingWelcomeState = historyManager.getWelcomeSampleState(jid, alternateJid, phoneJid);
      const isFirstWelcomeMessage = !hadPriorConversation && !existingWelcomeState;
      historyManager.saveContact(jid, pushName);
      historyManager.addMessage(
        jid,
        'client',
        text.trim(),
        normalizeWhatsAppTimestamp(msg.messageTimestamp),
        pushName,
        msg.key.id,
        phoneJid
      );

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

          if (isPaymentStatusRequest(aggregatedText)) {
            const student = lessonManager.getStudent(jid, phoneJid);
            const payment = studentPaymentLedger.getCurrent(
              phoneJid || jid,
              student?.enrolledAt || student?.deliveredAt || new Date().toISOString()
            );
            await sock.sendMessage(jid, {
              text: formatStudentPaymentStatus(payment)
            });
            return;
          }

          const paidClaim = isPaymentClaimCommand(aggregatedText) ||
            isExplicitPaidClaim(aggregatedText);
          let scannedPayment = null;
          if (queuedEntry.images && queuedEntry.images.length > 0) {
            try {
              console.log(`[Payment Scanner] Scanning ${queuedEntry.images.length} incoming image(s) from ${queuedEntry.pushName} (${queuedSenderNumber})...`);
              const scanResult = await scanPaymentReceipt(queuedEntry.images, aggregatedText);
              if (scanResult?.isPayment) {
                scannedPayment = scanResult;
                console.log(`[Payment Scanner] Payment receipt submitted by ${queuedEntry.pushName} (${queuedSenderNumber}) for manual review:`, scanResult.details || scanResult.reason);
              } else {
                console.log(`[Payment Scanner] Image from ${queuedEntry.pushName} is not a payment receipt (${scanResult?.reason || 'unrecognized'}).`);
              }
            } catch (scanError) {
              console.error(`[Payment Scanner] Could not scan image from ${queuedEntry.pushName}:`, scanError.message);
            }
          }

          if (paidClaim || scannedPayment) {
            const student = lessonManager.getStudent(jid, phoneJid);
            try {
              const payment = studentPaymentLedger.recordClaim(phoneJid || jid, {
                enrolledAt: student?.enrolledAt || student?.deliveredAt || new Date().toISOString(),
                source: scannedPayment ? 'whatsapp-receipt' : 'whatsapp-claim',
                details: scannedPayment?.details || null
              });
              await sock.sendMessage(jid, {
                text: payment.status === 'paid'
                  ? 'الدفع للفترة الحالية مؤكد بالفعل. سجلت البلاغ الجديد للرجوع ليه.'
                  : 'وصل بلاغ الدفع للمراجعة، وما حيتسجل كمدفوع إلا بعد ما نتأكد منه.'
              });
              console.log(`[Payment Ledger] Recorded WhatsApp report from ${queuedEntry.pushName} as ${payment.status}.`);
            } catch (error) {
              console.error('[Payment Ledger] Could not save a WhatsApp payment report:', error.message);
            }
          }

          let paidLabel = null;
          try {
            const label = contactPaymentLabels.get(queuedSenderNumber);
            paidLabel = label?.source === 'manual' ? label : null;
          } catch (error) {
            console.error('[Contact Labels] Could not read payment label status:', error.message);
          }
          if (paidLabel?.label === 'paid' && !paidLabel.whatsappAppliedAt) {
            try {
              await applyWhatsAppPaidLabel(sock, jid);
              if (paidLabel) contactPaymentLabels.markWhatsAppApplied(queuedSenderNumber);
              console.log(`[Contact Labels] Applied the paid label to ${queuedEntry.pushName}.`);
            } catch (error) {
              console.error(`[Contact Labels] Could not apply WhatsApp paid label to ${queuedEntry.pushName}:`, error.message);
            }
          }

          try {
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
                phoneJid
              );
              await sock.sendPresenceUpdate('paused', jid);
              if (isHandled) return;
            }
            if (lessonManager.hasActiveLesson(jid, phoneJid) ||
                lessonManager.hasActiveTreasureIslandLesson(jid, phoneJid)) {
              return;
            }

            if (!agentRespondingEnabled) {
              console.log(`[Agent Control] Skipped lesson delivery to ${queuedEntry.pushName}; automatic replies were paused.`);
              return;
            }

            const detectedGrade = lessonManager.detectGrade(aggregatedText);
            let student = lessonManager.getStudent(jid, phoneJid);
            const chatHistory = historyManager.history[jid] || [];
            let gradeFromHistory = [...chatHistory]
              .reverse()
              .map(message => lessonManager.detectGrade(message.text))
              .find(Boolean);

            if (!gradeFromHistory) {
              for (const [gradeKey, data] of Object.entries(lessonManager.lessonsConfig)) {
                const found = data?.lessons?.some(lesson =>
                  chatHistory.some(message =>
                    message.text?.includes(lesson.title) ||
                    (lesson.id && message.text?.includes(lesson.id))
                  )
                );
                if (found) {
                  gradeFromHistory = gradeKey;
                  break;
                }
              }
            }

            const requestedGrade = resolveStudentGrade(
              detectedGrade,
              gradeFromHistory,
              student?.grade
            );
            if (!student || student.status === 'consulting') {
              student = lessonManager.reconcileProgressFromHistory(jid, phoneJid, requestedGrade);
            }
            if ((!student || student.grade !== requestedGrade) &&
                !lessonManager.hasActiveLesson(jid, phoneJid)) {
              lessonManager.setStudentGrade(jid, requestedGrade, phoneJid);
              student = lessonManager.getStudent(jid, phoneJid);
            }

            const nextLesson = lessonManager.getNextLessonToDeliver(
              jid,
              requestedGrade,
              phoneJid
            );
            if (nextLesson.status !== 'ready') return;
            const lessonIndex = nextLesson.lessonIndex;
            const lessonToSend = lessonManager.lessonsConfig[requestedGrade]?.lessons?.[lessonIndex];
            if (!lessonToSend) {
              throw new Error(`Configured lesson ${lessonIndex + 1} is missing for ${requestedGrade}.`);
            }

            for (const scheduled of scheduledLessonStore.list()) {
              if ((scheduled.jid === jid || (phoneJid && scheduled.phoneJid === phoneJid)) &&
                  scheduled.lessonId === lessonToSend.id &&
                  scheduled.status === 'scheduled') {
                scheduledLessonStore.cancel(scheduled.id);
                console.log(`[Scheduled Lesson] Cancelled duplicate queued delivery for ${scheduled.lessonId}; sending it now.`);
              }
            }
            console.log(`[Lesson Auto-Start] Delivering lesson ${lessonIndex + 1} to ${queuedEntry.pushName}.`);
            await sock.sendPresenceUpdate('composing', jid);
            try {
              const delivered = await lessonManager.deliverLesson(
                sock,
                jid,
                requestedGrade,
                lessonIndex,
                phoneJid,
                { includeIntro: false }
              );
              if (delivered) {
                historyManager.setWelcomeSampleState('sent', jid, alternateJid, phoneJid);
              }
            } finally {
              await sock.sendPresenceUpdate('paused', jid);
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
