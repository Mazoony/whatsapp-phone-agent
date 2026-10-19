import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardAuth } from './dashboard_auth.js';
import { getPhoneJid } from './phonebook.js';
import {
  BROADCAST_MEDIA_DIRECTORY,
  MAX_BROADCAST_ATTACHMENTS,
  MAX_BROADCAST_MEDIA_BYTES,
  getBroadcastMediaMetadata,
  saveBroadcastMedia
} from './broadcast_media.js';
import {
  CONTACT_SYNC_REQUESTS_FILE,
  CONTACT_SYNC_STATUS_FILE,
  ContactSyncManager
} from './contact_sync.js';
import { inferContactGender } from './contact_gender.js';
import { CONTACT_GENDER_FILE, createContactGenderStore } from './contact_gender_store.js';
import {
  CONTACT_PAYMENT_LABELS_FILE,
  createContactPaymentLabelsStore
} from './contact_payment_labels.js';
import { config } from './config.js';
import {
  BLOCKED_CONTACTS_FILE,
  createBlockedContactsStore,
  normalizePhoneNumber
} from './blocked_contacts.js';
import {
  AGENT_MEDIA_ACTIVITY_FILE,
  readAgentMediaActivities,
  writeAgentMediaActivity
} from './agent_media_activity.js';
import {
  AGENT_MEDIA_RETRY_REQUESTS_FILE,
  enqueueAgentMediaRetry
} from './agent_media_retry.js';
import { findLessonForMediaActivity } from './lesson_media_retry.js';
import { getInactiveEligibleEsContacts } from './broadcast_utils.js';
import {
  CHAT_READ_STATE_FILE,
  ChatReadStateStore,
  getChatReadStatus
} from './chat_read_state.js';
import {
  INCOMING_CHAT_QUEUE_FILE,
  readIncomingChatQueue
} from './incoming_chat_queue.js';
import {
  WHATSAPP_CHAT_ACTIVITY_FILE
} from './whatsapp_chat_activity.js';
import {
  WHATSAPP_PRESENCE_FILE,
  WHATSAPP_PRESENCE_REQUESTS_FILE,
  WhatsAppPresenceManager
} from './whatsapp_presence.js';
import {
  AGENT_QR_FILE,
  AGENT_STATUS_FILE,
  readAgentQr,
  renderAgentQrSvg,
  requestAgentDisconnect,
  requestAgentQueueCancellation,
  requestAgentQueueMode,
  requestAgentResponseMode
} from './agent_status.js';
import { AGENT_LOG_FILE, readRecentAgentLogs } from './agent_runtime.js';
import {
  getEligibleBroadcastContacts,
  listEligibleBroadcastContacts,
  validateBroadcastRequest
} from './broadcast_utils.js';
import {
  createStudentWorkbookManager,
  STUDENT_WORKBOOK_FILE,
  STUDENT_WORKBOOK_SOURCE_FILES
} from './student_workbook.js';
import { createScheduledLessonStore, SCHEDULED_LESSONS_FILE } from './scheduled_lessons.js';
import {
  LESSON_MEDIA_DIR,
  MAX_LESSON_VIDEO_BYTES,
  listCurriculumOverview,
  getGradeCurriculum,
  saveLesson,
  deleteLesson,
  reorderLessons,
  saveGradeMetadata,
  saveLessonVideo
} from './curriculum_manager.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(ROOT_DIR, 'data', 'chat_history.json');
const CONTACTS_FILE = path.join(ROOT_DIR, 'data', 'contacts.json');
const BLOCKED_NUMBERS_FILE = BLOCKED_CONTACTS_FILE;
const CONTACT_GENDER_OVERRIDES_FILE = CONTACT_GENDER_FILE;
const PROGRESS_FILE = path.join(ROOT_DIR, 'data', 'student_progress.json');
const LESSONS_FILE = path.join(ROOT_DIR, 'lessons.json');
const FOLLOWUP_STATE_FILE = path.join(ROOT_DIR, 'data', 'followup_state.json');
const BROADCAST_REQUESTS_FILE = path.join(ROOT_DIR, 'data', 'broadcast_requests.json');
const BROADCAST_STATE_FILE = path.join(ROOT_DIR, 'data', 'broadcast_state.json');
const MESSAGE_REQUESTS_FILE = path.join(ROOT_DIR, 'data', 'message_requests.json');
const DASHBOARD_WATCHED_FILES = new Set([
  HISTORY_FILE,
  CONTACTS_FILE,
  PROGRESS_FILE,
  LESSONS_FILE,
  FOLLOWUP_STATE_FILE,
  BROADCAST_REQUESTS_FILE,
  BROADCAST_STATE_FILE,
  MESSAGE_REQUESTS_FILE,
  SCHEDULED_LESSONS_FILE,
  AGENT_STATUS_FILE,
  AGENT_QR_FILE,
  AGENT_MEDIA_ACTIVITY_FILE,
  WHATSAPP_PRESENCE_FILE,
  BLOCKED_NUMBERS_FILE,
  CONTACT_PAYMENT_LABELS_FILE
].map(filePath => path.resolve(filePath)));
const DASHBOARD_DATA_SOURCE_FILES = [
  HISTORY_FILE,
  CONTACTS_FILE,
  PROGRESS_FILE,
  LESSONS_FILE,
  FOLLOWUP_STATE_FILE,
  WHATSAPP_CHAT_ACTIVITY_FILE,
  BLOCKED_NUMBERS_FILE,
  CONTACT_PAYMENT_LABELS_FILE,
  CONTACT_GENDER_OVERRIDES_FILE
];
const AGENT_HEARTBEAT_MAX_AGE_MS = 30_000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 120;
const MAX_CONVERSATION_MESSAGES = 100;
const DEFAULT_CONTACT_PAGE_SIZE = 50;
const ACTIVITY_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readBinaryRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error(`Attachment exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB size limit.`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function readJsonFileOr(filePath, fallback) {
  return fs.existsSync(filePath) ? readJsonFile(filePath) : fallback;
}

function writeJsonFile(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function fileSignature(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

export function createDashboardDataCache(loader, sourceFiles) {
  let cachedSignature = null;
  let cachedData = null;
  return () => {
    const signature = sourceFiles.map(fileSignature).join('|');
    if (cachedData && signature === cachedSignature) return cachedData;

    const data = loader();
    const loadedSignature = sourceFiles.map(fileSignature).join('|');
    if (signature === loadedSignature) {
      cachedData = data;
      cachedSignature = signature;
    } else {
      cachedData = null;
      cachedSignature = null;
    }
    return data;
  };
}

function loadDashboardDataFromDisk() {
  return {
    history: readJsonFile(HISTORY_FILE),
    contacts: readJsonFile(CONTACTS_FILE),
    progress: readJsonFile(PROGRESS_FILE),
    lessons: readJsonFile(LESSONS_FILE),
    optedOutJids: readJsonFileOr(FOLLOWUP_STATE_FILE, { optedOutJids: [] }).optedOutJids || [],
    whatsappChatActivity: readJsonFileOr(WHATSAPP_CHAT_ACTIVITY_FILE, {}),
    paymentLabels: createContactPaymentLabelsStore().list(),
    blockedNumbers: createBlockedContactsStore().list(),
    genderOverrides: createContactGenderStore().list()
  };
}

export const readDashboardData = createDashboardDataCache(
  loadDashboardDataFromDisk,
  DASHBOARD_DATA_SOURCE_FILES
);

const dashboardQueryCache = new WeakMap();

function memoizeDashboardQuery(data, key, compute) {
  let queries = dashboardQueryCache.get(data);
  if (!queries) {
    queries = new Map();
    dashboardQueryCache.set(data, queries);
  }
  if (queries.has(key)) {
    const cached = queries.get(key);
    queries.delete(key);
    queries.set(key, cached);
    return cached;
  }
  const result = compute();
  queries.set(key, result);
  while (queries.size > 32) queries.delete(queries.keys().next().value);
  return result;
}

function isDirectChat(jid) {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function timestampMs(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return 0;
  const numericTimestamp = Number(timestamp);
  const value = Number.isFinite(numericTimestamp)
    ? numericTimestamp
    : Number.isFinite(Date.parse(timestamp))
      ? Date.parse(timestamp)
      : 0;
  if (!Number.isFinite(value)) return 0;
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function latestMessage(messages = []) {
  return messages.reduce((latest, message) => {
    const currentTimestamp = timestampMs(message.timestamp);
    const latestTimestamp = timestampMs(latest?.timestamp);
    return currentTimestamp > latestTimestamp ? message : latest;
  }, null);
}

function displayName(contact, jid) {
  return contact?.name || jid.split('@')[0];
}

function validateDashboardMessage(data, jid, text) {
  if (typeof jid !== 'string' || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)) {
    throw new Error('Select a valid direct chat.');
  }
  if (!Array.isArray(data.history[jid]) || data.history[jid].length === 0) {
    throw new Error('This chat is no longer available. Refresh the dashboard and select it again.');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new Error('Message must be between 1 and 4,000 characters.');
  }

  const phoneJid = getPhoneJid(jid, data.contacts[jid]?.phoneJid, data.contacts[jid]?.jid);
  if (!phoneJid) {
    throw new Error("Cannot verify this chat's phone number for messaging.");
  }
  const phoneNumber = phoneJid.slice(0, -'@s.whatsapp.net'.length).split(':')[0];
  const numberIsBlocked = (data.blockedNumbers || []).some(record =>
    (typeof record === 'string' ? record : record.number) === phoneNumber);
  if (numberIsBlocked || !config.shouldReplyTo(phoneNumber)) {
    throw new Error('This number is blocked or is not allowed by the configured number rules.');
  }

  const optedOutJids = new Set(data.optedOutJids || []);
  const aliases = Object.entries(data.contacts)
    .filter(([contactJid, contact]) =>
      contactJid === jid ||
      getPhoneJid(contactJid, contact.phoneJid, contact.jid) === phoneJid);
  if (aliases.some(([, contact]) => contact.ownerBlocked)) {
    throw new Error('This contact is blocked by the owner and cannot be messaged.');
  }
  if (optedOutJids.has(jid) || optedOutJids.has(phoneJid) ||
      aliases.some(([alias]) => optedOutJids.has(alias))) {
    throw new Error('This contact opted out and cannot be messaged.');
  }

  return { jid, text: text.trim(), phoneNumber };
}

function removeLocalContactAliases(contacts, phoneNumber) {
  let removed = 0;
  for (const [jid, contact] of Object.entries(contacts)) {
    const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
    if (phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0] === phoneNumber) {
      delete contacts[jid];
      removed += 1;
    }
  }
  return removed;
}

function contactNameForPhoneNumber(contacts, phoneNumber) {
  for (const [jid, contact] of Object.entries(contacts || {})) {
    const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
    if (phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0] !== phoneNumber) {
      continue;
    }
    const name = [contact?.name, contact?.notify, contact?.verifiedName]
      .find(value => typeof value === 'string' && value.trim());
    if (name) return name.trim().slice(0, 200);
  }
  return '';
}

function handleBlockedContactMutation(req, res, {
  blockedContacts,
  contactsFile,
  phoneNumber,
  action
}) {
  if (!isSameOriginLoopbackRequest(req)) {
    sendJson(res, 403, { error: 'Contact changes can only be made from this local dashboard.' });
    return;
  }

  const normalizedNumber = normalizePhoneNumber(phoneNumber);
  if (!/^\d{5,15}$/.test(normalizedNumber)) {
    sendJson(res, 400, { error: 'Enter a valid phone number with 5 to 15 digits.' });
    return;
  }

  try {
    let response;
    if (action === 'unblock') {
      response = { unblocked: blockedContacts.unblock(normalizedNumber) };
    } else {
      const contacts = readJsonFileOr(contactsFile, {});
      const name = contactNameForPhoneNumber(contacts, normalizedNumber);
      const reason = action === 'delete' ? 'deleted' : 'banned';
      const record = blockedContacts.block(normalizedNumber, reason, name);
      let removed = 0;
      if (action === 'delete') {
        removed = removeLocalContactAliases(contacts, normalizedNumber);
        writeJsonFile(contactsFile, contacts);
      }
      response = {
        blocked: true,
        name: record.name || normalizedNumber,
        reason,
        removedContacts: removed,
        blockedAt: record.blockedAt
      };
    }
    sendJson(res, 200, response);
  } catch (error) {
    console.error('[Admin Dashboard] Could not update blocked contacts:', error.message);
    sendJson(res, 500, { error: 'Could not update the blocked contact list.' });
  }
}

async function handleDirectMessagePost(req, res, readData, messageRequestsFile) {
  if (!isSameOriginLoopbackRequest(req)) {
    sendJson(res, 403, { error: 'Messages can only be sent from this local dashboard.' });
    return;
  }

  try {
    const body = await readRequestBody(req);
    const data = readData();
    const message = validateDashboardMessage(data, body.jid, body.text);
    const requests = readJsonFileOr(messageRequestsFile, []);
    if (!Array.isArray(requests)) throw new Error('Invalid direct message queue.');

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const request = { id, ...message, createdAt: new Date().toISOString() };
    requests.push(request);
    fs.mkdirSync(path.dirname(messageRequestsFile), { recursive: true });
    writeJsonFile(messageRequestsFile, requests);
    sendJson(res, 202, { id, status: 'queued', createdAt: request.createdAt });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function lessonForStudent(student, lessons) {
  return lessons[student.grade]?.lessons?.[student.currentLessonIndex] || null;
}

export function listDashboardStudentProgress(data, now = Date.now(), timeZone = 'UTC') {
  const activityByPhone = new Map();
  const sevenDayCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDayCutoff = now - 30 * 24 * 60 * 60 * 1000;
  for (const [historyJid, messages] of Object.entries(data.history || {})) {
    if (!isDirectChat(historyJid) || !Array.isArray(messages)) continue;
    const contact = data.contacts[historyJid];
    const phoneJid = getPhoneJid(historyJid, contact?.phoneJid, contact?.jid) || historyJid;
    let activity = activityByPhone.get(phoneJid);
    if (!activity) {
      activity = {
        totalIncomingMessages: 0,
        incomingMessagesLast7Days: 0,
        incomingMessagesLast30Days: 0,
        activeDatesLast30Days: new Set(),
        lastStudentActivityAt: null
      };
      activityByPhone.set(phoneJid, activity);
    }
    for (const message of messages) {
      if (message.role !== 'client') continue;
      const timestamp = timestampMs(message.timestamp);
      if (!timestamp) continue;
      activity.totalIncomingMessages += 1;
      if (!activity.lastStudentActivityAt || timestamp > activity.lastStudentActivityAt) {
        activity.lastStudentActivityAt = timestamp;
      }
      if (timestamp <= now && timestamp >= sevenDayCutoff) {
        activity.incomingMessagesLast7Days += 1;
      }
      if (timestamp <= now && timestamp >= thirtyDayCutoff) {
        activity.incomingMessagesLast30Days += 1;
        activity.activeDatesLast30Days.add(new Date(timestamp).toISOString().slice(0, 10));
      }
    }
  }

  const students = Object.entries(data.progress).map(([jid, student]) => {
    const contact = data.contacts[jid];
    const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid) || jid;
    const activity = activityByPhone.get(phoneJid);
    const lesson = lessonForStudent(student, data.lessons);
    return {
      jid,
      name: displayName(contact, jid),
      gradeName: data.lessons[student.grade]?.name || student.grade,
      status: student.status,
      lessonTitle: lesson?.title || student.currentLessonId || '',
      deliveredAt: student.deliveredAt || null,
      lastStudentActivityAt: activity?.lastStudentActivityAt || null,
      totalIncomingMessages: activity?.totalIncomingMessages || 0,
      incomingMessagesLast7Days: activity?.incomingMessagesLast7Days || 0,
      incomingMessagesLast30Days: activity?.incomingMessagesLast30Days || 0,
      activeDaysLast30Days: activity?.activeDatesLast30Days.size || 0
    };
  });
  const statusCounts = {
    awaiting_task: 0,
    awaiting_reattempt: 0,
    completed: 0,
    other: 0
  };
  const followUpStudents = [];
  for (const student of students) {
    const status = Object.hasOwn(statusCounts, student.status) ? student.status : 'other';
    statusCounts[status] += 1;
    if (!['awaiting_task', 'awaiting_reattempt'].includes(student.status)) continue;

    const lastProgressActivityAt = Math.max(
      student.lastStudentActivityAt || 0,
      timestampMs(student.deliveredAt)
    );
    if (!lastProgressActivityAt || now - lastProgressActivityAt < 7 * 24 * 60 * 60 * 1000) continue;
    followUpStudents.push({
      jid: student.jid,
      name: student.name,
      gradeName: student.gradeName,
      lessonTitle: student.lessonTitle,
      status: student.status,
      lastStudentActivityAt: student.lastStudentActivityAt,
      daysSinceActivity: Math.floor((now - lastProgressActivityAt) / (24 * 60 * 60 * 1000))
    });
  }
  followUpStudents.sort((left, right) =>
    Number(right.status === 'awaiting_reattempt') - Number(left.status === 'awaiting_reattempt') ||
    right.daysSinceActivity - left.daysSinceActivity);

  const engagementByDate = new Map();
  const trackedPhones = new Set(students.map(student => {
    const contact = data.contacts[student.jid];
    return getPhoneJid(student.jid, contact?.phoneJid, contact?.jid) || student.jid;
  }));
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  for (const [historyJid, messages] of Object.entries(data.history || {})) {
    if (!isDirectChat(historyJid) || !Array.isArray(messages)) continue;
    const contact = data.contacts[historyJid];
    const phoneJid = getPhoneJid(historyJid, contact?.phoneJid, contact?.jid) || historyJid;
    if (!trackedPhones.has(phoneJid)) continue;
    for (const message of messages) {
      if (message.role !== 'client') continue;
      const timestamp = timestampMs(message.timestamp);
      if (!timestamp || timestamp > now || timestamp < now - 30 * 24 * 60 * 60 * 1000) continue;
      const parts = Object.fromEntries(
        dateFormatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
      );
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      let record = engagementByDate.get(date);
      if (!record) {
        record = { date, activePhones: new Set(), incomingMessages: 0 };
        engagementByDate.set(date, record);
      }
      record.activePhones.add(phoneJid);
      record.incomingMessages += 1;
    }
  }
  const todayParts = Object.fromEntries(
    dateFormatter.formatToParts(new Date(now)).map(part => [part.type, part.value])
  );
  const todayUtc = Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, Number(todayParts.day));
  const engagementTrend = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(todayUtc - (29 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const record = engagementByDate.get(date);
    return {
      date,
      activeStudents: record?.activePhones.size || 0,
      incomingMessages: record?.incomingMessages || 0
    };
  });
  students.sort((left, right) =>
    (right.lastStudentActivityAt || timestampMs(right.deliveredAt)) -
    (left.lastStudentActivityAt || timestampMs(left.deliveredAt)));
  return {
    total: students.length,
    students,
    insights: {
      statusCounts,
      followUpStudents,
      activeStudentsLast7Days: new Set(engagementTrend.slice(-7)
        .flatMap(day => [...(engagementByDate.get(day.date)?.activePhones || [])])).size,
      engagementTrend
    }
  };
}

function getClientMessagesByPhone(data) {
  return memoizeDashboardQuery(data, 'client-messages-by-phone', () => {
    const messagesByPhone = new Map();
    for (const [historyJid, messages] of Object.entries(data.history)) {
      const linkedPhoneJid = getPhoneJid(
        historyJid,
        data.contacts[historyJid]?.phoneJid,
        data.contacts[historyJid]?.jid
      );
      const phoneJid = linkedPhoneJid || historyJid;
      if (!messagesByPhone.has(phoneJid)) messagesByPhone.set(phoneJid, []);
      messagesByPhone.get(phoneJid).push(...messages);
    }
    return messagesByPhone;
  });
}

function contactGender(data, phoneNumber, messages) {
  const override = data.genderOverrides?.[phoneNumber];
  if (override) return { value: override, source: 'manual' };
  return { ...inferContactGender(messages), source: 'inferred' };
}

function paymentLabelForContact(data, jid) {
  const contact = data.contacts[jid];
  const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
  const phoneNumber = phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0];
  const label = phoneNumber ? data.paymentLabels?.[phoneNumber] : null;
  return label?.label === 'paid' ? label : null;
}

function presenceForChat(data, presenceManager, jid) {
  const contact = data.contacts[jid];
  const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
  return presenceManager.getPresence(phoneJid, jid) || {
    status: 'unknown',
    updatedAt: null,
    lastSeenAt: null
  };
}

function relatedPresenceJids(data, jid) {
  const phoneJid = getPhoneJid(jid, data.contacts[jid]?.phoneJid, data.contacts[jid]?.jid);
  const related = new Set([jid, phoneJid].filter(Boolean));
  for (const candidate of new Set([
    ...Object.keys(data.contacts || {}),
    ...Object.keys(data.history || {})
  ])) {
    const contact = data.contacts[candidate];
    if (candidate === jid ||
        (phoneJid && getPhoneJid(candidate, contact?.phoneJid, contact?.jid) === phoneJid)) {
      related.add(candidate);
    }
  }
  return [...related];
}

function hasKnownPresenceChat(data, jid) {
  if (data.history[jid] || data.contacts[jid]) return true;
  const phoneJid = getPhoneJid(jid, data.contacts[jid]?.phoneJid, data.contacts[jid]?.jid);
  if (!phoneJid) return false;
  return [...new Set([
    ...Object.keys(data.history || {}),
    ...Object.keys(data.contacts || {})
  ])].some(candidate =>
    getPhoneJid(
      candidate,
      data.contacts[candidate]?.phoneJid,
      data.contacts[candidate]?.jid
    ) === phoneJid
  );
}

function genderForContact(data, jid, messagesByPhone) {
  const phoneJid = getPhoneJid(
    jid,
    data.contacts[jid]?.phoneJid,
    data.contacts[jid]?.jid
  ) || jid;
  const phoneNumber = phoneJid.endsWith('@s.whatsapp.net')
    ? phoneJid.slice(0, -'@s.whatsapp.net'.length).split(':')[0]
    : '';
  if (!phoneNumber) return { value: 'unknown', confidence: 'not clearly stated', source: 'inferred' };
  return contactGender(data, phoneNumber, messagesByPhone.get(phoneJid) || []);
}

export function listDashboardEsContacts(
  data,
  search = '',
  offset = 0,
  limit = DEFAULT_CONTACT_PAGE_SIZE,
  messagesByPhone = getClientMessagesByPhone(data),
  {
    readState = {},
    sort = 'date-desc',
    readFilter = 'all'
  } = {}
) {
  if (!['date-desc', 'date-asc', 'unread-first', 'read-first'].includes(sort)) {
    throw new Error('Invalid Es contact sort option.');
  }
  if (!['all', 'read', 'unread'].includes(readFilter)) {
    throw new Error('Invalid Es contact read filter.');
  }
  const normalizedSearch = search.trim().toLocaleLowerCase().slice(0, MAX_SEARCH_LENGTH);
  const contactsByPhone = new Map();
  const activityByPhone = contactActivityByPhone(data, readState);
  const messageEligibleJids = new Set(
    getEligibleBroadcastContacts(data, data.optedOutJids || []).map(contact => contact.jid)
  );
  for (const [jid, contact] of Object.entries(data.contacts)) {
    if (!contact.isEs || contact.savedInAddressBook !== true) continue;

    const phoneJid = getPhoneJid(jid, contact.phoneJid, contact.jid);
    if (!phoneJid) continue;

    const phoneNumber = phoneJid.slice(0, -'@s.whatsapp.net'.length).split(':')[0];
    const name = displayName(contact, phoneJid);
    if (normalizedSearch &&
        !name.toLocaleLowerCase().includes(normalizedSearch) &&
        !phoneNumber.includes(normalizedSearch)) continue;

    if (!contactsByPhone.has(phoneNumber)) {
      const block = (data.blockedNumbers || []).find(record =>
        (typeof record === 'string' ? record : record.number) === phoneNumber);
      contactsByPhone.set(phoneNumber, {
        jid: `${phoneNumber}@s.whatsapp.net`,
        name,
        phoneNumber,
        gender: contactGender(data, phoneNumber, messagesByPhone.get(phoneJid) || []),
        paid: data.paymentLabels?.[phoneNumber]?.label === 'paid'
          ? data.paymentLabels[phoneNumber]
          : null,
        ...(block ? { block } : {})
      });
    }
  }

  const contacts = [...contactsByPhone.values()]
    .map(contact => ({
      ...contact,
      canMessage: !contact.block && messageEligibleJids.has(contact.jid),
      ...(activityByPhone.get(contact.jid) || {
        lastActivityAt: null,
        lastIncomingAt: null,
        unread: false
      })
    }))
    .filter(contact =>
      readFilter === 'all' ||
      (readFilter === 'unread' ? contact.unread : !contact.unread))
    .sort((left, right) => {
      if (sort === 'date-asc') {
        return (left.lastActivityAt || 0) - (right.lastActivityAt || 0) ||
          left.name.localeCompare(right.name);
      }
      if (sort === 'unread-first' || sort === 'read-first') {
        const readOrder = sort === 'unread-first'
          ? Number(right.unread) - Number(left.unread)
          : Number(left.unread) - Number(right.unread);
        if (readOrder) return readOrder;
      }
      return (right.lastActivityAt || 0) - (left.lastActivityAt || 0) ||
        left.name.localeCompare(right.name);
    });
  const genderStatistics = {
    female: 0,
    male: 0,
    unknown: 0,
    manual: 0,
    inferred: 0,
    total: contacts.length
  };
  for (const contact of contacts) {
    genderStatistics[contact.gender.value] += 1;
    genderStatistics[contact.gender.source] += 1;
  }
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));

  return {
    total: contacts.length,
    genderStatistics,
    offset: safeOffset,
    limit: safeLimit,
    contacts: contacts
      .slice(safeOffset, safeOffset + safeLimit)
      .map(({ lastActivityAt, lastIncomingAt, unread, ...contact }) => contact)
  };
}

function contactActivityByPhone(data, readState = {}) {
  const activity = new Map();
  const getRecord = phoneJid => {
    let record = activity.get(phoneJid);
    if (!record) {
      record = { lastActivityAt: 0, lastIncomingAt: 0, unread: false };
      activity.set(phoneJid, record);
    }
    return record;
  };
  for (const [jid, messages] of Object.entries(data.history || {})) {
    if (!isDirectChat(jid) || !Array.isArray(messages)) continue;
    const phoneJid = getPhoneJid(jid, data.contacts[jid]?.phoneJid, data.contacts[jid]?.jid) || jid;
    const record = getRecord(phoneJid);
    const latest = latestMessage(messages);
    const latestTimestamp = timestampMs(latest?.timestamp);
    if (Number.isFinite(latestTimestamp) && latestTimestamp > 0) {
      record.lastActivityAt = Math.max(record.lastActivityAt, latestTimestamp);
    }
    const readStatus = getChatReadStatus(messages, readState[jid]);
    const incomingTimestamp = timestampMs(readStatus.lastIncomingAt);
    if (Number.isFinite(incomingTimestamp) && incomingTimestamp > 0) {
      record.lastIncomingAt = Math.max(record.lastIncomingAt, incomingTimestamp);
    }
    record.unread ||= readStatus.unread;
  }
  for (const [jid, timestamp] of Object.entries(data.whatsappChatActivity || {})) {
    const phoneJid = getPhoneJid(jid, data.contacts[jid]?.phoneJid, data.contacts[jid]?.jid) || jid;
    if (!phoneJid.endsWith('@s.whatsapp.net')) continue;
    const record = getRecord(phoneJid);
    const activityTimestamp = timestampMs(timestamp);
    if (Number.isFinite(activityTimestamp) && activityTimestamp > 0) {
      record.lastActivityAt = Math.max(record.lastActivityAt, activityTimestamp);
    }
  }
  return activity;
}

export function getDashboardWeeklyChatActivity(data, timeZone = 'UTC', now = Date.now()) {
  const nowTimestamp = timestampMs(now);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  } catch {
    throw new Error('The requested timezone is invalid.');
  }

  const nowParts = Object.fromEntries(
    formatter.formatToParts(new Date(nowTimestamp)).map(part => [part.type, part.value])
  );
  const today = Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, Number(nowParts.day));
  const daysByDate = new Map();
  for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
    const date = new Date(today - daysAgo * 24 * 60 * 60 * 1000);
    const dateKey = date.toISOString().slice(0, 10);
    daysByDate.set(dateKey, {
      date: dateKey,
      day: new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        timeZone: 'UTC'
      }).format(date),
      conversations: new Set(),
      newConversations: 0
    });
  }

  const firstIncomingByChat = new Map();
  for (const [jid, messages] of Object.entries(data.history)) {
    if (!isDirectChat(jid) || !Array.isArray(messages)) continue;
    const canonicalJid = getPhoneJid(
      jid,
      data.contacts[jid]?.phoneJid,
      data.contacts[jid]?.jid
    ) || jid;
    for (const message of messages) {
      if (message.role !== 'client') continue;
      const timestamp = timestampMs(message.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > nowTimestamp) continue;
      const firstIncomingAt = firstIncomingByChat.get(canonicalJid);
      if (firstIncomingAt === undefined || timestamp < firstIncomingAt) {
        firstIncomingByChat.set(canonicalJid, timestamp);
      }
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
      );
      const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
      daysByDate.get(dateKey)?.conversations.add(canonicalJid);
    }
  }

  for (const timestamp of firstIncomingByChat.values()) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
    );
    const day = daysByDate.get(`${parts.year}-${parts.month}-${parts.day}`);
    if (day) day.newConversations += 1;
  }

  return {
    timeZone,
    days: [...daysByDate.values()].map(({ date, day, conversations, newConversations }) => ({
      date,
      day,
      chats: conversations.size,
      newChats: newConversations
    }))
  };
}

export function getDashboardOverview(data, now = Date.now(), timeZone = 'UTC') {
  const directChats = Object.entries(data.history)
    .filter(([jid, messages]) => isDirectChat(jid) && Array.isArray(messages) && messages.length > 0);
  const handledChats = directChats.filter(([, messages]) =>
    messages.some(message => message.role === 'agent')).length;
  const recentWindow = now - 24 * 60 * 60 * 1000;
  const activeToday = directChats.filter(([, messages]) =>
    timestampMs(latestMessage(messages)?.timestamp) >= recentWindow).length;
  const progressRecords = Object.values(data.progress);
  const configuredLessonCount = Object.values(data.lessons)
    .reduce((total, grade) => total + (grade.lessons?.length || 0), 0);
  const messagesByPhone = getClientMessagesByPhone(data);
  const esContacts = listDashboardEsContacts(
    data,
    '',
    0,
    MAX_PAGE_SIZE,
    messagesByPhone
  );
  return {
    totalChats: directChats.length,
    activeToday,
    handledChats,
    esContacts: esContacts.total,
    permanentHistoryContacts: Object.values(data.contacts)
      .filter(contact => contact.isEs === true).length,
    genderStatistics: esContacts.genderStatistics,
    weeklyChatActivity: getDashboardWeeklyChatActivity(data, timeZone, now),
    studentsWithProgress: progressRecords.length,
    awaitingTask: progressRecords.filter(student => student.status === 'awaiting_task').length,
    awaitingReattempt: progressRecords.filter(student => student.status === 'awaiting_reattempt').length,
    completed: progressRecords.filter(student => student.status === 'completed').length,
    configuredLessons: configuredLessonCount
  };
}

export function getDashboardAgentStatus(status, handledChats, now = Date.now()) {
  const updatedAt = Date.parse(status?.updatedAt || '');
  const heartbeatAge = now - updatedAt;
  const hasFreshHeartbeat = Number.isFinite(updatedAt) &&
    heartbeatAge >= 0 &&
    heartbeatAge <= AGENT_HEARTBEAT_MAX_AGE_MS;
  const connectionState = !hasFreshHeartbeat
    ? status?.connectionState ? 'disconnected' : 'unknown'
    : status.connectionState === 'connected'
      ? 'connected'
      : status.connectionState === 'connecting' || status.connectionState === 'starting'
        ? 'connecting'
        : 'disconnected';

  return {
    connectionState,
    connected: connectionState === 'connected',
    respondingEnabled: status?.respondingEnabled !== false,
    queuePaused: status?.queuePaused === true,
    lastConnectedAt: status?.lastConnectedAt || null,
    lastHeartbeatAt: Number.isFinite(updatedAt) ? status.updatedAt : null,
    account: status?.account && typeof status.account === 'object'
      ? {
        name: typeof status.account.name === 'string' ? status.account.name : '',
        phoneNumber: typeof status.account.phoneNumber === 'string' &&
          /^\d+$/.test(status.account.phoneNumber) ? status.account.phoneNumber : null
      }
      : null,
    handledChats
  };
}

export function listDashboardChats(
  data,
  search = '',
  offset = 0,
  limit = DEFAULT_PAGE_SIZE,
  {
    activeSince = null,
    handledOnly = false,
    readState = {},
    sort = 'date-desc',
    readFilter = 'all'
  } = {}
) {
  const normalizedSearch = search.trim().toLocaleLowerCase().slice(0, MAX_SEARCH_LENGTH);
  const chats = [];
  const messagesByPhone = getClientMessagesByPhone(data);

  for (const [jid, messages] of Object.entries(data.history)) {
    if (!isDirectChat(jid) || !messages.length) continue;

    const contact = data.contacts[jid];
    const name = displayName(contact, jid);
    const latest = latestMessage(messages);
    const latestAgentMessage = latestMessage(messages.filter(message => message.role === 'agent'));
    const lastActivity = timestampMs(latest?.timestamp);
    const readStatus = getChatReadStatus(messages, readState[jid]);
    if (activeSince !== null && lastActivity < activeSince) continue;
    if (handledOnly && !latestAgentMessage) continue;
    if (readFilter === 'unread' && !readStatus.unread) continue;
    if (readFilter === 'read' && readStatus.unread) continue;
    const matchesSearch = !normalizedSearch ||
      name.toLocaleLowerCase().includes(normalizedSearch) ||
      jid.split('@')[0].includes(normalizedSearch) ||
      messages.some(message => message.text?.toLocaleLowerCase().includes(normalizedSearch));

    if (!matchesSearch) continue;

    const student = data.progress[jid] || null;
    const lesson = student ? lessonForStudent(student, data.lessons) : null;
    chats.push({
      jid,
      name,
      lastMessage: latest?.text || '',
      lastMessageRole: latest?.role || '',
      lastActivity,
      lastIncomingAt: timestampMs(readStatus.lastIncomingAt),
      unread: readStatus.unread,
      lastHandledAt: latestAgentMessage ? timestampMs(latestAgentMessage.timestamp) : null,
      isEs: Boolean(contact?.isEs),
      gender: genderForContact(data, jid, messagesByPhone),
      progress: student ? {
        gradeName: data.lessons[student.grade]?.name || student.grade,
        status: student.status,
        lessonTitle: lesson?.title || student.currentLessonId || ''
      } : null
    });
  }

  chats.sort((left, right) => {
    if (handledOnly) return right.lastHandledAt - left.lastHandledAt;
    if (sort === 'date-asc') return left.lastActivity - right.lastActivity;
    if (sort === 'unread-first') return Number(right.unread) - Number(left.unread) ||
      right.lastActivity - left.lastActivity;
    if (sort === 'read-first') return Number(left.unread) - Number(right.unread) ||
      right.lastActivity - left.lastActivity;
    return right.lastActivity - left.lastActivity;
  });
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));

  return {
    total: chats.length,
    offset: safeOffset,
    limit: safeLimit,
    chats: chats.slice(safeOffset, safeOffset + safeLimit)
  };
}

export function getDashboardConversation(data, jid) {
  if (!jid || !isDirectChat(jid)) return null;
  const messages = data.history[jid];
  if (!messages) return null;

  const contact = data.contacts[jid];
  const gender = genderForContact(data, jid, getClientMessagesByPhone(data));
  const student = data.progress[jid] || null;
  const lesson = student ? lessonForStudent(student, data.lessons) : null;
  const recentMessages = messages.slice(-MAX_CONVERSATION_MESSAGES);

  return {
    jid,
    name: displayName(contact, jid),
    isEs: Boolean(contact?.isEs),
    gender,
    progress: student ? {
      gradeName: data.lessons[student.grade]?.name || student.grade,
      status: student.status,
      lessonTitle: lesson?.title || student.currentLessonId || '',
      deliveredAt: student.deliveredAt || null
    } : null,
    totalMessages: messages.length,
    messages: recentMessages.map(message => ({
      role: message.role,
      text: message.text,
      timestamp: timestampMs(message.timestamp)
    }))
  };
}

export function listRecentAgentMessages(data, limit = 100) {
  const contacts = data.contacts || {};
  const contactsByPhone = new Map();
  for (const [jid, contact] of Object.entries(contacts)) {
    const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
    if (phoneJid && !contactsByPhone.has(phoneJid)) contactsByPhone.set(phoneJid, contact);
  }
  let sequence = 0;
  return Object.entries(data.history || {})
    .filter(([jid]) => isDirectChat(jid))
    .flatMap(([jid, messages]) => {
      if (!Array.isArray(messages)) return [];
      const phoneJid = getPhoneJid(jid, contacts[jid]?.phoneJid, contacts[jid]?.jid);
      const phoneNumber = phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0] || '';
      const linkedContact = contacts[jid] || contactsByPhone.get(phoneJid);
      const name = displayName(linkedContact, jid);
      return messages
        .filter(message =>
          (message.role === 'client' || message.role === 'agent') &&
          typeof message.text === 'string' &&
          message.text.trim())
        .map(message => ({
          jid,
          name,
          phoneNumber,
          role: message.role,
          text: message.text,
          timestamp: timestampMs(message.timestamp),
          order: sequence++
        }));
    })
    .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order)
    .slice(-Math.max(1, Math.floor(limit)))
    .map(({ order, ...message }) => message);
}

export function getDashboardStudentActivity(data, jid, days, timeZone, now = Date.now()) {
  if (!jid || !isDirectChat(jid)) return null;
  if (![30, 90].includes(days)) throw new Error('Activity range must be 30 or 90 days.');
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 100) {
    throw new Error('A valid timezone is required.');
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    });
  } catch {
    throw new Error('The requested timezone is invalid.');
  }

  const phoneJid = getPhoneJid(jid, data.contacts[jid]?.phoneJid, data.contacts[jid]?.jid);
  const aliases = Object.entries(data.contacts).filter(([contactJid, contact]) =>
    contactJid === jid ||
    (phoneJid && getPhoneJid(contactJid, contact.phoneJid, contact.jid) === phoneJid));
  const histories = Object.entries(data.history || {})
    .filter(([historyJid, messages]) => Array.isArray(messages) &&
      (historyJid === jid ||
        (phoneJid && getPhoneJid(
          historyJid,
          data.contacts[historyJid]?.phoneJid,
          data.contacts[historyJid]?.jid
        ) === phoneJid)))
    .flatMap(([historyJid, messages], historyOrder) =>
      messages.map((message, messageOrder) => ({
        ...message,
        timestamp: timestampMs(message.timestamp),
        historyOrder,
        messageOrder
      })))
    .filter(message => Number.isFinite(message.timestamp) && message.timestamp > 0)
    .sort((left, right) =>
      left.timestamp - right.timestamp ||
      left.historyOrder - right.historyOrder ||
      left.messageOrder - right.messageOrder);
  if (!histories.length && aliases.length === 0) return null;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const counts = ACTIVITY_WEEKDAYS.map(day => ({ day, hours: Array(24).fill(0) }));
  const hourlyTotals = Array(24).fill(0);
  const activeDates = new Set();
  let totalMessages = 0;
  const dailyActivityByDate = new Map();
  const responseTimesByDate = new Map();
  const dailyFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateKey = timestamp => {
    const parts = Object.fromEntries(
      dailyFormatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  let pendingStudentMessageAt = null;
  const responseTimes = [];
  let unansweredIncomingCount = 0;

  for (const message of histories) {
    const timestamp = message.timestamp;
    if (timestamp > now) continue;
    if (message.role === 'client' && timestamp >= cutoff) {
      totalMessages += 1;
      const key = dateKey(timestamp);
      let daily = dailyActivityByDate.get(key);
      if (!daily) {
        daily = { incoming: 0, outgoing: 0 };
        dailyActivityByDate.set(key, daily);
      }
      daily.incoming += 1;

      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
      );
      const weekday = ACTIVITY_WEEKDAYS.indexOf(parts.weekday);
      const hour = Number(parts.hour);
      if (weekday >= 0 && hour >= 0 && hour <= 23) {
        counts[weekday].hours[hour] += 1;
        hourlyTotals[hour] += 1;
        activeDates.add(key);
      }

      pendingStudentMessageAt = timestamp;
      continue;
    }
    if (message.role === 'agent') {
      if (timestamp >= cutoff) {
        const key = dateKey(timestamp);
        const daily = dailyActivityByDate.get(key) || { incoming: 0, outgoing: 0 };
        daily.outgoing += 1;
        dailyActivityByDate.set(key, daily);
      }
      if (pendingStudentMessageAt !== null) {
        if (pendingStudentMessageAt >= cutoff) {
          const delay = Math.max(0, timestamp - pendingStudentMessageAt);
          responseTimes.push(delay);
          const key = dateKey(pendingStudentMessageAt);
          const delays = responseTimesByDate.get(key) || [];
          delays.push(delay);
          responseTimesByDate.set(key, delays);
        }
        pendingStudentMessageAt = null;
      }
    }
  }

  if (pendingStudentMessageAt !== null && pendingStudentMessageAt >= cutoff) {
    unansweredIncomingCount = 1;
  }
  const todayParts = Object.fromEntries(
    dailyFormatter.formatToParts(new Date(now)).map(part => [part.type, part.value])
  );
  const todayUtc = Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, Number(todayParts.day));
  const dailyActivity = Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc - (days - 1 - index) * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const delays = responseTimesByDate.get(date) || [];
    return {
      date,
      incoming: dailyActivityByDate.get(date)?.incoming || 0,
      outgoing: dailyActivityByDate.get(date)?.outgoing || 0,
      responseCount: delays.length,
      medianResponseMs: delays.length ? median(delays) : null
    };
  });
  const student = data.progress[jid] || Object.entries(data.progress || {}).find(
    ([progressJid]) => phoneJid &&
      getPhoneJid(
        progressJid,
        data.contacts[progressJid]?.phoneJid,
        data.contacts[progressJid]?.jid
      ) === phoneJid
  )?.[1];
  const currentLesson = student ? lessonForStudent(student, data.lessons) : null;
  return {
    jid,
    days,
    timeZone,
    totalMessages,
    activeDays: activeDates.size,
    hourlyTotals,
    weekdays: counts,
    dailyActivity,
    responseCount: responseTimes.length,
    averageResponseMs: responseTimes.length
      ? responseTimes.reduce((sum, delay) => sum + delay, 0) / responseTimes.length
      : null,
    medianResponseMs: responseTimes.length ? median(responseTimes) : null,
    unansweredIncomingCount,
    lessonProgress: student ? {
      gradeName: data.lessons[student.grade]?.name || student.grade,
      status: student.status,
      lessonTitle: currentLesson?.title || student.currentLessonId || '',
      deliveredAt: student.deliveredAt || null
    } : null
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function isSameOriginLoopbackRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.protocol === 'http:' &&
      parsedOrigin.host === host &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

function readRequestBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        body = '';
        tooLarge = true;
        return;
      }
      if (!tooLarge) body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body is too large.'));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must contain valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleBroadcastPost(req, res, readData, broadcastFiles, mediaDirectory) {
  if (!isSameOriginLoopbackRequest(req)) {
    sendJson(res, 403, { error: 'Broadcast actions are only accepted from this local dashboard.' });
    return;
  }

  try {
    const body = await readRequestBody(req);
    const requests = readJsonFileOr(broadcastFiles.requests, []);
    if (!Array.isArray(requests)) throw new Error('Invalid broadcast request queue.');

    if (body.action === 'cancel') {
      const job = requests.find(request => request.id === body.id);
      if (!job) {
        sendJson(res, 404, { error: 'Broadcast job not found.' });
        return;
      }
      const state = readJsonFileOr(broadcastFiles.state, { jobs: {} });
      const jobState = state.jobs?.[job.id];
      if (jobState && !['queued', 'running'].includes(jobState.status)) {
        sendJson(res, 409, { error: 'This broadcast can no longer be cancelled.' });
        return;
      }
      if (!jobState) {
        fs.mkdirSync(path.dirname(broadcastFiles.state), { recursive: true });
        writeJsonFile(broadcastFiles.state, {
          ...state,
          jobs: {
            ...state.jobs,
            [job.id]: {
              status: 'cancelled',
              total: job.jids.length,
              sent: 0,
              skipped: 0,
              uncertain: 0,
              nextIndex: 0,
              createdAt: job.createdAt,
              completedAt: new Date().toISOString()
            }
          }
        });
      }
      job.cancelled = true;
      writeJsonFile(broadcastFiles.requests, requests);
      sendJson(res, 200, { id: job.id, status: 'cancellation_requested' });
      return;
    }

    const data = readData();
    const recipientType = body.recipientType === undefined ? 'es' : body.recipientType;
    const activityDate = body.activityDate === undefined ? '' : body.activityDate;
    const activityTimeZone = body.activityTimeZone === undefined ? 'UTC' : body.activityTimeZone;
    const eligibleJids = new Set(
      getEligibleBroadcastContacts(data, data.optedOutJids || [], recipientType).map(contact => contact.jid)
    );
    let recipientActivityAt = null;
    if (activityDate !== '') {
      const datedRecipients = listEligibleBroadcastContacts(
        data,
        data.optedOutJids || [],
        '',
        0,
        5000,
        { date: activityDate, timeZone: activityTimeZone, recipientType }
      );
      recipientActivityAt = new Map(datedRecipients.contacts.map(contact => [
        contact.jid,
        contact.lastIncomingAt || contact.lastActivityAt
      ]));
    }
    const requestedJids = Array.isArray(body.jids) ? body.jids : [];
    const uniqueJids = [...new Set(requestedJids)];
    if (uniqueJids.length !== requestedJids.length) {
      throw new Error('The selected recipient list contains duplicates. Refresh and select contacts again.');
    }
    const selectedJids = uniqueJids;
    if (selectedJids.some(jid =>
      !eligibleJids.has(jid) || (recipientActivityAt && !recipientActivityAt.has(jid)))) {
      throw new Error('Some selected contacts are no longer eligible. Refresh and select contacts again.');
    }
    const attachmentIds = body.attachments === undefined ? [] : body.attachments;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_BROADCAST_ATTACHMENTS) {
      throw new Error(`A bulk message can include up to ${MAX_BROADCAST_ATTACHMENTS} attachments.`);
    }
    const attachments = attachmentIds.map(id => getBroadcastMediaMetadata(id, mediaDirectory));
    const validRequest = validateBroadcastRequest({
      text: body.text,
      jids: selectedJids,
      attachments: attachmentIds,
      recipientType
    });

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const job = {
      id,
      text: validRequest.text,
      attachments,
      jids: validRequest.jids,
      recipientType,
      ...(recipientActivityAt ? {
        activityDate,
        activityTimeZone,
        activityAt: Object.fromEntries(validRequest.jids.map(jid => [jid, recipientActivityAt.get(jid)]))
      } : {}),
      createdAt: new Date().toISOString(),
      cancelled: false
    };
    requests.push(job);
    fs.mkdirSync(path.dirname(broadcastFiles.requests), { recursive: true });
    writeJsonFile(broadcastFiles.requests, requests);
    sendJson(res, 202, { id, status: 'queued', total: job.jids.length, createdAt: job.createdAt });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

export function createAdminDashboardServer({
  readData = readDashboardData,
  broadcastFiles = {
    requests: BROADCAST_REQUESTS_FILE,
    state: BROADCAST_STATE_FILE
  },
  messageRequestsFile = MESSAGE_REQUESTS_FILE,
  agentStatusFile = AGENT_STATUS_FILE,
  agentQrFile = AGENT_QR_FILE,
  agentControlFile,
  agentLogFile = AGENT_LOG_FILE,
  agentMediaActivityFile = AGENT_MEDIA_ACTIVITY_FILE,
  agentMediaRetryRequestsFile = AGENT_MEDIA_RETRY_REQUESTS_FILE,
  chatReadStateFile = CHAT_READ_STATE_FILE,
  incomingChatQueueFile = INCOMING_CHAT_QUEUE_FILE,
  whatsappChatActivityFile = WHATSAPP_CHAT_ACTIVITY_FILE,
  broadcastMediaDirectory = BROADCAST_MEDIA_DIRECTORY,
  authFile = path.join(ROOT_DIR, 'data', 'admin_auth.json'),
  authManager = new DashboardAuth(authFile),
  contactSyncRequestsFile = CONTACT_SYNC_REQUESTS_FILE,
  contactSyncStatusFile = CONTACT_SYNC_STATUS_FILE,
  blockedContactsFile = BLOCKED_NUMBERS_FILE,
  contactGenderFile = CONTACT_GENDER_OVERRIDES_FILE,
  paymentLabelsFile = CONTACT_PAYMENT_LABELS_FILE,
  readContacts = null,
  whatsappPresenceFile = WHATSAPP_PRESENCE_FILE,
  whatsappPresenceRequestsFile = WHATSAPP_PRESENCE_REQUESTS_FILE,
  contactsFile = CONTACTS_FILE,
  followUpStateFile = FOLLOWUP_STATE_FILE,
  studentWorkbookFile = readData === readDashboardData ? STUDENT_WORKBOOK_FILE : null,
  lessonsFile = LESSONS_FILE,
  lessonMediaDirectory = LESSON_MEDIA_DIR,
  scheduledLessonsFile = SCHEDULED_LESSONS_FILE,
  progressFile = PROGRESS_FILE
} = {}) {
  const blockedContacts = createBlockedContactsStore(blockedContactsFile);
  const contactGenders = createContactGenderStore(contactGenderFile);
  const paymentLabels = createContactPaymentLabelsStore(paymentLabelsFile);
  const scheduledLessons = createScheduledLessonStore({ filePath: scheduledLessonsFile });
  const getManualScheduleOptions = () => {
    const contacts = readContactsFile();
    const progress = readJsonFileOr(progressFile, {});
    const studentsByPhone = new Map();
    for (const jid of new Set([...Object.keys(contacts), ...Object.keys(progress)])) {
      if (!isDirectChat(jid)) continue;
      const contact = contacts[jid] || {};
      const studentProgress = progress[jid] || {};
      const phoneJid = getPhoneJid(jid, contact.phoneJid, contact.jid, studentProgress.phoneJid);
      const key = phoneJid || jid;
      const previous = studentsByPhone.get(key);
      const gradeProgress = studentProgress.grade
        ? studentProgress
        : previous?.progress || {};
      const displayContact = contact.name ? contact : previous?.contact || contact;
      studentsByPhone.set(key, {
        jid: phoneJid || jid,
        phoneJid,
        name: displayName(displayContact, phoneJid || jid),
        gradeKey: gradeProgress.grade || '',
        progress: gradeProgress,
        contact: displayContact
      });
    }
    const students = [...studentsByPhone.values()]
      .filter(student => student.phoneJid && /^\d+@s\.whatsapp\.net$/.test(student.phoneJid))
      .map(({ jid, phoneJid, name, gradeKey }) => ({ jid, phoneJid, name, gradeKey }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const lessonsConfig = readJsonFile(lessonsFile);
    const mediaRoot = fs.realpathSync(lessonMediaDirectory);
    const lessons = Object.entries(lessonsConfig).flatMap(([gradeKey, grade]) =>
      (Array.isArray(grade.lessons) ? grade.lessons : []).flatMap(lesson => {
        if (!lesson.videoFile || !lesson.taskMessage?.trim() ||
            !Array.isArray(lesson.answerKey) || lesson.answerKey.length === 0) return [];
        const candidatePath = path.resolve(ROOT_DIR, lesson.videoFile);
        const relativePath = path.relative(mediaRoot, candidatePath);
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return [];
        let videoPath;
        try {
          videoPath = fs.realpathSync(candidatePath);
        } catch (error) {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
        const realRelativePath = path.relative(mediaRoot, videoPath);
        if (!realRelativePath || realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) return [];
        const stats = fs.statSync(videoPath);
        if (!stats.isFile() || stats.size === 0) return [];
        return [{
          gradeKey,
          gradeName: grade.name || gradeKey,
          lessonId: lesson.id,
          title: lesson.title || lesson.id
        }];
      })
    );
    return { students, lessons };
  };
  const readContactsFile = () => readContacts
    ? readContacts()
    : readJsonFile(contactsFile);
  const blockedContactsWithNames = () => {
    const contacts = readContacts
      ? readContacts()
      : readJsonFileOr(contactsFile, {});
    return blockedContacts.list().map(record => ({
      ...record,
      name: record.name || contactNameForPhoneNumber(contacts, record.number) || record.number
    }));
  };
  const getInactiveLessonRecipients = now => {
    const followUpState = readJsonFileOr(followUpStateFile, { optedOutJids: [] });
    return getInactiveEligibleEsContacts({
      contacts: readContactsFile(),
      history: {},
      whatsappChatActivity: readJsonFileOr(whatsappChatActivityFile, {}),
      blockedNumbers: blockedContacts.list()
    }, Array.isArray(followUpState.optedOutJids) ? followUpState.optedOutJids : [], {
      inactiveDays: 10,
      now
    });
  };
  const getLessonForBroadcast = (gradeKey, lessonId, isStandalone) => {
    const lessonsConfig = readJsonFile(lessonsFile);
    const grade = lessonsConfig[gradeKey];
    const collection = isStandalone ? grade?.standaloneLessons : grade?.lessons;
    const lesson = Array.isArray(collection)
      ? collection.find(item => item.id === lessonId)
      : null;
    if (!lesson || typeof lesson.videoFile !== 'string' || !lesson.videoFile.trim()) {
      throw new Error('The selected lesson or its video file is no longer available.');
    }
    const mediaRoot = path.resolve(lessonMediaDirectory);
    const candidatePath = path.resolve(ROOT_DIR, lesson.videoFile);
    const relativePath = path.relative(mediaRoot, candidatePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('The lesson video must be inside the lesson media folder.');
    }
    const videoPath = fs.realpathSync(candidatePath);
    const realRelativePath = path.relative(fs.realpathSync(mediaRoot), videoPath);
    if (!realRelativePath || realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
      throw new Error('The lesson video must be inside the lesson media folder.');
    }
    const stats = fs.statSync(videoPath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error('The lesson video file is missing or empty.');
    }
    return {
      title: lesson.title || lessonId,
      caption: lesson.caption || lesson.title || '',
      videoFile: realRelativePath
    };
  };
  const lessonBroadcastPreviews = new Map();
  const pruneLessonBroadcastPreviews = now => {
    for (const [token, preview] of lessonBroadcastPreviews) {
      if (preview.expiresAt <= now) lessonBroadcastPreviews.delete(token);
    }
  };
  const whatsappPresence = new WhatsAppPresenceManager({
    presenceFile: whatsappPresenceFile,
    requestsFile: whatsappPresenceRequestsFile
  });
  const chatReadState = new ChatReadStateStore(chatReadStateFile);
  const contactSync = new ContactSyncManager({
    requestsFile: contactSyncRequestsFile,
    statusFile: contactSyncStatusFile
  });
  const cacheDataSnapshots = readData === readDashboardData;
  let lastBaseData = null;
  let cachedDashboardData = null;
  const readDataWithBlockedContacts = () => {
    const data = readData();
    if (cacheDataSnapshots && data === lastBaseData) return cachedDashboardData;
    lastBaseData = data;
    cachedDashboardData = {
      ...data,
      blockedNumbers: blockedContacts.list(),
      genderOverrides: contactGenders.list(),
      paymentLabels: paymentLabels.list()
    };
    return cachedDashboardData;
  };
  const eventClients = new Set();
  const pendingChanges = new Set();
  const watchedFiles = new Set([
    ...DASHBOARD_WATCHED_FILES,
    agentStatusFile,
    agentQrFile,
    agentLogFile,
    agentMediaActivityFile,
    incomingChatQueueFile,
    chatReadStateFile,
    whatsappChatActivityFile,
    contactSyncRequestsFile,
    contactSyncStatusFile,
    paymentLabelsFile,
    whatsappPresenceFile,
    blockedContactsFile,
    contactGenderFile,
    contactsFile,
    lessonsFile,
    messageRequestsFile,
    scheduledLessonsFile,
    broadcastFiles.requests,
    broadcastFiles.state
  ].map(filePath => path.resolve(filePath)));
  const watchedDirectories = new Map();
  for (const filePath of watchedFiles) {
    const directory = path.dirname(filePath);
    if (!watchedDirectories.has(directory)) watchedDirectories.set(directory, new Set());
    watchedDirectories.get(directory).add(path.basename(filePath));
  }

  let changeTimer = null;
  let workbookRefreshTimer = null;
  const watchers = [];
  const publishChanges = () => {
    changeTimer = null;
    if (pendingChanges.size === 0) return;
    const data = JSON.stringify({ files: [...pendingChanges] });
    pendingChanges.clear();
    for (const response of eventClients) {
      response.write(`event: dashboard-update\ndata: ${data}\n\n`);
    }
  };
  const scheduleChange = fileName => {
    pendingChanges.add(fileName);
    if (!changeTimer) changeTimer = setTimeout(publishChanges, 100);
  };
  const studentWorkbook = studentWorkbookFile
    ? createStudentWorkbookManager({
      readData,
      filePath: studentWorkbookFile,
      onUpdated: () => scheduleChange(path.basename(studentWorkbookFile))
    })
    : null;

  for (const [directory, fileNames] of watchedDirectories) {
    try {
      const watcher = fs.watch(directory, (_eventType, changedName) => {
        if (changedName === null) {
          for (const fileName of fileNames) {
            scheduleChange(fileName);
            if (studentWorkbook && STUDENT_WORKBOOK_SOURCE_FILES.has(fileName)) {
              if (workbookRefreshTimer) clearTimeout(workbookRefreshTimer);
              workbookRefreshTimer = setTimeout(() => {
                workbookRefreshTimer = null;
                studentWorkbook.refresh();
              }, 250);
            }
          }
          return;
        }
        const fileName = changedName.toString();
        if (fileNames.has(fileName)) {
          scheduleChange(fileName);
          if (studentWorkbook && STUDENT_WORKBOOK_SOURCE_FILES.has(fileName)) {
            if (workbookRefreshTimer) clearTimeout(workbookRefreshTimer);
            workbookRefreshTimer = setTimeout(() => {
              workbookRefreshTimer = null;
              studentWorkbook.refresh();
            }, 250);
          }
        }
      });
      watcher.on('error', error => {
        console.error(`[Admin Dashboard] Data watcher failed for ${directory}:`, error.message);
      });
      watchers.push(watcher);
    } catch (error) {
      console.error(`[Admin Dashboard] Could not watch data directory ${directory}:`, error.message);
    }
  }

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');

    if (requestUrl.pathname.startsWith('/api/admin/auth/')) {
      if (req.method === 'GET' && requestUrl.pathname === '/api/admin/auth/status') {
        try {
          sendJson(res, 200, authManager.status(req));
        } catch (error) {
          console.error('[Admin Dashboard] Could not read dashboard authentication state:', error.message);
          sendJson(res, 500, { error: 'Could not read dashboard authentication state.' });
        }
        return;
      }

      if (req.method === 'POST' &&
          ['/api/admin/auth/setup', '/api/admin/auth/login', '/api/admin/auth/logout'].includes(requestUrl.pathname)) {
        if (!isSameOriginLoopbackRequest(req)) {
          sendJson(res, 403, { error: 'Dashboard authentication requests must come from this local dashboard.' });
          return;
        }
        if (requestUrl.pathname === '/api/admin/auth/logout') {
          authManager.logout(req);
          authManager.clearCookie(res);
          sendJson(res, 200, { authenticated: false });
          return;
        }
        readRequestBody(req).then(async body => {
          if (requestUrl.pathname === '/api/admin/auth/setup') {
            if (body.password !== body.confirmPassword) {
              sendJson(res, 400, { error: 'The passwords do not match.' });
              return;
            }
            const result = await authManager.setup(body.password);
            sendJson(res, result.ok ? 201 : result.status, result.ok ? { configured: true } : { error: result.error });
            return;
          }
          if (requestUrl.pathname === '/api/admin/auth/login') {
            if (!authManager.isConfigured()) {
              sendJson(res, 409, { error: 'Set up a dashboard password first.' });
              return;
            }
            const result = await authManager.login(req, body.password);
            if (!result.ok) {
              if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
              sendJson(res, result.status, { error: result.error });
              return;
            }
            authManager.setCookie(res, result.token, result.maxAge);
            sendJson(res, 200, { authenticated: true });
            return;
          }
        }).catch(error => {
          console.error('[Admin Dashboard] Could not process dashboard authentication:', error.message);
          sendJson(res, 500, { error: 'Could not process dashboard authentication.' });
        });
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (requestUrl.pathname.startsWith('/api/admin/') && !authManager.isAuthenticated(req)) {
      sendJson(res, 401, { error: 'Dashboard login required.' });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff'
      });
      res.flushHeaders();
      eventClients.add(res);
      res.write(`event: connected\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
      req.on('close', () => eventClients.delete(res));
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/chat-queue') {
      try {
        sendJson(res, 200, readIncomingChatQueue(incomingChatQueueFile));
      } catch (error) {
        console.error('[Admin Dashboard] Could not read the incoming chat queue:', error.message);
        sendJson(res, 500, { error: 'Could not read the incoming chat queue.' });
      }
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/chat-queue-cancel') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Chat queue controls must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (typeof body?.jid !== 'string' || !isDirectChat(body.jid)) {
          sendJson(res, 400, { error: 'A valid direct chat ID is required.' });
          return;
        }
        const status = readJsonFile(agentStatusFile);
        if (status.connectionState !== 'connected') {
          sendJson(res, 409, { error: 'Connect the WhatsApp agent before cancelling a queued chat.' });
          return;
        }
        const queue = readIncomingChatQueue(incomingChatQueueFile);
        if (!queue.waiting.some(entry => entry.jid === body.jid)) {
          const message = queue.active?.jid === body.jid
            ? 'This student is already being handled and cannot be cancelled from the waiting queue.'
            : 'This student is no longer waiting in the chat queue.';
          sendJson(res, 409, { error: message });
          return;
        }
        const request = requestAgentQueueCancellation(body.jid, agentControlFile);
        sendJson(res, 202, {
          status: 'cancellation_requested',
          jid: body.jid,
          requestedAt: request.requestedAt
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not cancel queued chat handling:', error.message);
        sendJson(res, 500, { error: 'Could not cancel queued chat handling.' });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/chat-read') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Chat read updates must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (typeof body.jid !== 'string' || !isDirectChat(body.jid)) {
          sendJson(res, 400, { error: 'A valid direct chat ID is required.' });
          return;
        }
        const data = readDataWithBlockedContacts();
        const messages = data.history[body.jid];
        if (!messages) {
          sendJson(res, 404, { error: 'Chat not found.' });
          return;
        }
        chatReadState.ensureInitialized(data.history);
        const readState = chatReadState.markRead(body.jid, messages);
        scheduleChange(path.basename(chatReadStateFile));
        sendJson(res, 200, {
          jid: body.jid,
          ...getChatReadStatus(messages, readState[body.jid])
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not mark chat as read:', error.message);
        sendJson(res, 500, { error: 'Could not mark chat as read.' });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/presence-subscribe') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Presence subscriptions must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const jids = Array.isArray(body.jids)
          ? body.jids
          : typeof body.jid === 'string'
            ? [body.jid]
            : [];
        if (jids.length < 1 || jids.length > 30 ||
            jids.some(jid => typeof jid !== 'string' || !isDirectChat(jid))) {
          sendJson(res, 400, { error: 'Provide between 1 and 30 valid direct chat IDs.' });
          return;
        }
        const data = readDataWithBlockedContacts();
        if (jids.some(jid => !hasKnownPresenceChat(data, jid))) {
          sendJson(res, 404, { error: 'One or more chats were not found.' });
          return;
        }
        const subscriptionJids = jids.map(jid => {
          const contact = data.contacts[jid];
          return getPhoneJid(jid, contact?.phoneJid, contact?.jid) || jid;
        });
        const subscriptions = whatsappPresence.requestSubscriptions(subscriptionJids);
        sendJson(res, subscriptions.some(subscription => subscription.status === 'queued') ? 202 : 200, {
          subscriptions
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not request WhatsApp presence:', error.message);
        sendJson(res, 500, { error: 'Could not request WhatsApp presence.' });
      });
      return;
    }

    if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/admin')) {
      const htmlPath = path.join(ROOT_DIR, 'public', 'admin.html');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }

    const blockMatch = requestUrl.pathname.match(/^\/api\/admin\/contacts\/(\d+)\/(ban|unblock)$/);
    const deleteMatch = requestUrl.pathname.match(/^\/api\/admin\/contacts\/(\d+)$/);
    if ((req.method === 'POST' && blockMatch) || (req.method === 'DELETE' && deleteMatch)) {
      const match = blockMatch || deleteMatch;
      handleBlockedContactMutation(req, res, {
        blockedContacts,
        contactsFile,
        phoneNumber: match[1],
        action: req.method === 'DELETE' ? 'delete' : blockMatch[2]
      });
      return;
    }

    const genderMatch = requestUrl.pathname.match(/^\/api\/admin\/contact-gender\/(\d+)$/);
    if (req.method === 'POST' && genderMatch) {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Contact changes can only be made from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const gender = contactGenders.set(genderMatch[1], body.gender);
        scheduleChange(path.basename(contactGenderFile));
        sendJson(res, 200, { number: genderMatch[1], gender, source: gender ? 'manual' : 'inferred' });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not update contact gender:', error.message);
        sendJson(res, 400, { error: error.message });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/broadcast-media') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Media can only be uploaded from this local dashboard.' });
        return;
      }
      const contentLength = Number(req.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > MAX_BROADCAST_MEDIA_BYTES) {
        sendJson(res, 413, {
          error: `Attachment exceeds the ${Math.round(MAX_BROADCAST_MEDIA_BYTES / (1024 * 1024))} MB size limit.`
        });
        return;
      }
      let fileName;
      try {
        fileName = decodeURIComponent(req.headers['x-file-name'] || '');
      } catch {
        sendJson(res, 400, { error: 'Attachment file name is invalid.' });
        return;
      }
      readBinaryRequestBody(req, MAX_BROADCAST_MEDIA_BYTES).then(buffer => {
        const attachment = saveBroadcastMedia(buffer, {
          fileName,
          mimeType: req.headers['content-type'],
          voiceNote: req.headers['x-voice-note'] === 'true'
        }, broadcastMediaDirectory);
        sendJson(res, 201, attachment);
      }).catch(error => {
        const status = /exceeds the \d+ MB size limit/.test(error.message) ? 413 : 400;
        console.error('[Admin Dashboard] Could not store bulk-message attachment:', error.message);
        sendJson(res, status, { error: error.message });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/curriculum/video') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Media can only be uploaded from this local dashboard.' });
        return;
      }
      const contentLength = Number(req.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > MAX_LESSON_VIDEO_BYTES) {
        sendJson(res, 413, { error: `Video exceeds the ${Math.round(MAX_LESSON_VIDEO_BYTES / (1024 * 1024))} MB size limit.` });
        return;
      }
      let gradeKey;
      let fileName;
      let collectionId;
      try {
        gradeKey = decodeURIComponent(req.headers['x-grade-key'] || '').trim();
        fileName = decodeURIComponent(req.headers['x-file-name'] || '').trim();
        collectionId = decodeURIComponent(req.headers['x-collection-id'] || '').trim() || null;
      } catch {
        sendJson(res, 400, { error: 'Invalid video upload headers.' });
        return;
      }
      if (!gradeKey) {
        sendJson(res, 400, { error: 'Grade key is required.' });
        return;
      }
      readBinaryRequestBody(req, MAX_LESSON_VIDEO_BYTES).then(buffer => {
        const result = saveLessonVideo({
          gradeKey,
          collectionId,
          fileName,
          buffer,
          mediaDir: lessonMediaDirectory
        });
        scheduleChange(path.basename(lessonsFile));
        sendJson(res, 201, result);
      }).catch(error => {
        const status = /exceeds the limit/i.test(error.message) ? 413 : 400;
        console.error('[Admin Dashboard] Could not upload lesson video:', error.message);
        sendJson(res, status, { error: error.message });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/curriculum/lesson') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Curriculum updates must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const result = saveLesson({
          gradeKey: body.gradeKey,
          lesson: body.lesson,
          isStandalone: body.isStandalone === true,
          collectionId: typeof body.collectionId === 'string' ? body.collectionId : null,
          filePath: lessonsFile
        });
        scheduleChange(path.basename(lessonsFile));
        sendJson(res, 200, result);
      }).catch(error => {
        console.error('[Admin Dashboard] Could not save lesson:', error.message);
        sendJson(res, 400, { error: error.message });
      });
      return;
    }

    if (req.method === 'DELETE' && requestUrl.pathname === '/api/admin/curriculum/lesson') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Curriculum updates must come from this local dashboard.' });
        return;
      }
      const gradeKey = requestUrl.searchParams.get('gradeKey');
      const lessonId = requestUrl.searchParams.get('lessonId');
      const isStandalone = requestUrl.searchParams.get('isStandalone') === 'true';
      const collectionId = requestUrl.searchParams.get('collectionId');
      try {
        const result = deleteLesson({
          gradeKey,
          lessonId,
          isStandalone,
          collectionId,
          filePath: lessonsFile
        });
        scheduleChange(path.basename(lessonsFile));
        sendJson(res, 200, result);
      } catch (error) {
        console.error('[Admin Dashboard] Could not delete lesson:', error.message);
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/curriculum/reorder') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Curriculum updates must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const result = reorderLessons({
          gradeKey: body.gradeKey,
          lessonIds: body.lessonIds,
          filePath: lessonsFile
        });
        scheduleChange(path.basename(lessonsFile));
        sendJson(res, 200, result);
      }).catch(error => {
        console.error('[Admin Dashboard] Could not reorder lessons:', error.message);
        sendJson(res, 400, { error: error.message });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/curriculum/grade') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Curriculum updates must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const result = saveGradeMetadata({
          gradeKey: body.gradeKey,
          name: body.name,
          keywords: body.keywords,
          filePath: lessonsFile
        });
        scheduleChange(path.basename(lessonsFile));
        sendJson(res, 200, result);
      }).catch(error => {
        console.error('[Admin Dashboard] Could not update grade metadata:', error.message);
        sendJson(res, 400, { error: error.message });
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/blocked-contacts') {
      try {
        sendJson(res, 200, { blockedNumbers: blockedContactsWithNames() });
      } catch (error) {
        console.error('[Admin Dashboard] Could not read blocked contacts:', error.message);
        sendJson(res, 500, { error: 'Could not read blocked contacts.' });
      }
      return;
    }

    const paymentLabelMatch = requestUrl.pathname.match(/^\/api\/admin\/contact-payment-label\/(\d{5,15})$/);
    if (req.method === 'POST' && paymentLabelMatch) {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Contact labels can only be changed from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const phoneNumber = paymentLabelMatch[1];
        const contacts = readContactsFile();
        const matchingContact = Object.entries(contacts).find(([jid, contact]) => {
          const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
          return phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0] === phoneNumber;
        });
        if (!matchingContact) {
          sendJson(res, 404, { error: 'Contact was not found in the local WhatsApp contacts.' });
          return;
        }
        const [jid, contact] = matchingContact;
        const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
        const label = paymentLabels.setManualStatus(phoneNumber, phoneJid || jid, body.status);
        sendJson(res, 200, { phoneNumber, label });
      }).catch(error => {
        sendJson(res, 400, { error: error.message });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/contact-sync') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Contact sync can only be requested from this local dashboard.' });
        return;
      }
      try {
        const status = readJsonFileOr(agentStatusFile, null);
        if (getDashboardAgentStatus(status, 0, Date.now()).connectionState !== 'connected') {
          sendJson(res, 503, { error: 'The WhatsApp agent must be connected to update contacts.' });
          return;
        }
        sendJson(res, 202, contactSync.queueRequest());
      } catch (error) {
        console.error('[Admin Dashboard] Could not request WhatsApp contact sync:', error.message);
        sendJson(res, 500, { error: 'Could not request contact update.' });
      }
      return;
    }

    const contactSyncMatch = requestUrl.pathname.match(/^\/api\/admin\/contact-sync\/([a-f0-9-]+)$/i);
    if (req.method === 'GET' && contactSyncMatch) {
      try {
        const status = contactSync.getStatus(contactSyncMatch[1]);
        if (!status) {
          sendJson(res, 404, { error: 'Contact update request not found.' });
          return;
        }
        sendJson(res, 200, status);
      } catch (error) {
        console.error('[Admin Dashboard] Could not read WhatsApp contact sync status:', error.message);
        sendJson(res, 500, { error: 'Could not read contact update status.' });
      }
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/broadcasts') {
      handleBroadcastPost(
        req,
        res,
        readDataWithBlockedContacts,
        broadcastFiles,
        broadcastMediaDirectory
      );
      return;
    }

    if (['GET', 'POST'].includes(req.method) &&
        requestUrl.pathname === '/api/admin/curriculum/lesson-broadcast') {
      if (req.method === 'POST' && !isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Lesson video broadcasts must come from this local dashboard.' });
        return;
      }
      const getOptions = () => ({
        gradeKey: requestUrl.searchParams.get('gradeKey'),
        lessonId: requestUrl.searchParams.get('lessonId'),
        isStandalone: requestUrl.searchParams.get('isStandalone') === 'true'
      });
      const sendPreview = () => {
        const { gradeKey, lessonId, isStandalone } = getOptions();
        if (!gradeKey || !lessonId) {
          sendJson(res, 400, { error: 'A grade and lesson are required.' });
          return;
        }
        const lessonVideo = getLessonForBroadcast(gradeKey, lessonId, isStandalone);
        const now = Date.now();
        const recipients = getInactiveLessonRecipients(now);
        pruneLessonBroadcastPreviews(now);
        const previewId = randomUUID();
        lessonBroadcastPreviews.set(previewId, {
          gradeKey,
          lessonId,
          isStandalone,
          lessonVideo,
          jids: recipients.map(contact => contact.jid),
          expiresAt: now + 5 * 60 * 1000
        });
        sendJson(res, 200, {
          previewId,
          title: lessonVideo.title,
          total: recipients.length,
          inactiveDays: 10,
          cutoff: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
          filter: 'Eligible eShool contacts with recorded WhatsApp activity more than 10 days ago'
        });
      };
      if (req.method === 'GET') {
        try {
          sendPreview();
        } catch (error) {
          console.error('[Admin Dashboard] Could not preview lesson video recipients:', error.message);
          sendJson(res, 400, { error: error.message });
        }
        return;
      }
      readRequestBody(req).then(body => {
        if (typeof body.previewId !== 'string') {
          sendJson(res, 400, { error: 'A current lesson video recipient preview is required.' });
          return;
        }
        pruneLessonBroadcastPreviews(Date.now());
        const preview = lessonBroadcastPreviews.get(body.previewId);
        if (!preview) {
          sendJson(res, 409, { error: 'This recipient preview expired. Preview the lesson again before queuing it.' });
          return;
        }
        const lessonVideo = getLessonForBroadcast(
          preview.gradeKey,
          preview.lessonId,
          preview.isStandalone
        );
        const now = Date.now();
        const recipients = getInactiveLessonRecipients(now);
        const currentJids = recipients.map(contact => contact.jid);
        if (JSON.stringify(currentJids) !== JSON.stringify(preview.jids) ||
            JSON.stringify(lessonVideo) !== JSON.stringify(preview.lessonVideo)) {
          sendJson(res, 409, {
            error: 'The eligible students or lesson video changed after preview. Preview again and confirm the updated recipient count.'
          });
          return;
        }
        if (recipients.length === 0) {
          sendJson(res, 409, {
            error: 'No eligible eShool contacts have recorded WhatsApp activity older than 10 days. Contacts with no saved activity are excluded.'
          });
          return;
        }
        const requests = readJsonFileOr(broadcastFiles.requests, []);
        if (!Array.isArray(requests)) throw new Error('Invalid broadcast request queue.');
        const id = `${now}-${Math.random().toString(36).slice(2, 10)}`;
        const createdAt = new Date(now).toISOString();
        const job = {
          id,
          text: '',
          attachments: [],
          jids: preview.jids,
          recipientType: 'es',
          inactiveDays: 10,
          inactiveBefore: now - 10 * 24 * 60 * 60 * 1000,
          lessonVideo,
          createdAt,
          cancelled: false
        };
        requests.push(job);
        lessonBroadcastPreviews.delete(body.previewId);
        fs.mkdirSync(path.dirname(broadcastFiles.requests), { recursive: true });
        writeJsonFile(broadcastFiles.requests, requests);
        scheduleChange(path.basename(broadcastFiles.requests));
        sendJson(res, 202, {
          id,
          status: 'queued',
          total: job.jids.length,
          createdAt
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not queue lesson video broadcast:', error.message);
        sendJson(res, 400, { error: error.message });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/messages') {
      handleDirectMessagePost(req, res, readDataWithBlockedContacts, messageRequestsFile);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/messages') {
      try {
        const jid = requestUrl.searchParams.get('jid');
        const requests = readJsonFileOr(messageRequestsFile, []);
        const state = readJsonFileOr(broadcastFiles.state, { jobs: {} });
        const messages = requests.filter(request => request.jid === jid).slice(-10).reverse()
          .map(request => ({
            id: request.id,
            status: state.jobs?.[request.id]?.status || 'queued',
            createdAt: request.createdAt
          }));
        sendJson(res, 200, { messages });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load direct message status:', error.message);
        sendJson(res, 500, { error: 'Could not read direct message status.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/scheduled-lessons') {
      try {
        sendJson(res, 200, { schedules: scheduledLessons.list().slice(-100).reverse() });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load scheduled lessons:', error.message);
        sendJson(res, 500, { error: 'Could not read scheduled lessons.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/scheduled-lessons/options') {
      try {
        sendJson(res, 200, getManualScheduleOptions());
      } catch (error) {
        console.error('[Admin Dashboard] Could not load manual lesson scheduling options:', error.message);
        sendJson(res, 500, { error: 'Could not load students and configured lessons for scheduling.' });
      }
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/scheduled-lessons/manual') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Scheduled lesson controls are only accepted from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (typeof body?.jid !== 'string' || typeof body?.gradeKey !== 'string' ||
            typeof body?.lessonId !== 'string' || typeof body?.scheduledAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.scheduledAt)) {
          sendJson(res, 400, { error: 'Choose a student, a configured lesson, and a valid future date and time.' });
          return;
        }
        const { students, lessons } = getManualScheduleOptions();
        const student = students.find(item => item.jid === body.jid);
        if (!student) {
          sendJson(res, 404, { error: 'Student not found in the local WhatsApp contacts or progress records.' });
          return;
        }
        const lesson = lessons.find(item =>
          item.gradeKey === body.gradeKey && item.lessonId === body.lessonId);
        if (!lesson) {
          sendJson(res, 409, { error: 'That lesson is no longer available with its video and exercise.' });
          return;
        }
        const gradeConfig = readJsonFile(lessonsFile)[body.gradeKey];
        const gradeLessons = Array.isArray(gradeConfig?.lessons) ? gradeConfig.lessons : [];
        const lessonIndex = gradeLessons.findIndex(item => item.id === body.lessonId);
        if (lessonIndex < 0) {
          sendJson(res, 409, { error: 'That lesson is no longer available with its video and exercise.' });
          return;
        }
        const schedule = scheduledLessons.create({
          jid: student.jid,
          phoneJid: student.phoneJid,
          studentName: student.name,
          gradeKey: body.gradeKey,
          lessonIndex,
          lessonId: body.lessonId,
          lessonTitle: lesson.title,
          scheduledAt: body.scheduledAt
        });
        scheduleChange(path.basename(scheduledLessonsFile));
        sendJson(res, 201, { schedule });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not create manual lesson schedule:', error.message);
        const status = /future/.test(error.message) ? 409 : 400;
        sendJson(res, status, { error: error.message });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/scheduled-lessons') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Scheduled lesson controls are only accepted from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (!body || typeof body.id !== 'string' || !body.id) {
          sendJson(res, 400, { error: 'A scheduled lesson ID is required.' });
          return;
        }
        let schedule;
        if (body.action === 'cancel') {
          schedule = scheduledLessons.cancel(body.id);
        } else if (body.action === 'send_now') {
          schedule = scheduledLessons.update(body.id, current => ({
            ...current,
            scheduledAt: new Date(Date.now() + 1000).toISOString()
          }));
        } else if (body.action === 'reschedule' && typeof body.scheduledAt === 'string') {
          schedule = scheduledLessons.update(body.id, current => ({
            ...current,
            scheduledAt: body.scheduledAt
          }));
        } else {
          sendJson(res, 400, { error: 'Choose cancel, send_now, or provide a future time to reschedule.' });
          return;
        }
        if (!schedule) {
          sendJson(res, 404, { error: 'Scheduled lesson not found.' });
          return;
        }
        scheduleChange(path.basename(scheduledLessonsFile));
        sendJson(res, 200, { schedule });
      }).catch(error => {
        const status = /Only scheduled lessons|must be in the future/.test(error.message) ? 409 : 400;
        sendJson(res, status, { error: error.message });
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/broadcasts') {
      try {
        const requests = readJsonFileOr(broadcastFiles.requests, []);
        const state = readJsonFileOr(broadcastFiles.state, { jobs: {} });
        const jobs = requests.slice(-20).reverse().map(request => {
          const jobState = state.jobs?.[request.id] || {
            status: request.cancelled ? 'cancelled' : 'queued',
            total: request.jids.length,
            sent: 0,
            skipped: 0,
            uncertain: 0
          };
          return {
            id: request.id,
            status: request.cancelled && jobState.status === 'running'
              ? 'cancellation_requested'
              : jobState.status,
            total: jobState.total,
            sent: jobState.sent,
            skipped: jobState.skipped,
            uncertain: jobState.uncertain,
            createdAt: request.createdAt,
            completedAt: jobState.completedAt || null
          };
        });
        sendJson(res, 200, { jobs });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load broadcast status:', error.message);
        sendJson(res, 500, { error: 'Could not read broadcast status.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/agent-status') {
      try {
        const data = readDataWithBlockedContacts();
        const status = readJsonFileOr(agentStatusFile, null);
        const handledChats = memoizeDashboardQuery(data, 'handled-chat-count', () =>
          Object.entries(data.history)
            .filter(([jid, messages]) =>
              isDirectChat(jid) && messages.some(message => message.role === 'agent'))
            .length);
        sendJson(res, 200, getDashboardAgentStatus(status, handledChats));
      } catch (error) {
        console.error('[Admin Dashboard] Could not load WhatsApp agent status:', error.message);
        sendJson(res, 500, { error: 'Could not read WhatsApp agent status.' });
      }
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/agent-disconnect') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Agent controls must come from this local dashboard.' });
        return;
      }
      try {
        const status = readJsonFileOr(agentStatusFile, null);
        const heartbeatAt = Date.parse(status?.updatedAt || '');
        if (!status || !['connected', 'connecting'].includes(status.connectionState) ||
            !Number.isFinite(heartbeatAt) ||
            Date.now() - heartbeatAt > AGENT_HEARTBEAT_MAX_AGE_MS) {
          sendJson(res, 409, { error: 'The WhatsApp agent is not currently connected.' });
          return;
        }
        const request = requestAgentDisconnect(agentControlFile);
        sendJson(res, 202, { status: 'disconnecting', requestedAt: request.requestedAt });
      } catch (error) {
        console.error('[Admin Dashboard] Could not request WhatsApp agent disconnect:', error.message);
        sendJson(res, 500, { error: 'Could not request WhatsApp agent disconnect.' });
      }
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/agent-replies') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Agent controls must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'The enabled value must be true or false.' });
          return;
        }
        const status = readJsonFileOr(agentStatusFile, null);
        const heartbeatAt = Date.parse(status?.updatedAt || '');
        if (!status || status.connectionState !== 'connected' ||
            !Number.isFinite(heartbeatAt) ||
            Date.now() - heartbeatAt > AGENT_HEARTBEAT_MAX_AGE_MS) {
          sendJson(res, 409, { error: 'The WhatsApp agent must be connected to change its reply mode.' });
          return;
        }
        const request = requestAgentResponseMode(body.enabled, agentControlFile);
        sendJson(res, 202, {
          status: body.enabled ? 'resuming_replies' : 'pausing_replies',
          requestedAt: request.requestedAt
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not change WhatsApp agent reply mode:', error.message);
        sendJson(res, 500, { error: 'Could not change WhatsApp agent reply mode.' });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/chat-queue-control') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Chat queue controls must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (typeof body.paused !== 'boolean') {
          sendJson(res, 400, { error: 'Queue pause state must be true or false.' });
          return;
        }
        const status = readJsonFile(agentStatusFile);
        if (status.connectionState !== 'connected') {
          sendJson(res, 409, { error: 'Connect the WhatsApp agent before changing chat handling.' });
          return;
        }
        const request = requestAgentQueueMode(body.paused, agentControlFile);
        sendJson(res, 202, {
          status: body.paused ? 'pausing_queue' : 'resuming_queue',
          requestedAt: request.requestedAt
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not change chat queue handling:', error.message);
        sendJson(res, 500, { error: 'Could not change chat queue handling.' });
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/agent-logs') {
      try {
        const limitValue = requestUrl.searchParams.get('limit') || '250';
        if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 500) {
          sendJson(res, 400, { error: 'Log line limit must be between 1 and 500.' });
          return;
        }
        sendJson(res, 200, readRecentAgentLogs(agentLogFile, Number(limitValue)));
      } catch (error) {
        console.error('[Admin Dashboard] Could not load WhatsApp agent logs:', error.message);
        sendJson(res, 500, { error: 'Could not read WhatsApp agent logs.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/agent-media') {
      try {
        const contacts = readContactsFile();
        const lessonsConfig = readJsonFile(lessonsFile);
        const contactsByPhone = new Map();
        for (const [jid, contact] of Object.entries(contacts || {})) {
          const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
          if (phoneJid && !contactsByPhone.has(phoneJid)) {
            contactsByPhone.set(phoneJid, contact);
          }
        }
        const activities = readAgentMediaActivities(agentMediaActivityFile).map(activity => {
          const contact = contacts?.[activity.recipientJid] ||
            contactsByPhone.get(getPhoneJid(
              activity.recipientJid,
              contacts?.[activity.recipientJid]?.phoneJid,
              contacts?.[activity.recipientJid]?.jid
            ));
          return {
            ...activity,
            retryAvailable: Boolean(findLessonForMediaActivity(activity, lessonsConfig)),
            studentName: displayName(contact, activity.recipientJid)
          };
        });
        sendJson(res, 200, {
          activities
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load WhatsApp media activity:', error.message);
        sendJson(res, 500, { error: 'Could not read WhatsApp media activity.' });
      }
      return;
    }

    const retryMediaMatch = /^\/api\/admin\/agent-media\/([\w-]+)\/retry$/.exec(requestUrl.pathname);
    if (req.method === 'POST' && retryMediaMatch) {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Media retry requests must come from this local dashboard.' });
        return;
      }
      try {
        const status = readJsonFile(agentStatusFile);
        if (status.connectionState !== 'connected') {
          sendJson(res, 409, { error: 'Connect the WhatsApp agent before retrying this video.' });
          return;
        }
        const activityId = retryMediaMatch[1];
        const activity = readAgentMediaActivities(agentMediaActivityFile)
          .find(item => item.id === activityId);
        if (!activity || activity.status !== 'failed') {
          sendJson(res, 409, { error: 'Only failed video uploads can be retried.' });
          return;
        }
        if (!findLessonForMediaActivity(activity, readJsonFile(lessonsFile))) {
          sendJson(res, 409, { error: 'The lesson video source could not be identified for retry.' });
          return;
        }
        enqueueAgentMediaRetry(activityId, agentMediaRetryRequestsFile);
        writeAgentMediaActivity({
          ...activity,
          status: 'retrying',
          retryError: undefined,
          updatedAt: new Date().toISOString()
        }, agentMediaActivityFile);
        sendJson(res, 202, { status: 'retrying', activityId });
      } catch (error) {
        console.error('[Admin Dashboard] Could not queue failed video retry:', error.message);
        sendJson(res, 500, { error: 'Could not queue the video retry.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/payment-calendar') {
      try {
        const contacts = readContactsFile();
        const contactsByPhone = new Map();
        for (const [jid, contact] of Object.entries(contacts || {})) {
          const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid);
          if (phoneJid && !contactsByPhone.has(phoneJid)) {
            contactsByPhone.set(phoneJid, contact);
          }
        }
        const payments = Object.entries(paymentLabels.list())
          .flatMap(([phoneNumber, record]) => (record.paymentHistory || []).map(payment => {
            const phoneJid = getPhoneJid(
              payment.jid,
              contacts?.[payment.jid]?.phoneJid,
              contacts?.[payment.jid]?.jid
            ) || `${phoneNumber}@s.whatsapp.net`;
            const contact = contacts?.[payment.jid] || contactsByPhone.get(phoneJid);
            return {
              phoneNumber,
              jid: payment.jid,
              studentName: displayName(contact, phoneJid),
              paidAt: payment.paidAt
            };
          }))
          .sort((left, right) => Date.parse(right.paidAt) - Date.parse(left.paidAt));
        sendJson(res, 200, { payments });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load payment history:', error.message);
        sendJson(res, 500, { error: 'Could not read student payment history.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/agent-qr') {
      try {
        const qr = readAgentQr(agentQrFile);
        sendJson(res, 200, {
          qrSvg: qr ? renderAgentQrSvg(qr.value) : null,
          updatedAt: qr?.updatedAt || null
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load WhatsApp pairing QR:', error.message);
        sendJson(res, 500, { error: 'Could not read WhatsApp pairing QR.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/student-workbook') {
      if (!studentWorkbook) {
        sendJson(res, 503, { error: 'Student workbook generation is not enabled.' });
        return;
      }
      studentWorkbook.getStatus().then(status => sendJson(res, 200, status)).catch(error => {
        console.error('[Admin Dashboard] Could not get student workbook status:', error.message);
        sendJson(res, 500, { error: 'Could not get student workbook status.' });
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/student-workbook.xlsx') {
      if (!studentWorkbook) {
        sendJson(res, 503, { error: 'Student workbook generation is not enabled.' });
        return;
      }
      studentWorkbook.getStatus().then(status => {
        if (status.state !== 'ready') {
          sendJson(res, 503, { error: status.error || 'Student workbook is not ready yet.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="students.xlsx"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        const workbookStream = fs.createReadStream(studentWorkbookFile);
        workbookStream.on('error', error => {
          console.error('[Admin Dashboard] Could not stream student workbook:', error.message);
          if (!res.headersSent) sendJson(res, 500, { error: 'Could not read the student workbook.' });
          else res.destroy(error);
        });
        workbookStream.pipe(res);
      }).catch(error => {
        console.error('[Admin Dashboard] Could not prepare student workbook download:', error.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'Could not prepare student workbook download.' });
      });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    try {
      const data = readDataWithBlockedContacts();
      if (requestUrl.pathname === '/api/admin/overview') {
        const timeZone = requestUrl.searchParams.get('timeZone') || 'UTC';
        try {
          const now = Date.now();
          const overview = memoizeDashboardQuery(
            data,
            `overview:${timeZone}:${Math.floor(now / 60_000)}`,
            () => getDashboardOverview(data, now, timeZone)
          );
          sendJson(res, 200, overview);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
        return;
      }

      if (requestUrl.pathname === '/api/admin/chats') {
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || String(DEFAULT_PAGE_SIZE), 10);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) {
          sendJson(res, 400, { error: 'Invalid pagination parameters' });
          return;
        }
        const activityFilter = requestUrl.searchParams.get('active');
        if (activityFilter && activityFilter !== '24h') {
          sendJson(res, 400, { error: 'Invalid activity filter' });
          return;
        }
        const handledFilter = requestUrl.searchParams.get('handled');
        if (handledFilter && handledFilter !== '1') {
          sendJson(res, 400, { error: 'Invalid handled-chat filter' });
          return;
        }
        const sort = requestUrl.searchParams.get('sort') || 'date-desc';
        if (!['date-desc', 'date-asc', 'unread-first', 'read-first'].includes(sort)) {
          sendJson(res, 400, { error: 'Invalid chat sort option' });
          return;
        }
        const readFilter = requestUrl.searchParams.get('read') || 'all';
        if (!['all', 'read', 'unread'].includes(readFilter)) {
          sendJson(res, 400, { error: 'Invalid chat read filter' });
          return;
        }
        if (activityFilter && handledFilter) {
          sendJson(res, 400, { error: 'Chat filters cannot be combined' });
          return;
        }
        const readState = chatReadState.ensureInitialized(data.history);
        const search = requestUrl.searchParams.get('q') || '';
        const chatCacheKey = JSON.stringify([
          'chats', search, offset, limit, activityFilter, handledFilter, sort, readFilter,
          JSON.stringify(readState),
          activityFilter === '24h' ? Math.floor(Date.now() / 60_000) : null
        ]);
        const result = memoizeDashboardQuery(data, chatCacheKey, () =>
          listDashboardChats(data, search, offset, limit, {
            ...(activityFilter === '24h' ? { activeSince: Date.now() - 24 * 60 * 60 * 1000 } : {}),
            handledOnly: handledFilter === '1',
            readState,
            sort,
            readFilter
          }));
        sendJson(res, 200, {
          ...result,
          chats: result.chats.map(chat => ({
            ...chat,
            paid: paymentLabelForContact(data, chat.jid),
            presence: presenceForChat(data, whatsappPresence, chat.jid)
          }))
        });
        return;
      }

      if (requestUrl.pathname === '/api/admin/es-contacts') {
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || String(DEFAULT_CONTACT_PAGE_SIZE), 10);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) {
          sendJson(res, 400, { error: 'Invalid pagination parameters' });
          return;
        }
        try {
          const search = requestUrl.searchParams.get('q') || '';
          const readState = chatReadState.ensureInitialized(data.history);
          const sort = requestUrl.searchParams.get('sort') || 'date-desc';
          const readFilter = requestUrl.searchParams.get('read') || 'all';
          const result = memoizeDashboardQuery(data, JSON.stringify([
            'es-contacts', search, offset, limit, JSON.stringify(readState), sort, readFilter
          ]), () => listDashboardEsContacts(
            data,
            search,
            offset,
            limit,
            getClientMessagesByPhone(data),
            { readState, sort, readFilter }
          ));
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
        return;
      }

      if (requestUrl.pathname === '/api/admin/broadcast-recipients') {
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || String(DEFAULT_CONTACT_PAGE_SIZE), 10);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) {
          sendJson(res, 400, { error: 'Invalid pagination parameters' });
          return;
        }
        let result;
        try {
          const search = requestUrl.searchParams.get('q') || '';
          const options = {
            date: requestUrl.searchParams.get('date') || '',
            timeZone: requestUrl.searchParams.get('timeZone') || 'UTC',
            recipientType: requestUrl.searchParams.get('recipientType') || 'es',
            sort: requestUrl.searchParams.get('sort') || 'date-desc',
            readFilter: requestUrl.searchParams.get('read') || 'all',
            readState: chatReadState.ensureInitialized(data.history)
          };
          result = memoizeDashboardQuery(data, JSON.stringify([
            'broadcast-recipients', search, offset, limit,
            options.date, options.timeZone, options.recipientType, options.sort,
            options.readFilter, JSON.stringify(options.readState)
          ]), () => listEligibleBroadcastContacts(
            data, data.optedOutJids || [], search, offset, limit, options
          ));
        } catch (error) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        const messagesByPhone = getClientMessagesByPhone(data);
        sendJson(res, 200, {
          ...result,
          contacts: result.contacts.map(contact => ({
            ...contact,
            paid: data.paymentLabels?.[contact.phoneNumber]?.label === 'paid'
              ? data.paymentLabels[contact.phoneNumber]
              : null,
            gender: contactGender(
              data,
              contact.phoneNumber,
              messagesByPhone.get(contact.jid) || []
            )
          }))
        });
        return;
      }

      if (requestUrl.pathname === '/api/admin/conversation') {
        const jid = requestUrl.searchParams.get('jid');
        const conversation = memoizeDashboardQuery(data, `conversation:${jid}`, () =>
          getDashboardConversation(data, jid));
        if (!conversation) {
          sendJson(res, 404, { error: 'Chat not found' });
          return;
        }
        sendJson(res, 200, {
          ...conversation,
          paid: paymentLabelForContact(data, conversation.jid),
          presence: presenceForChat(data, whatsappPresence, conversation.jid)
        });
        return;
      }

      if (requestUrl.pathname === '/api/admin/agent-conversation') {
        const limitValue = requestUrl.searchParams.get('limit') || '100';
        if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 200) {
          sendJson(res, 400, { error: 'Message limit must be between 1 and 200.' });
          return;
        }
        const limit = Number(limitValue);
        sendJson(res, 200, {
          messages: memoizeDashboardQuery(data, `agent-conversation:${limit}`, () =>
            listRecentAgentMessages(data, limit))
        });
        return;
      }

      if (requestUrl.pathname === '/api/admin/student-activity') {
        const daysValue = requestUrl.searchParams.get('days') || '30';
        if (!/^(30|90)$/.test(daysValue)) {
          sendJson(res, 400, { error: 'Activity range must be 30 or 90 days.' });
          return;
        }
        const timeZone = requestUrl.searchParams.get('timeZone');
        try {
          new Intl.DateTimeFormat('en-US', { timeZone });
        } catch {
          sendJson(res, 400, { error: 'The requested timezone is invalid.' });
          return;
        }
        const activity = getDashboardStudentActivity(
          data,
          requestUrl.searchParams.get('jid'),
          Number(daysValue),
          timeZone
        );
        if (!activity) {
          sendJson(res, 404, { error: 'Chat not found.' });
          return;
        }
        activity.presence = whatsappPresence.getMetrics(
          relatedPresenceJids(data, activity.jid),
          Number(daysValue)
        );
        sendJson(res, 200, activity);
        return;
      }

      if (requestUrl.pathname === '/api/admin/progress') {
        const timeZone = requestUrl.searchParams.get('timeZone') || 'UTC';
        try {
          const now = Date.now();
          const progress = memoizeDashboardQuery(
            data,
            `progress:${timeZone}:${Math.floor(now / 60_000)}`,
            () => listDashboardStudentProgress(data, now, timeZone)
          );
          sendJson(res, 200, progress);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
        return;
      }

      if (requestUrl.pathname === '/api/admin/curriculum') {
        try {
          const overview = listCurriculumOverview(data.lessons, {
            filePath: lessonsFile,
            mediaDir: lessonMediaDirectory
          });
          sendJson(res, 200, overview);
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
        return;
      }

      if (requestUrl.pathname === '/api/admin/curriculum/grade') {
        const gradeKey = requestUrl.searchParams.get('key');
        if (!gradeKey) {
          sendJson(res, 400, { error: 'Grade key is required.' });
          return;
        }
        const gradeCurriculum = getGradeCurriculum(gradeKey, data.lessons, {
          filePath: lessonsFile,
          mediaDir: lessonMediaDirectory,
          appDir: ROOT_DIR
        });
        if (!gradeCurriculum) {
          sendJson(res, 404, { error: 'Grade not found.' });
          return;
        }
        sendJson(res, 200, gradeCurriculum);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[Admin Dashboard] Could not load local data:', error.message);
      sendJson(res, 500, { error: 'Could not read dashboard data. Check the local data files.' });
    }
  });
  const keepAlive = setInterval(() => {
    for (const response of eventClients) response.write(': keep-alive\n\n');
  }, 15_000);
  keepAlive.unref();
  server.on('close', () => {
    clearInterval(keepAlive);
    if (changeTimer) clearTimeout(changeTimer);
    if (workbookRefreshTimer) clearTimeout(workbookRefreshTimer);
    for (const watcher of watchers) watcher.close();
    for (const response of eventClients) response.end();
    eventClients.clear();
  });
  if (studentWorkbook) {
    server.on('listening', () => {
      studentWorkbook.refresh();
    });
  }
  return server;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const port = Number.parseInt(process.env.ADMIN_PORT || '3001', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ADMIN_PORT must be a valid TCP port.');
  }

  const server = createAdminDashboardServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`[Admin Dashboard] Running locally at http://127.0.0.1:${port}`);
  });
}
