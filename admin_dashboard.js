import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardAuth } from './dashboard_auth.js';
import { generateLessonAnswerKey } from './answer_key_generator.js';
import { getPhoneJid } from './phonebook.js';
import { getConversationJids, getConversationMessages } from './conversation_history.js';
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
  getTelegramStudentGender,
  personalizeTelegramMessage
} from './telegram_student_gender.js';
import {
  createTelegramStudentGenderStore,
  TELEGRAM_STUDENT_GENDER_FILE
} from './telegram_student_gender_store.js';
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
  TELEGRAM_AGENT_MEDIA_ACTIVITY_FILE,
  readAgentMediaActivities,
  writeAgentMediaActivity
} from './agent_media_activity.js';
import {
  AGENT_MEDIA_RETRY_REQUESTS_FILE,
  TELEGRAM_AGENT_MEDIA_RETRY_REQUESTS_FILE,
  enqueueAgentMediaRetry
} from './agent_media_retry.js';
import {
  readTelegramUpdateQueue,
  setTelegramUpdateQueuePaused,
  TELEGRAM_AGENT_CONTROL_FILE,
  TELEGRAM_UPDATE_QUEUE_FILE
} from './telegram_update_queue.js';
import { isTelegramAnnouncementRecipient } from './telegram_announcement_recipients.js';
import {
  getTelegramBlockedPrivateChatIds,
  isTelegramBotBlockedError,
  isTelegramPrivateChatBlocked,
  markTelegramPrivateChatBlocked,
  TELEGRAM_BLOCKED_RECIPIENTS_FILE
} from './telegram_blocked_recipients.js';
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
  requestAgentHistorySync,
  requestAgentQueueCancellation,
  requestAgentQueueMode,
  requestAgentResponseMode
} from './agent_status.js';
import {
  AGENT_LOG_FILE,
  TELEGRAM_AGENT_LOG_FILE,
  readRecentAgentLogs
} from './agent_runtime.js';
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
import {
  createOverviewWorkbookManager,
  readTelegramGroupMemberHistory,
  OVERVIEW_WORKBOOK_FILE
} from './overview_workbook.js';
import {
  createGoogleSheetsOverviewManager,
  OVERVIEW_GOOGLE_SHEET_STATE_FILE
} from './google_sheets_overview.js';
import { createScheduledLessonStore, SCHEDULED_LESSONS_FILE } from './scheduled_lessons.js';
import {
  LessonSkipQueue,
  TELEGRAM_LESSON_SKIP_REQUESTS_FILE,
  WHATSAPP_LESSON_SKIP_REQUESTS_FILE
} from './lesson_skip_queue.js';
import {
  createStudentPaymentLedger,
  formatStudentPaymentStatus,
  getLessonPaymentStartAt,
  PAYMENT_STATUSES,
  STUDENT_PAYMENT_LEDGER_FILE
} from './student_payment_ledger.js';
import { STUDENT_PAYMENT_INFORMATION_MESSAGE } from './student_payment_information.js';
import { TELEGRAM_AGENT_STATUS_FILE } from './telegram_agent_status.js';
import {
  PAYMENT_RECEIPT_IMAGE_DIRECTORY,
  readPaymentReceiptImage,
  savePaymentReceiptImage,
  validatePaymentReceiptUpload,
  deletePaymentReceiptImage
} from './payment_receipt_images.js';
import {
  createHistoricalPaymentReceiptStore,
  HISTORICAL_PAYMENT_RECEIPTS_FILE
} from './historical_payment_receipts.js';
import {
  LESSON_MEDIA_DIR,
  MAX_LESSON_VIDEO_BYTES,
  listCurriculumOverview,
  getGradeCurriculum,
  saveLesson,
  deleteLesson,
  reorderLessons,
  saveGradeMetadata,
  saveLessonVideo,
  deleteUnusedLessonVideo
} from './curriculum_manager.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(ROOT_DIR, 'data', 'chat_history.json');
const CONTACTS_FILE = path.join(ROOT_DIR, 'data', 'contacts.json');
const BLOCKED_NUMBERS_FILE = BLOCKED_CONTACTS_FILE;
const CONTACT_GENDER_OVERRIDES_FILE = CONTACT_GENDER_FILE;
const PROGRESS_FILE = path.join(ROOT_DIR, 'data', 'student_progress.json');
const TELEGRAM_PROGRESS_FILE = path.join(ROOT_DIR, 'data', 'telegram_progress.json');
const TELEGRAM_DASHBOARD_CHAT_REPLIES_FILE = path.join(ROOT_DIR, 'data', 'telegram_dashboard_chat_replies.json');
const LESSONS_FILE = path.join(ROOT_DIR, 'lessons.json');
const FOLLOWUP_STATE_FILE = path.join(ROOT_DIR, 'data', 'followup_state.json');
const BROADCAST_REQUESTS_FILE = path.join(ROOT_DIR, 'data', 'broadcast_requests.json');
const BROADCAST_STATE_FILE = path.join(ROOT_DIR, 'data', 'broadcast_state.json');
const TELEGRAM_USER_BROADCAST_REQUESTS_FILE = path.join(ROOT_DIR, 'data', 'telegram_user_broadcasts.json');
const TELEGRAM_USER_BROADCAST_STATE_FILE = path.join(ROOT_DIR, 'data', 'telegram_user_broadcast_state.json');
const MESSAGE_REQUESTS_FILE = path.join(ROOT_DIR, 'data', 'message_requests.json');
const DASHBOARD_DATA_SOURCE_FILES = [
  HISTORY_FILE,
  CONTACTS_FILE,
  PROGRESS_FILE,
  TELEGRAM_PROGRESS_FILE,
  LESSONS_FILE,
  FOLLOWUP_STATE_FILE,
  WHATSAPP_CHAT_ACTIVITY_FILE,
  BLOCKED_NUMBERS_FILE,
  CONTACT_PAYMENT_LABELS_FILE,
  CONTACT_GENDER_OVERRIDES_FILE
];
const AGENT_HEARTBEAT_MAX_AGE_MS = 30_000;
const TELEGRAM_GROUP_ROSTER_MAX_AGE_MS = 120_000;
const TELEGRAM_PRESENCE_MAX_AGE_MS = 120_000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 120;
const MAX_CONVERSATION_MESSAGES = 100;
const DEFAULT_CONTACT_PAGE_SIZE = 50;
const MAX_HISTORICAL_PAYMENT_RECEIPT_BYTES = 10 * 1024 * 1024;
const ACTIVITY_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function calendarDateKey(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs(timestamp))).map(part => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getLessonLeaderboard(progress, now, period = 'weekly', timeZone = 'Africa/Khartoum') {
  if (!['daily', 'weekly'].includes(period)) {
    throw new Error('Leaderboard period must be daily or weekly.');
  }
  const today = calendarDateKey(now, timeZone);
  const todayUtc = new Date(`${today}T00:00:00.000Z`);
  const daysSinceMonday = (todayUtc.getUTCDay() + 6) % 7;
  const weekStartDate = new Date(todayUtc.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const weekStart = weekStartDate.toISOString().slice(0, 10);
  const weekEndDate = new Date(weekStartDate.getTime() + 6 * 24 * 60 * 60 * 1000);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);
  const periodStart = period === 'daily' ? today : weekStart;
  const students = Object.entries(progress || {}).flatMap(([studentKey, student]) => {
    const completionCandidates = [
      ...(Array.isArray(student.lessonCompletionTimestamps)
        ? student.lessonCompletionTimestamps
        : []),
      student.lastLessonCompletionAt,
      student.lastTaskSubmission?.checkedAt,
      ...Object.values(student.telegramLessonTracks || {}).flatMap(track =>
        Array.isArray(track?.lessonCompletionTimestamps)
          ? track.lessonCompletionTimestamps
          : [])
    ].filter(timestamp => typeof timestamp === 'string');
    const completions = [...new Set(completionCandidates.map(timestamp => {
      const parsed = Date.parse(timestamp);
      return Number.isFinite(parsed) && parsed <= now ? new Date(parsed).toISOString() : null;
    }).filter(Boolean))].filter(timestamp => {
      const date = calendarDateKey(Date.parse(timestamp), timeZone);
      return date >= periodStart && date <= today;
    }).length;
    if (!completions) return [];
    const userIdValue = student.telegramUserId ?? studentKey.split(':').at(-1);
    const userId = /^\d+$/.test(String(userIdValue || ''))
      ? Number(userIdValue)
      : null;
    return [{
      name: String(student.name || (student.telegramUsername ? `@${student.telegramUsername}` : 'Student'))
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'Student',
      userId: Number.isSafeInteger(userId) && userId > 0 ? userId : null,
      lessonsCompleted: completions
    }];
  }).sort((left, right) =>
    right.lessonsCompleted - left.lessonsCompleted ||
    left.name.localeCompare(right.name));

  const dateFormatter = new Intl.DateTimeFormat('ar-SD', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  const lines = period === 'daily'
    ? [
        '🏆 لوحة إنجازات اليوم',
        dateFormatter.format(new Date(`${today}T12:00:00.000Z`)),
        '',
        'برافو للطلاب على اجتهادهم وإكمال الحصص اليوم:'
      ]
    : [
        '🏆 لوحة إنجازات الأسبوع',
        `من ${dateFormatter.format(weekStartDate)} إلى ${dateFormatter.format(weekEndDate)}`,
        '',
        'برافو للطلاب على اجتهادهم وإكمال الحصص هذا الأسبوع:'
      ];
  let visibleCount = 0;
  const messageEntities = [];
  for (const [index, student] of students.entries()) {
    const rank = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    const line = `${rank} ${student.name} — ${student.lessonsCompleted} حصة`;
    const omittedCount = students.length - visibleCount - 1;
    const suffix = omittedCount > 0
      ? `\n\nو ${omittedCount} طالب/طلاب آخرين يستحقون التقدير 👏`
      : '';
    if (`${lines.join('\n')}\n${line}${suffix}`.length > 3800) break;
    if (student.userId) {
      messageEntities.push({
        type: 'text_mention',
        offset: lines.join('\n').length + 1 + rank.length + 1,
        length: student.name.length,
        user: { id: student.userId, is_bot: false, first_name: student.name }
      });
    }
    lines.push(line);
    visibleCount += 1;
  }
  if (visibleCount < students.length && visibleCount > 0) {
    lines.push('', `و ${students.length - visibleCount} طالب/طلاب آخرين يستحقون التقدير 👏`);
  }
  lines.push('', 'واصلوا التقدم، خطوة خطوة نحو النجاح 🌟');

  return {
    period,
    date: today,
    weekStart,
    weekEnd,
    students: students.map(({ name, lessonsCompleted }) => ({ name, lessonsCompleted })),
    messageEntities,
    message: students.length ? lines.join('\n') : ''
  };
}

function getRecentCalendarDates(now, days, timeZone) {
  return getCalendarDatesEndingAt(calendarDateKey(now, timeZone), days);
}

function getCalendarDatesEndingAt(endDate, days) {
  const [year, month, day] = endDate.split('-').map(Number);
  const endDateUtc = Date.UTC(year, month - 1, day);
  return Array.from({ length: days }, (_, index) =>
    new Date(endDateUtc - (days - 1 - index) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
  );
}

function isValidCalendarDateKey(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === date;
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

function getTelegramLessonCompletionTotals(progress, now) {
  const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;
  return Object.values(progress || {}).reduce((totals, student) => {
    const completionCounts = student?.lessonCompletionCounts;
    const countedCompletions = completionCounts &&
      typeof completionCounts === 'object' &&
      !Array.isArray(completionCounts)
      ? Object.values(completionCounts).reduce((sum, count) =>
          sum + (Number.isSafeInteger(count) && count > 0 ? count : 0), 0)
      : 0;
    const savedTotal = Number.isSafeInteger(student?.lessonsCompleted) &&
      student.lessonsCompleted > 0
      ? student.lessonsCompleted
      : 0;
    totals.total += Math.max(countedCompletions, savedTotal);
    if (Array.isArray(student?.lessonCompletionTimestamps)) {
      totals.last7Days += student.lessonCompletionTimestamps.filter(timestamp => {
        const completedAt = Date.parse(timestamp);
        return Number.isFinite(completedAt) &&
          completedAt >= recentCutoff &&
          completedAt <= now;
      }).length;
    }
    return totals;
  }, { total: 0, last7Days: 0 });
}

function getTelegramClassStatistics(progress, lessons, groupGrades, now, timeZone, trendEndDate) {
  const classes = new Map();
  for (const [chatId, grade] of groupGrades) {
    const classStats = classes.get(grade) || { grade, groupIds: new Set(), students: new Map() };
    classStats.groupIds.add(chatId);
    classes.set(grade, classStats);
  }
  for (const [studentKey, student] of Object.entries(progress || {})) {
    if (!student || typeof student !== 'object') continue;
    const grade = groupGrades.get(String(student.telegramChatId)) ||
      student.grade ||
      config.defaultStudentGrade;
    const classStats = classes.get(grade) || { grade, groupIds: new Set(), students: new Map() };
    if (student.telegramChatId) classStats.groupIds.add(String(student.telegramChatId));
    const userId = String(student.telegramUserId || studentKey.split(':').at(-1));
    const previous = classStats.students.get(userId);
    const activityAt = Date.parse(
      student.lastTelegramGroupActivityAt || student.lastActivityAt || student.groupJoinedAt || ''
    );
    const previousActivityAt = Date.parse(
      previous?.lastTelegramGroupActivityAt ||
      previous?.lastActivityAt ||
      previous?.groupJoinedAt ||
      ''
    );
    if (!previous || (Number.isFinite(activityAt) &&
        (!Number.isFinite(previousActivityAt) || activityAt > previousActivityAt))) {
      classStats.students.set(userId, student);
    }
    classes.set(grade, classStats);
  }

  const today = calendarDateKey(now, timeZone);
  const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const dates = getCalendarDatesEndingAt(
    trendEndDate || calendarDateKey(now, timeZone),
    30
  );
  return [...classes.values()]
    .map(({ grade, groupIds, students }) => {
      const studentRecords = [...students.values()];
      const joinsByDate = new Map();
      const activeByDate = new Map();
      let joinedToday = 0;
      let joinedLast7Days = 0;
      let activeLearnersLast7Days = 0;
      for (const student of studentRecords) {
        const joinedAt = Date.parse(student.groupJoinedAt || '');
        if (Number.isFinite(joinedAt) && joinedAt <= now) {
          const date = calendarDateKey(joinedAt, timeZone);
          joinsByDate.set(date, (joinsByDate.get(date) || 0) + 1);
          if (date === today) joinedToday += 1;
          if (joinedAt >= weekCutoff) joinedLast7Days += 1;
        }
        const activeDates = new Set(telegramActivityTimestamps(student)
          .filter(timestamp => timestamp <= now)
          .map(timestamp => calendarDateKey(timestamp, timeZone)));
        for (const date of activeDates) {
          activeByDate.set(date, (activeByDate.get(date) || 0) + 1);
        }
        if (telegramActivityTimestamps(student).some(timestamp =>
          timestamp >= weekCutoff && timestamp <= now)) {
          activeLearnersLast7Days += 1;
        }
      }
      const completionTotals = getTelegramLessonCompletionTotals(
        Object.fromEntries(studentRecords.map((student, index) => [String(index), student])),
        now
      );
      return {
        grade,
        name: lessons[grade]?.name || grade,
        groupIds: [...groupIds].sort(),
        students: studentRecords.length,
        joinedToday,
        joinedLast7Days,
        lessonsCompleted: completionTotals.total,
        lessonCompletionsLast7Days: completionTotals.last7Days,
        activeLearnersLast7Days,
        awaitingTask: studentRecords.filter(student => student.status === 'awaiting_task').length,
        awaitingReattempt: studentRecords.filter(student => student.status === 'awaiting_reattempt').length,
        completed: studentRecords.filter(student => student.status === 'completed').length,
        dailyStats: dates.map(date => ({
          date,
          joins: joinsByDate.get(date) || 0,
          activeLearners: activeByDate.get(date) || 0
        }))
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getTelegramUniqueStudentRecords(progress) {
  const students = new Map();
  for (const [studentKey, student] of Object.entries(progress || {})) {
    if (!student || typeof student !== 'object') continue;
    const userId = String(student.telegramUserId || studentKey.split(':').at(-1));
    const previous = students.get(userId);
    const activityAt = Date.parse(
      student.lastTelegramGroupActivityAt || student.lastActivityAt || student.groupJoinedAt || ''
    );
    const previousActivityAt = Date.parse(
      previous?.lastTelegramGroupActivityAt ||
      previous?.lastActivityAt ||
      previous?.groupJoinedAt ||
      ''
    );
    if (!previous || (Number.isFinite(activityAt) &&
        (!Number.isFinite(previousActivityAt) || activityAt > previousActivityAt))) {
      students.set(userId, student);
    }
  }
  return [...students.entries()].map(([userId, student]) => ({ userId, student }));
}

function addLessonCompletionStats(gradeCurriculum, studentsProgress) {
  const countsByLesson = new Map();
  const inProgressByLesson = new Map();
  for (const student of Object.values(studentsProgress)) {
    if (student?.grade !== gradeCurriculum.key) continue;
    if (['awaiting_task', 'awaiting_reattempt'].includes(student.status) &&
        typeof student.currentLessonId === 'string' &&
        student.currentLessonId.trim()) {
      const lessonId = student.currentLessonId.trim();
      inProgressByLesson.set(lessonId, (inProgressByLesson.get(lessonId) || 0) + 1);
    }
    if (!student.lessonCompletionCounts ||
        typeof student.lessonCompletionCounts !== 'object' ||
        Array.isArray(student.lessonCompletionCounts)) continue;
    for (const [lessonId, count] of Object.entries(student.lessonCompletionCounts)) {
      if (!Number.isSafeInteger(count) || count < 1) continue;
      const stats = countsByLesson.get(lessonId) || { completionCount: 0, studentCount: 0 };
      stats.completionCount += count;
      stats.studentCount += 1;
      countsByLesson.set(lessonId, stats);
    }
  }
  const addStats = lesson => ({
    ...lesson,
    ...(countsByLesson.get(lesson.id) || { completionCount: 0, studentCount: 0 }),
    inProgressStudentCount: inProgressByLesson.get(lesson.id) || 0
  });
  return {
    ...gradeCurriculum,
    lessons: gradeCurriculum.lessons.map(addStats),
    standaloneLessons: gradeCurriculum.standaloneLessons.map(addStats),
    collections: gradeCurriculum.collections.map(collection => ({
      ...collection,
      lessons: collection.lessons.map(addStats)
    }))
  };
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
    telegramProgress: readJsonFileOr(TELEGRAM_PROGRESS_FILE, {}),
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

function getReadyTelegramLessons(gradeKey, lessons) {
  const grade = lessons?.[gradeKey];
  if (!grade) return [];
  const collections = [
    { track: 'grammar', collectionId: null, lessons: grade.lessons },
    { track: 'spine', collectionId: 'standalone', lessons: grade.standaloneLessons },
    ...Object.entries(grade.collections || {}).map(([collectionId, collection]) => ({
      track: collectionId === 'treasure_island' ? 'literature' : null,
      collectionId,
      lessons: collection?.lessons
    }))
  ];
  return collections.flatMap(({ track, collectionId, lessons: collectionLessons }) => {
    if (!track || !Array.isArray(collectionLessons)) return [];
    return collectionLessons.flatMap((lesson, lessonIndex) => {
      if (typeof lesson?.id !== 'string' ||
          typeof lesson.videoFile !== 'string' ||
          (track !== 'grammar' && lesson.hasExercise === false) ||
          (lesson.hasExercise !== false &&
            (typeof lesson.taskMessage !== 'string' || !lesson.taskMessage.trim() ||
            !Array.isArray(lesson.answerKey) || lesson.answerKey.length === 0))) return [];
      const videoPath = path.resolve(ROOT_DIR, lesson.videoFile);
      const relativePath = path.relative(ROOT_DIR, videoPath);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return [];
      try {
        const stats = fs.statSync(videoPath);
        if (!stats.isFile() || stats.size === 0) return [];
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      return [{
        id: lesson.id,
        selectionKey: `${track}:${collectionId || ''}:${lesson.id}`,
        title: lesson.title || lesson.id,
        track,
        collectionId,
        lessonIndex
      }];
    });
  });
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

function getCurrentLessonNumber(student, lessons) {
  const gradeLessons = lessons?.[student?.grade]?.lessons;
  if (Array.isArray(gradeLessons) && typeof student?.currentLessonId === 'string') {
    const lessonPosition = gradeLessons.findIndex(lesson => lesson?.id === student.currentLessonId);
    if (lessonPosition >= 0) return lessonPosition + 1;
  }
  if (Number.isSafeInteger(student?.currentLessonIndex) && student.currentLessonIndex >= 0) {
    return student.currentLessonIndex + 1;
  }
  const lessonNumber = /^lesson_(\d+)$/.exec(student?.currentLessonId || '');
  return lessonNumber ? Number(lessonNumber[1]) : null;
}

function getStudentLessonCompletion(student, platform) {
  const receivedLessonIds = new Set(
    (Array.isArray(student.lessonHistory) ? student.lessonHistory : [])
      .filter(lessonId => typeof lessonId === 'string' && lessonId.trim())
  );
  if (typeof student.currentLessonId === 'string' && student.currentLessonId.trim()) {
    receivedLessonIds.add(student.currentLessonId);
  }
  const completedLessonIds = new Set(
    (Array.isArray(student.completedLessonIds) ? student.completedLessonIds : [])
      .filter(lessonId => typeof lessonId === 'string' && lessonId.trim())
  );
  if (student.lessonCompletionCounts &&
      typeof student.lessonCompletionCounts === 'object' &&
      !Array.isArray(student.lessonCompletionCounts)) {
    for (const [lessonId, count] of Object.entries(student.lessonCompletionCounts)) {
      if (Number.isSafeInteger(count) && count > 0) completedLessonIds.add(lessonId);
    }
  }
  for (const lessonId of completedLessonIds) receivedLessonIds.add(lessonId);

  const lessonIndexCount = Number.isSafeInteger(student.currentLessonIndex) &&
    student.currentLessonIndex >= 0
    ? student.currentLessonIndex + 1
    : 0;
  const lessonsReceived = Math.max(receivedLessonIds.size, lessonIndexCount);
  let lessonsPassed = completedLessonIds.size;
  if (lessonsPassed === 0 && platform === 'Telegram') {
    lessonsPassed = Number.isSafeInteger(student.lessonsCompleted) &&
      student.lessonsCompleted > 0
      ? student.lessonsCompleted
      : 0;
  } else if (lessonsPassed === 0 && platform === 'WhatsApp' && lessonIndexCount > 0) {
    lessonsPassed = student.status === 'completed'
      ? lessonIndexCount
      : lessonIndexCount - 1;
  }
  lessonsPassed = Math.min(lessonsPassed, lessonsReceived);

  return {
    lessonsPassed,
    lessonsReceived,
    lessonCompletionPercent: lessonsReceived > 0
      ? Math.round(lessonsPassed / lessonsReceived * 100)
      : null
  };
}

function getStudentExerciseScore(student, lessons, platform) {
  const gradeLessons = lessons?.[student.grade]?.lessons || [];
  const receivedLessonIds = new Set(
    (Array.isArray(student.lessonHistory) ? student.lessonHistory : [])
      .filter(lessonId => typeof lessonId === 'string' && lessonId.trim())
  );
  if (typeof student.currentLessonId === 'string' && student.currentLessonId.trim()) {
    receivedLessonIds.add(student.currentLessonId);
  }
  if (Number.isSafeInteger(student.currentLessonIndex) &&
      student.currentLessonIndex >= 0) {
    for (const lesson of gradeLessons.slice(0, student.currentLessonIndex + 1)) {
      if (typeof lesson?.id === 'string') receivedLessonIds.add(lesson.id);
    }
  }
  const exerciseScores = student.exerciseScores &&
    typeof student.exerciseScores === 'object' &&
    !Array.isArray(student.exerciseScores)
    ? student.exerciseScores
    : {};
  for (const lessonId of Object.keys(exerciseScores)) receivedLessonIds.add(lessonId);

  let correctQuestions = 0;
  let totalQuestions = 0;
  for (const lessonId of receivedLessonIds) {
    const lesson = gradeLessons.find(item => item?.id === lessonId);
    if (!Array.isArray(lesson?.answerKey) || lesson.answerKey.length === 0) continue;

    const expectedTaskVersion = platform === 'Telegram'
      ? createHash('sha256')
        .update(JSON.stringify([lesson.taskMessage, lesson.answerKey]))
        .digest('hex')
      : JSON.stringify([lesson.taskMessage, lesson.answerKey]);
    let score = exerciseScores[lessonId];
    if (score?.taskVersion !== expectedTaskVersion) score = null;
    if (score?.scoringPolicy !== 'first_attempt' ||
        !Array.isArray(score.correctQuestionNumbers)) continue;

    const correctForLesson = new Set(
      score.correctQuestionNumbers.filter(questionNumber =>
        Number.isSafeInteger(questionNumber) &&
        questionNumber >= 1 && questionNumber <= lesson.answerKey.length)
    );
    totalQuestions += lesson.answerKey.length;
    correctQuestions += correctForLesson.size;
  }

  return {
    scoreCorrectQuestions: correctQuestions,
    scoreTotalQuestions: totalQuestions,
    exerciseScorePercent: totalQuestions > 0
      ? Math.round(correctQuestions / totalQuestions * 100)
      : null
  };
}

export function getNextLessonToSkip(student, lessons) {
  if (!student || !student.grade ||
      !['awaiting_task', 'awaiting_reattempt', 'awaiting_content', 'completed'].includes(student.status || 'awaiting_content') ||
      typeof student.currentLessonId !== 'string') return null;
  const currentMatch = /^lesson_(\d+)$/.exec(student.currentLessonId);
  if (!currentMatch) return null;
  const gradeLessons = lessons?.[student.grade]?.lessons;
  if (!Array.isArray(gradeLessons) ||
      !gradeLessons.some(lesson => lesson?.id === student.currentLessonId)) return null;
  const nextLessonId = `lesson_${Number(currentMatch[1]) + 1}`;
  const lessonIndex = gradeLessons.findIndex(lesson => lesson?.id === nextLessonId);
  if (lessonIndex < 0) return null;
  const lesson = gradeLessons[lessonIndex];
  if (typeof lesson.videoFile !== 'string' ||
      typeof lesson.taskMessage !== 'string' || !lesson.taskMessage.trim() ||
      !Array.isArray(lesson.answerKey) || lesson.answerKey.length === 0) return null;
  try {
    const videoPath = path.resolve(ROOT_DIR, lesson.videoFile);
    const stats = fs.statSync(videoPath);
    if (!stats.isFile() || stats.size === 0) return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return {
    lessonIndex,
    lessonId: lesson.id,
    lessonTitle: lesson.title || lesson.id
  };
}

function telegramActivityTimestamps(student) {
  const activityTimestamps = Array.isArray(student.activityTimestamps)
    ? student.activityTimestamps.map(timestamp => Date.parse(timestamp)).filter(Number.isFinite)
    : [];
  if (activityTimestamps.length) return activityTimestamps;
  const fallback = Date.parse(student.lastActivityAt || student.deliveredAt || '');
  return Number.isFinite(fallback) ? [fallback] : [];
}

function getTelegramJoinPeaksByWeekday(telegramStudents, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      hour: '2-digit',
      hourCycle: 'h23'
    });
  } catch {
    throw new Error('The requested timezone is invalid.');
  }
  const counts = ACTIVITY_WEEKDAYS.map(day => ({
    day,
    hours: Array(24).fill(0)
  }));
  for (const student of telegramStudents) {
    const joinedAt = Date.parse(student.joinedAt || '');
    if (!Number.isFinite(joinedAt)) continue;
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(joinedAt)).map(part => [part.type, part.value])
    );
    const weekday = ACTIVITY_WEEKDAYS.indexOf(parts.weekday);
    const hour = Number(parts.hour);
    if (weekday >= 0 && hour >= 0 && hour <= 23) {
      counts[weekday].hours[hour] += 1;
    }
  }
  return counts.map(({ day, hours }) => {
    let peakHour = null;
    let peakJoins = 0;
    hours.forEach((count, hour) => {
      if (count > peakJoins) {
        peakJoins = count;
        peakHour = hour;
      }
    });
    return {
      day,
      peakHour,
      peakHourLabel: peakHour == null ? null : `${String(peakHour).padStart(2, '0')}:00`,
      peakJoins,
      hours
    };
  });
}

export function listDashboardStudentProgress(
  data,
  now = Date.now(),
  timeZone = 'UTC',
  trendEndDate = null,
  enrollmentEndDate = trendEndDate
) {
  const nowTimestamp = timestampMs(now);
  const todayDate = calendarDateKey(nowTimestamp, timeZone);
  const trendEndDateKey = trendEndDate || todayDate;
  if (!isValidCalendarDateKey(trendEndDateKey) || trendEndDateKey > todayDate) {
    throw new Error('A valid past or current trend end date is required.');
  }
  const enrollmentEndDateKey = enrollmentEndDate || trendEndDateKey;
  if (!isValidCalendarDateKey(enrollmentEndDateKey) || enrollmentEndDateKey > todayDate) {
    throw new Error('A valid past or current enrollment end date is required.');
  }
  const trendDates = getCalendarDatesEndingAt(trendEndDateKey, 30);
  const trendStartDate = trendDates[0];
  const enrollmentDates = getCalendarDatesEndingAt(enrollmentEndDateKey, 7);
  const enrollmentDatesSet = new Set(enrollmentDates);
  const activityByPhone = new Map();
  const sevenDayCutoff = nowTimestamp - 7 * 24 * 60 * 60 * 1000;
  const thirtyDayCutoff = nowTimestamp - 30 * 24 * 60 * 60 * 1000;
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
        firstStudentActivityAt: null,
        lastStudentActivityAt: null
      };
      activityByPhone.set(phoneJid, activity);
    }
    for (const message of messages) {
      if (message.role !== 'client') continue;
      const timestamp = timestampMs(message.timestamp);
      if (!timestamp) continue;
      activity.totalIncomingMessages += 1;
      if (!activity.firstStudentActivityAt || timestamp < activity.firstStudentActivityAt) {
        activity.firstStudentActivityAt = timestamp;
      }
      if (!activity.lastStudentActivityAt || timestamp > activity.lastStudentActivityAt) {
        activity.lastStudentActivityAt = timestamp;
      }
      if (timestamp <= nowTimestamp && timestamp >= sevenDayCutoff) {
        activity.incomingMessagesLast7Days += 1;
      }
      if (timestamp <= nowTimestamp && timestamp >= thirtyDayCutoff) {
        activity.incomingMessagesLast30Days += 1;
        activity.activeDatesLast30Days.add(new Date(timestamp).toISOString().slice(0, 10));
      }
    }
  }

  const students = Object.entries(data.progress || {}).map(([jid, student]) => {
    const contact = data.contacts[jid];
    const phoneJid = getPhoneJid(jid, contact?.phoneJid, contact?.jid) || jid;
    const activity = activityByPhone.get(phoneJid);
    const lesson = lessonForStudent(student, data.lessons);
    const nextLesson = getNextLessonToSkip(student, data.lessons);
    const lessonCompletion = getStudentLessonCompletion(student, 'WhatsApp');
    const exerciseScore = getStudentExerciseScore(student, data.lessons, 'WhatsApp');
    return {
      jid,
      platform: 'WhatsApp',
      name: displayName(contact, jid),
      gradeName: data.lessons[student.grade]?.name || student.grade,
      status: student.status,
      paymentKey: phoneJid,
      enrolledAt: student.enrolledAt ||
        (student.deliveredAt ? new Date(student.deliveredAt).toISOString() : null),
      currentLessonId: student.currentLessonId || '',
      currentLessonNumber: getCurrentLessonNumber(student, data.lessons),
      lessonTitle: lesson?.title || student.currentLessonId || '',
      canSkipToNextLesson: Boolean(nextLesson),
      nextLessonId: nextLesson?.lessonId || null,
      nextLessonTitle: nextLesson?.lessonTitle || null,
      joinedAt: activity?.firstStudentActivityAt
        ? new Date(activity.firstStudentActivityAt).toISOString()
        : null,
      deliveredAt: student.deliveredAt || null,
      lastStudentActivityAt: activity?.lastStudentActivityAt || null,
      totalIncomingMessages: activity?.totalIncomingMessages || 0,
      incomingMessagesLast7Days: activity?.incomingMessagesLast7Days || 0,
      incomingMessagesLast30Days: activity?.incomingMessagesLast30Days || 0,
      activeDaysLast30Days: activity?.activeDatesLast30Days.size || 0,
      lessonsCompleted: student.lessonsCompleted || 0,
      ...lessonCompletion,
      ...exerciseScore
    };
  });
  const telegramProgress = Object.entries(data.telegramProgress || {});
  const telegramStudents = telegramProgress.map(([key, student]) => {
    const activityTimestamps = telegramActivityTimestamps(student)
      .filter(timestamp => Number.isFinite(timestamp) && timestamp <= nowTimestamp);
    const cutoff7 = nowTimestamp - 7 * 24 * 60 * 60 * 1000;
    const cutoff30 = nowTimestamp - 30 * 24 * 60 * 60 * 1000;
    const recent7 = activityTimestamps.filter(timestamp => timestamp >= cutoff7);
    const recent30 = activityTimestamps.filter(timestamp => timestamp >= cutoff30);
    const activeDatesLast30Days = new Set(
      recent30.map(timestamp => calendarDateKey(timestamp, timeZone))
    );
    const lastActivityAt = Date.parse(student.lastActivityAt || student.deliveredAt || '');
    const joinedAt = Date.parse(student.groupJoinedAt || '');
    const lesson = lessonForStudent(student, data.lessons);
    const nextLesson = getNextLessonToSkip(student, data.lessons);
    const lessonCompletion = getStudentLessonCompletion(student, 'Telegram');
    const exerciseScore = getStudentExerciseScore(student, data.lessons, 'Telegram');
    const submission = student.lastTaskSubmission;
    const submissionTrack = submission?.track || student.activeTelegramTrack || 'grammar';
    const submissionProgress = submissionTrack === 'grammar'
      ? student
      : student.telegramLessonTracks?.[submissionTrack];
    const submissionMatchesActiveTask = submission?.grade === student.grade &&
      submission?.lessonId === (submissionTrack === 'grammar'
        ? student.currentLessonId
        : submissionProgress?.activeLessonId);
    const submissionEvaluated = (submissionMatchesActiveTask &&
      (submissionProgress?.status === 'awaiting_reattempt' ||
      [submissionProgress?.correctQuestionNumbers,
        submissionProgress?.resolvedQuestionNumbers,
        submissionProgress?.retryQuestionNumbers].some(numbers =>
        Array.isArray(numbers) && numbers.length > 0))) ||
      (Number.isSafeInteger(student.lessonCompletionCounts?.[submission?.lessonId]) &&
        student.lessonCompletionCounts[submission.lessonId] > 0) ||
      (Array.isArray(student.telegramLessonTracks?.[submissionTrack]?.completedLessonIds) &&
        student.telegramLessonTracks[submissionTrack].completedLessonIds.includes(submission?.lessonId));
    const submissionChecked = Number.isFinite(Date.parse(submission?.checkedAt || '')) ||
      Boolean(submissionEvaluated);
    return {
      jid: key,
      platform: 'Telegram',
      name: student.name || (student.telegramUsername ? `@${student.telegramUsername}` : `Telegram user ${student.telegramUserId || ''}`),
      grade: student.grade,
      gradeName: data.lessons[student.grade]?.name || student.grade,
      status: student.status || 'awaiting_content',
      paymentKey: key,
      enrolledAt: student.enrolledAt || student.joinedAt || student.deliveredAt || null,
      lessonStartedAt: getLessonPaymentStartAt(student),
      groupMembershipStatus: ['member', 'left', 'kicked', 'removed']
        .includes(student.groupMembershipStatus)
        ? student.groupMembershipStatus
        : null,
      groupLeftAt: typeof student.groupLeftAt === 'string' &&
          Number.isFinite(Date.parse(student.groupLeftAt))
        ? student.groupLeftAt
        : null,
      currentLessonId: student.currentLessonId || '',
      currentLessonNumber: getCurrentLessonNumber(student, data.lessons),
      lessonTitle: lesson?.title || student.currentLessonId || '',
      canSkipToNextLesson: Boolean(nextLesson),
      nextLessonId: nextLesson?.lessonId || null,
      nextLessonTitle: nextLesson?.lessonTitle || null,
      joinedAt: Number.isFinite(joinedAt) ? new Date(joinedAt).toISOString() : null,
      deliveredAt: student.deliveredAt || null,
      lastStudentActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : null,
      totalIncomingMessages: student.submissionsReceived || 0,
      incomingMessagesLast7Days: recent7.length,
      incomingMessagesLast30Days: recent30.length,
      activeDaysLast30Days: activeDatesLast30Days.size,
      lessonsCompleted: student.lessonsCompleted || 0,
      ...lessonCompletion,
      ...exerciseScore,
      lastTaskSubmissionAt: student.lastTaskSubmission?.submittedAt || null,
      lastTaskSubmission: typeof student.lastTaskSubmission?.text === 'string' &&
          typeof student.lastTaskSubmission?.submittedAt === 'string'
        ? {
            lessonId: student.lastTaskSubmission.lessonId || '',
            lessonTitle: data.lessons[student.lastTaskSubmission.grade]?.lessons
              ?.find(item => item?.id === student.lastTaskSubmission.lessonId)?.title ||
              student.lastTaskSubmission.lessonId ||
              'Lesson',
            text: student.lastTaskSubmission.text.slice(0, 4096),
            submittedAt: student.lastTaskSubmission.submittedAt,
            checkedAt: Number.isFinite(Date.parse(submission.checkedAt || ''))
              ? submission.checkedAt
              : null,
            checked: submissionChecked
          }
        : null,
      lastStudentMessage: typeof student.lastStudentMessage?.text === 'string' &&
          typeof student.lastStudentMessage?.receivedAt === 'string'
        ? {
            text: student.lastStudentMessage.text.slice(0, 4096),
            receivedAt: student.lastStudentMessage.receivedAt,
            source: student.lastStudentMessage.source === 'private' ? 'private' : 'group',
            checked: student.lastTaskSubmission?.text === student.lastStudentMessage.text &&
              submissionChecked
          }
        : null,
      canReplyPrivately: typeof student.telegramPrivateChatId === 'string' &&
        Boolean(student.telegramPrivateChatId.trim()),
      canRegradeTask: Boolean(
        student.lastTaskSubmission?.lessonId === student.currentLessonId &&
        student.lastTaskSubmission?.grade === student.grade &&
        typeof student.lastTaskSubmission?.text === 'string' &&
        student.telegramPrivateChatId &&
        ['awaiting_task', 'awaiting_reattempt'].includes(student.status)
      )
    };
  });
  students.push(...telegramStudents);
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
    if (!lastProgressActivityAt || nowTimestamp - lastProgressActivityAt < 7 * 24 * 60 * 60 * 1000) continue;
    followUpStudents.push({
      jid: student.jid,
      name: student.name,
      gradeName: student.gradeName,
      lessonTitle: student.lessonTitle,
      status: student.status,
      platform: student.platform,
      lastStudentActivityAt: student.lastStudentActivityAt,
      daysSinceActivity: Math.floor((nowTimestamp - lastProgressActivityAt) / (24 * 60 * 60 * 1000))
    });
  }
  followUpStudents.sort((left, right) =>
    Number(right.status === 'awaiting_reattempt') - Number(left.status === 'awaiting_reattempt') ||
    right.daysSinceActivity - left.daysSinceActivity);

  const engagementByDate = new Map();
  const trackedPhones = new Set(students
    .filter(student => student.platform === 'WhatsApp')
    .map(student => {
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
      if (!timestamp || timestamp > nowTimestamp) continue;
      const parts = Object.fromEntries(
        dateFormatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
      );
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      if (date < trendStartDate || date > trendEndDateKey) continue;
      let record = engagementByDate.get(date);
      if (!record) {
        record = {
          date,
          activePhones: new Set(),
          telegramStudents: new Set(),
          incomingMessages: 0
        };
        engagementByDate.set(date, record);
      }
      record.activePhones.add(phoneJid);
      record.incomingMessages += 1;
    }
  }
  for (const [key, student] of telegramProgress) {
    for (const timestamp of telegramActivityTimestamps(student)) {
      if (!Number.isFinite(timestamp) || timestamp > nowTimestamp) continue;
      const date = calendarDateKey(timestamp, timeZone);
      if (date < trendStartDate || date > trendEndDateKey) continue;
      let record = engagementByDate.get(date);
      if (!record) {
        record = {
          date,
          activePhones: new Set(),
          telegramStudents: new Set(),
          incomingMessages: 0
        };
        engagementByDate.set(date, record);
      }
      record.activePhones.add(key);
      record.telegramStudents.add(key);
      record.incomingMessages += 1;
    }
  }
  const engagementTrend = trendDates.map(date => {
    const record = engagementByDate.get(date);
    return {
      date,
      activeStudents: record?.activePhones.size || 0,
      telegramActiveStudents: record?.telegramStudents.size || 0,
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
      engagementTrend,
      telegramEnrollment: {
        totalStudents: telegramStudents.length,
        joinedToday: telegramStudents.filter(student =>
          student.joinedAt && calendarDateKey(Date.parse(student.joinedAt), timeZone) === enrollmentEndDateKey
        ).length,
        joinedLast7Days: telegramStudents.filter(student =>
          student.joinedAt && enrollmentDatesSet.has(calendarDateKey(Date.parse(student.joinedAt), timeZone))
        ).length,
        dailyJoins: enrollmentDates.map(date => ({
          date,
          students: telegramStudents.filter(student =>
            student.joinedAt && calendarDateKey(Date.parse(student.joinedAt), timeZone) === date
          ).length
        })),
        joinPeaksByWeekday: getTelegramJoinPeaksByWeekday(telegramStudents, timeZone)
      }
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
  return label?.label === 'paid' && label.source === 'manual' ? label : null;
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
        paid: data.paymentLabels?.[phoneNumber]?.label === 'paid' &&
          data.paymentLabels?.[phoneNumber]?.source === 'manual'
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

export function getDashboardWeeklyChatActivity(
  data,
  timeZone = 'UTC',
  now = Date.now(),
  endDate = null
) {
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
  const today = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
  const periodEnd = endDate || today;
  if (!isValidCalendarDateKey(periodEnd) || periodEnd > today) {
    throw new Error('A valid past or current activity end date is required.');
  }
  const daysByDate = new Map();
  for (const dateKey of getCalendarDatesEndingAt(periodEnd, 7)) {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    daysByDate.set(dateKey, {
      date: dateKey,
      day: new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        timeZone: 'UTC'
      }).format(date),
      conversations: new Set(),
      telegramStudents: new Set(),
      telegramJoins: new Set(),
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

  for (const [studentKey, student] of Object.entries(data.telegramProgress || {})) {
    for (const timestamp of telegramActivityTimestamps(student)) {
      if (timestamp > nowTimestamp) continue;
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
      );
      daysByDate.get(`${parts.year}-${parts.month}-${parts.day}`)
        ?.telegramStudents.add(studentKey);
    }
    const joinedAt = Date.parse(student.groupJoinedAt || '');
    if (Number.isFinite(joinedAt) && joinedAt <= nowTimestamp) {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(joinedAt)).map(part => [part.type, part.value])
      );
      daysByDate.get(`${parts.year}-${parts.month}-${parts.day}`)
        ?.telegramJoins.add(studentKey);
    }
  }

  return {
    timeZone,
    days: [...daysByDate.values()].map(({ date, day, conversations, telegramStudents, telegramJoins, newConversations }) => ({
      date,
      day,
      chats: conversations.size,
      newChats: newConversations,
      telegramActiveStudents: telegramStudents.size,
      telegramJoins: telegramJoins.size
    }))
  };
}

export function getDashboardOverview(data, now = Date.now(), timeZone = 'UTC', weeklyEndDate = null) {
  const nowTimestamp = timestampMs(now);
  const directChats = Object.entries(data.history)
    .filter(([jid, messages]) => isDirectChat(jid) && Array.isArray(messages) && messages.length > 0);
  const handledChats = directChats.filter(([, messages]) =>
    messages.some(message => message.role === 'agent')).length;
  const recentWindow = nowTimestamp - 24 * 60 * 60 * 1000;
  const activeToday = directChats.filter(([, messages]) =>
    timestampMs(latestMessage(messages)?.timestamp) >= recentWindow).length;
  const progressRecords = Object.values(data.progress);
  const telegramProgressRecords = Object.values(data.telegramProgress || {});
  const joinedDates = telegramProgressRecords
    .map(student => Date.parse(student.groupJoinedAt || ''))
    .filter(timestamp => Number.isFinite(timestamp) && timestamp <= nowTimestamp)
    .map(timestamp => calendarDateKey(timestamp, timeZone));
  const today = calendarDateKey(nowTimestamp, timeZone);
  const recentDates = new Set(getRecentCalendarDates(nowTimestamp, 7, timeZone));
  const telegramDailyJoins = getRecentCalendarDates(nowTimestamp, 7, timeZone).map(date => ({
    date,
    students: joinedDates.filter(joinedDate => joinedDate === date).length
  }));
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
    weeklyChatActivity: getDashboardWeeklyChatActivity(data, timeZone, nowTimestamp, weeklyEndDate),
    studentsWithProgress: progressRecords.length + telegramProgressRecords.length,
    awaitingTask: [...progressRecords, ...telegramProgressRecords]
      .filter(student => student.status === 'awaiting_task').length,
    awaitingReattempt: [...progressRecords, ...telegramProgressRecords]
      .filter(student => student.status === 'awaiting_reattempt').length,
    completed: [...progressRecords, ...telegramProgressRecords]
      .filter(student => student.status === 'completed').length,
    telegramStudents: telegramProgressRecords.length,
    telegramJoinedToday: joinedDates.filter(joinedDate => joinedDate === today).length,
    telegramJoinedLast7Days: joinedDates.filter(joinedDate => recentDates.has(joinedDate)).length,
    telegramDailyJoins,
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
        : status.connectionState === 'disconnecting'
          ? 'disconnecting'
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

export function getDashboardTelegramAgentStatus(status, now = Date.now()) {
  const updatedAt = Date.parse(status?.updatedAt || '');
  const heartbeatAge = now - updatedAt;
  const hasFreshHeartbeat = Number.isFinite(updatedAt) &&
    heartbeatAge >= 0 &&
    heartbeatAge <= AGENT_HEARTBEAT_MAX_AGE_MS;
  const connectionState = !hasFreshHeartbeat
    ? status?.connectionState ? 'disconnected' : 'unknown'
    : ['connected', 'connecting', 'retrying'].includes(status.connectionState)
      ? status.connectionState
      : 'disconnected';

  return {
    connectionState,
    connected: connectionState === 'connected',
    botUsername: typeof status?.botUsername === 'string' ? status.botUsername : '',
    lastConnectedAt: status?.lastConnectedAt || null,
    lastHeartbeatAt: Number.isFinite(updatedAt) ? status.updatedAt : null
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

export function getDashboardConversation(data, jid, offset = 0, limit = MAX_CONVERSATION_MESSAGES) {
  if (!jid || !isDirectChat(jid)) return null;
  const contact = data.contacts[jid];
  const messages = getConversationMessages(
    data.history,
    data.contacts,
    jid,
    contact?.phoneJid
  );
  if (messages.length === 0) return null;

  const gender = genderForContact(data, jid, getClientMessagesByPhone(data));
  const student = data.progress[jid] || getConversationJids(data.history, data.contacts, jid, contact?.phoneJid)
    .map(relatedJid => data.progress[relatedJid])
    .find(Boolean) || null;
  const lesson = student ? lessonForStudent(student, data.lessons) : null;
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.floor(limit));
  const end = Math.max(0, messages.length - safeOffset);
  const start = Math.max(0, end - safeLimit);
  const recentMessages = messages.slice(start, end);
  const oldestMessage = messages.find(message => typeof message.id === 'string' && message.id);

  return {
    jid,
    name: displayName(contact, jid),
    isEs: getConversationJids(data.history, data.contacts, jid, contact?.phoneJid)
      .some(relatedJid => data.contacts[relatedJid]?.isEs === true),
    gender,
    progress: student ? {
      gradeName: data.lessons[student.grade]?.name || student.grade,
      status: student.status,
      lessonTitle: lesson?.title || student.currentLessonId || '',
      deliveredAt: student.deliveredAt || null
    } : null,
    totalMessages: messages.length,
    hasMore: start > 0,
    oldestMessageKey: oldestMessage ? {
      remoteJid: oldestMessage.remoteJid || jid,
      id: oldestMessage.id,
      fromMe: oldestMessage.role === 'agent'
    } : null,
    oldestMessageTimestamp: oldestMessage ? timestampMs(oldestMessage.timestamp) : null,
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

export function getDashboardStudentActivity(
  data,
  jid,
  days,
  timeZone,
  now = Date.now(),
  endDate = null
) {
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
  const todayDate = dateKey(now);
  const periodEnd = endDate || todayDate;
  if (!isValidCalendarDateKey(periodEnd) || periodEnd > todayDate) {
    throw new Error('A valid past or current activity end date is required.');
  }
  const periodDates = getCalendarDatesEndingAt(periodEnd, days);
  const periodStart = periodDates[0];
  const isInPeriod = timestamp => {
    const date = dateKey(timestamp);
    return date >= periodStart && date <= periodEnd;
  };
  let pendingStudentMessageAt = null;
  const responseTimes = [];
  let unansweredIncomingCount = 0;

  for (const message of histories) {
    const timestamp = message.timestamp;
    if (timestamp > now) continue;
    const messageDate = dateKey(timestamp);
    if (messageDate > periodEnd) continue;
    if (message.role === 'client' && messageDate >= periodStart) {
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
      if (messageDate >= periodStart) {
        const key = dateKey(timestamp);
        const daily = dailyActivityByDate.get(key) || { incoming: 0, outgoing: 0 };
        daily.outgoing += 1;
        dailyActivityByDate.set(key, daily);
      }
      if (pendingStudentMessageAt !== null) {
        if (isInPeriod(pendingStudentMessageAt)) {
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

  if (pendingStudentMessageAt !== null && isInPeriod(pendingStudentMessageAt)) {
    unansweredIncomingCount = 1;
  }
  const dailyActivity = periodDates.map(date => {
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

function isSameOriginDashboardRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host === host &&
      (parsedOrigin.protocol === 'https:' ||
        (parsedOrigin.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname)));
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

function getTelegramPrivateChatUserIds(progress, groupId) {
  return new Set(Object.values(progress || {})
    .filter(student =>
      String(student?.telegramChatId || '') === String(groupId || '') &&
      Boolean(student?.telegramPrivateChatId))
    .map(student => String(student.telegramUserId)));
}

function getTelegramGroupAudienceVersion(groupRoster, privateChatUserIds) {
  const audienceState = groupRoster
    .map(member => [
      String(member.userId),
      String(member.name || ''),
      String(member.joinedAt || ''),
      privateChatUserIds.has(String(member.userId))
    ])
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return createHash('sha256')
    .update(JSON.stringify(audienceState))
    .digest('hex');
}

function getTelegramJoinDateFilters({ joinedAfter = '', joinedBefore = '', timeZone = 'UTC' }) {
  if ((joinedAfter && !isValidCalendarDateKey(joinedAfter)) ||
      (joinedBefore && !isValidCalendarDateKey(joinedBefore))) {
    return { error: 'Join dates must be valid calendar dates in YYYY-MM-DD format.' };
  }
  if (joinedAfter && joinedBefore && joinedAfter > joinedBefore) {
    return { error: 'The start date must be on or before the end date.' };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    return { error: 'A valid time zone is required for join-date filtering.' };
  }
  return { joinedAfter, joinedBefore, timeZone };
}

function filterTelegramGroupRosterByJoinDate(groupRoster, { joinedAfter, joinedBefore, timeZone }) {
  if (!joinedAfter && !joinedBefore) return groupRoster;
  return groupRoster.filter(member => {
    const joinedAt = Date.parse(member.joinedAt || '');
    if (!Number.isFinite(joinedAt)) return false;
    const joinedDate = calendarDateKey(joinedAt, timeZone);
    return (!joinedAfter || joinedDate >= joinedAfter) &&
      (!joinedBefore || joinedDate <= joinedBefore);
  });
}

async function handleTelegramUserBroadcastPost(req, res, progressFile, broadcastFiles, groupId) {
  if (!isSameOriginLoopbackRequest(req)) {
    sendJson(res, 403, { error: 'Telegram account broadcasts are only accepted from this local dashboard.' });
    return;
  }
  try {
    const body = await readRequestBody(req);
    const requests = readJsonFileOr(broadcastFiles.requests, []);
    const state = readJsonFileOr(broadcastFiles.state, { jobs: {} });
    if (!Array.isArray(requests) || !state?.jobs || typeof state.jobs !== 'object') {
      throw new Error('Invalid Telegram account broadcast data.');
    }
    if (body.action === 'cancel') {
      const job = requests.find(request => request.id === body.id);
      if (!job) {
        sendJson(res, 404, { error: 'Telegram broadcast not found.' });
        return;
      }
      const jobState = state.jobs[job.id];
      if (jobState && !['queued', 'running', 'waiting'].includes(jobState.status)) {
        sendJson(res, 409, { error: 'This Telegram broadcast can no longer be cancelled.' });
        return;
      }
      job.cancelled = true;
      writeJsonFile(broadcastFiles.requests, requests);
      if (jobState?.status === 'running') {
        writeJsonFile(broadcastFiles.state, {
          ...state,
          jobs: {
            ...state.jobs,
            [job.id]: { ...jobState, status: 'cancellation_requested' }
          }
        });
      } else if (jobState) {
        writeJsonFile(broadcastFiles.state, {
          ...state,
          jobs: {
            ...state.jobs,
            [job.id]: {
              ...jobState,
              status: 'cancelled',
              completedAt: new Date().toISOString()
            }
          }
        });
      }
      sendJson(res, 200, { id: job.id, status: 'cancellation_requested' });
      return;
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4096) {
      sendJson(res, 400, { error: 'Enter a message between 1 and 4,096 characters.' });
      return;
    }
    if (body.personalized === true && !text.includes('{{name}}')) {
      sendJson(res, 400, { error: 'Personalized messages must include the {{name}} placeholder.' });
      return;
    }
    const progress = readJsonFileOr(progressFile, {});
    const groupMemberAudience = body.audience === 'group-members';
    const groupRoster = Array.isArray(state.groupRoster) ? state.groupRoster : [];
    const privateChatUserIds = getTelegramPrivateChatUserIds(progress, groupId);
    const audienceVersion = getTelegramGroupAudienceVersion(groupRoster, privateChatUserIds);
    const joinDateFilters = getTelegramJoinDateFilters({
      joinedAfter: body.joinedAfter || '',
      joinedBefore: body.joinedBefore || '',
      timeZone: body.timeZone || 'UTC'
    });
    if (joinDateFilters.error) {
      sendJson(res, 400, { error: joinDateFilters.error });
      return;
    }
    const audienceFilter = body.audienceFilter || 'all';
    if (!['all', 'not-messaged-privately', 'online-only'].includes(audienceFilter)) {
      sendJson(res, 400, { error: 'Choose a supported group member filter.' });
      return;
    }
    const rosterSyncedAt = Date.parse(state.groupRosterSyncedAt || '');
    const rosterIsFresh = Number.isFinite(rosterSyncedAt) &&
      Date.now() - rosterSyncedAt >= 0 &&
      Date.now() - rosterSyncedAt <= TELEGRAM_GROUP_ROSTER_MAX_AGE_MS;
    if (groupMemberAudience && !rosterIsFresh) {
      sendJson(res, 409, {
        error: 'The current group member list is unavailable or stale. Make sure the Telegram account sender is running, then refresh the recipient list.'
      });
      return;
    }
    if (groupMemberAudience && body.personalized !== true) {
      sendJson(res, 400, { error: 'Group-member discount offers must use personalized delivery.' });
      return;
    }
    if (groupMemberAudience &&
        (body.expectedRosterUpdatedAt !== state.groupRosterUpdatedAt ||
          body.expectedAudienceVersion !== audienceVersion)) {
      sendJson(res, 409, {
        error: 'The group membership or private-chat status changed since the preview. Refresh the recipient list and confirm again.'
      });
      return;
    }
    const eligibleRecipients = groupMemberAudience
      ? filterTelegramGroupRosterByJoinDate(groupRoster, joinDateFilters).map(member => ({
        userId: String(member.userId),
        name: typeof member.name === 'string' && member.name.trim()
          ? member.name.trim()
          : `Telegram user ${member.userId}`,
        hasPrivateChat: privateChatUserIds.has(String(member.userId)),
        ...(typeof member.joinedAt === 'string' ? { joinedAt: member.joinedAt } : {})
      })).filter(member =>
        (audienceFilter !== 'not-messaged-privately' || !member.hasPrivateChat) &&
        (audienceFilter !== 'online-only' || member.presence === 'online'))
      : Object.values(progress)
        .filter(student => isTelegramAnnouncementRecipient(student, groupId))
        .map(student => ({ userId: String(student.telegramUserId) }));
    if (body.personalized === true &&
        (!Number.isSafeInteger(body.expectedCount) || body.expectedCount !== eligibleRecipients.length)) {
      sendJson(res, 409, {
        error: 'The eligible recipient count changed. Refresh the preview and confirm again.'
      });
      return;
    }
    let excludedUserIds = [];
    if (body.personalized === true) {
      if (body.excludedUserIds !== undefined &&
          (!Array.isArray(body.excludedUserIds) ||
            body.excludedUserIds.some(userId => typeof userId !== 'string'))) {
        sendJson(res, 400, { error: 'Excluded recipient IDs must be a list of Telegram user IDs.' });
        return;
      }
      excludedUserIds = body.excludedUserIds || [];
      const eligibleUserIds = new Set(eligibleRecipients.map(recipient => recipient.userId));
      if (new Set(excludedUserIds).size !== excludedUserIds.length ||
          excludedUserIds.some(userId => !eligibleUserIds.has(userId))) {
        sendJson(res, 409, {
          error: 'The excluded students are no longer in the eligible audience. Refresh the preview and try again.'
        });
        return;
      }
    }
    const excludedUserIdSet = new Set(excludedUserIds);
    const recipients = eligibleRecipients.filter(recipient =>
      !excludedUserIdSet.has(recipient.userId));
    if (recipients.length === 0) {
      sendJson(res, 409, {
        error: excludedUserIds.length
          ? 'Keep at least one recipient selected for this offer.'
          : groupMemberAudience
            ? 'The configured Telegram group has no current members.'
            : 'No students have opted in to private Telegram announcements.'
      });
      return;
    }
    if (recipients.length > 500) {
      sendJson(res, 409, { error: 'This broadcast exceeds the 500-recipient safety limit.' });
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const job = {
      id,
      text,
      ...(body.personalized === true ? { personalized: true } : {}),
      ...(groupMemberAudience ? { audience: 'group-members' } : {}),
      ...(groupMemberAudience ? { audienceFilter } : {}),
      ...(groupMemberAudience && joinDateFilters.joinedAfter
        ? { joinedAfter: joinDateFilters.joinedAfter }
        : {}),
      ...(groupMemberAudience && joinDateFilters.joinedBefore
        ? { joinedBefore: joinDateFilters.joinedBefore }
        : {}),
      ...(groupMemberAudience ? { timeZone: joinDateFilters.timeZone } : {}),
      ...(body.personalized === true && excludedUserIds.length
        ? { excludedUserIds }
        : {}),
      recipients,
      createdAt: new Date().toISOString(),
      cancelled: false
    };
    const queuedAt = new Date().toISOString();
    writeJsonFile(broadcastFiles.state, {
      ...state,
      jobs: {
        ...state.jobs,
        [id]: {
          status: 'queued',
          total: recipients.length,
          sent: 0,
          skipped: 0,
          uncertain: 0,
          nextIndex: 0,
          recipientResults: [],
          createdAt: queuedAt
        }
      }
    });
    requests.push(job);
    fs.mkdirSync(path.dirname(broadcastFiles.requests), { recursive: true });
    writeJsonFile(broadcastFiles.requests, requests);
    sendJson(res, 202, {
      id,
      status: 'queued',
      total: recipients.length,
      createdAt: job.createdAt
    });
  } catch (error) {
    console.error('[Admin Dashboard] Could not queue Telegram account broadcast:', error.message);
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
  launchAgent = () => spawn(process.execPath, [path.join(ROOT_DIR, 'index.js')], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }),
  agentLogFile = AGENT_LOG_FILE,
  telegramAgentLogFile = TELEGRAM_AGENT_LOG_FILE,
  agentMediaActivityFile = AGENT_MEDIA_ACTIVITY_FILE,
  telegramAgentMediaActivityFile = TELEGRAM_AGENT_MEDIA_ACTIVITY_FILE,
  agentMediaRetryRequestsFile = AGENT_MEDIA_RETRY_REQUESTS_FILE,
  telegramAgentMediaRetryRequestsFile = TELEGRAM_AGENT_MEDIA_RETRY_REQUESTS_FILE,
  chatReadStateFile = CHAT_READ_STATE_FILE,
  incomingChatQueueFile = INCOMING_CHAT_QUEUE_FILE,
  whatsappChatActivityFile = WHATSAPP_CHAT_ACTIVITY_FILE,
  broadcastMediaDirectory = BROADCAST_MEDIA_DIRECTORY,
  authFile = path.join(ROOT_DIR, 'data', 'admin_auth.json'),
  authManager = new DashboardAuth(authFile),
  viewerAuthFile = path.join(ROOT_DIR, 'data', 'admin_viewer_auth.json'),
  viewerAuthManager = new DashboardAuth(viewerAuthFile, { cookieName: 'eshool_dashboard_viewer' }),
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
  studentWorkbookFile = null,
  lessonsFile = LESSONS_FILE,
  lessonMediaDirectory = LESSON_MEDIA_DIR,
  scheduledLessonsFile = SCHEDULED_LESSONS_FILE,
  progressFile = PROGRESS_FILE,
  paymentLedgerFile = STUDENT_PAYMENT_LEDGER_FILE,
  telegramAgentStatusFile = TELEGRAM_AGENT_STATUS_FILE,
  telegramUpdateQueueFile = TELEGRAM_UPDATE_QUEUE_FILE,
  telegramAgentControlFile = TELEGRAM_AGENT_CONTROL_FILE,
  telegramProgressFile = TELEGRAM_PROGRESS_FILE,
  overviewWorkbookFile = null,
  telegramGroupMemberHistoryFile = overviewWorkbookFile,
  overviewGoogleSheetStateFile = OVERVIEW_GOOGLE_SHEET_STATE_FILE,
  telegramDashboardChatRepliesFile = TELEGRAM_DASHBOARD_CHAT_REPLIES_FILE,
  telegramStudentGenderFile = TELEGRAM_STUDENT_GENDER_FILE,
  paymentReceiptImageDirectory = PAYMENT_RECEIPT_IMAGE_DIRECTORY,
  historicalPaymentReceiptsFile = HISTORICAL_PAYMENT_RECEIPTS_FILE,
  telegramGroupId = process.env.TELEGRAM_GROUP_ID,
  telegramBlockedRecipientsFile = TELEGRAM_BLOCKED_RECIPIENTS_FILE,
  telegramClassGroups = process.env.TELEGRAM_CLASS_GROUPS
    ? JSON.parse(process.env.TELEGRAM_CLASS_GROUPS)
    : {},
  telegramMemberCountProvider = null,
  telegramPaymentNotifier = null,
  telegramMessageNotifier = null,
  telegramLeaderboardNotifier = null,
  telegramUserBroadcastFiles = {
    requests: TELEGRAM_USER_BROADCAST_REQUESTS_FILE,
    state: TELEGRAM_USER_BROADCAST_STATE_FILE
  },
  generateAnswerKey = generateLessonAnswerKey,
  whatsappLessonSkipRequestsFile = WHATSAPP_LESSON_SKIP_REQUESTS_FILE,
  telegramLessonSkipRequestsFile = TELEGRAM_LESSON_SKIP_REQUESTS_FILE
} = {}) {
  let launchedAgent = null;
  const blockedContacts = createBlockedContactsStore(blockedContactsFile);
  const contactGenders = createContactGenderStore(contactGenderFile);
  const telegramStudentGenders = createTelegramStudentGenderStore(telegramStudentGenderFile);
  const paymentLabels = createContactPaymentLabelsStore(paymentLabelsFile);
  const studentPaymentLedger = createStudentPaymentLedger(paymentLedgerFile);
  const sendTelegramPaymentMessage = async (chatId, text) => {
    if (isTelegramPrivateChatBlocked(chatId, telegramBlockedRecipientsFile)) {
      throw new Error('Telegram private chat was previously blocked; send skipped.');
    }
    try {
      if (telegramPaymentNotifier) {
        await telegramPaymentNotifier(String(chatId), text);
        return;
      }
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text }),
        signal: AbortSignal.timeout(10_000)
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.description || 'Telegram rejected the message.');
      }
    } catch (error) {
      if (isTelegramBotBlockedError(error)) {
        markTelegramPrivateChatBlocked(chatId, telegramBlockedRecipientsFile);
      }
      throw error;
    }
  };
  const historicalPaymentReceipts = createHistoricalPaymentReceiptStore(historicalPaymentReceiptsFile);
  const scheduledLessons = createScheduledLessonStore({ filePath: scheduledLessonsFile });
  if (!telegramClassGroups || typeof telegramClassGroups !== 'object' ||
      Array.isArray(telegramClassGroups)) {
    throw new Error('TELEGRAM_CLASS_GROUPS must be a JSON object mapping group IDs to grade keys.');
  }
  const telegramGroupGrades = new Map();
  if (telegramGroupId) telegramGroupGrades.set(String(telegramGroupId), config.defaultStudentGrade);
  for (const [chatId, grade] of Object.entries(telegramClassGroups)) {
    if (!/^-?\d+$/.test(chatId) || typeof grade !== 'string' || !grade.trim()) {
      throw new Error('Each Telegram class group must have a numeric chat ID and a grade key.');
    }
    telegramGroupGrades.set(chatId, grade.trim());
  }
  const lessonSkipQueues = {
    WhatsApp: new LessonSkipQueue(whatsappLessonSkipRequestsFile),
    Telegram: new LessonSkipQueue(telegramLessonSkipRequestsFile)
  };
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
  const getTelegramProgressSnapshot = (
    timeZone,
    now = Date.now(),
    includeMediaProgress = false,
    trendEndDate = null,
    enrollmentEndDate = trendEndDate
  ) => {
    const telegramAccountState = readJsonFileOr(telegramUserBroadcastFiles.state, {});
    const rosterSyncedAt = Date.parse(telegramAccountState.groupRosterSyncedAt || '');
    const presenceIsFresh = Number.isFinite(rosterSyncedAt) &&
      now >= rosterSyncedAt &&
      now - rosterSyncedAt <= TELEGRAM_PRESENCE_MAX_AGE_MS;
    const presenceByUserId = new Map(
      presenceIsFresh && Array.isArray(telegramAccountState.groupRoster)
        ? telegramAccountState.groupRoster
          .filter(member => typeof member?.userId === 'string' &&
            ['online', 'offline', 'unknown'].includes(member.presence))
          .map(member => [member.userId, member.presence])
        : []
    );
    const data = {
      history: {},
      contacts: {},
      progress: {},
      telegramProgress: readJsonFileOr(telegramProgressFile, {}),
      lessons: readJsonFile(lessonsFile)
    };
    const genderOverrides = telegramStudentGenders.list();
    const progress = listDashboardStudentProgress(
      data,
      now,
      timeZone,
      trendEndDate,
      enrollmentEndDate
    );
    const paymentStatusByStudent = new Map(
      studentPaymentLedger.getCurrentForStudents(
        progress.students
          .filter(student => student.lessonStartedAt)
          .map(student => ({
            studentKey: student.paymentKey,
            enrolledAt: student.lessonStartedAt
          }))
      ).map(current => [current.studentKey, current.payment?.status])
    );
    const blockedPrivateChatIds = getTelegramBlockedPrivateChatIds(
      telegramBlockedRecipientsFile
    );
    const telegramChatReadState = chatReadState.read();
    const telegramMediaActivities = includeMediaProgress
      ? readAgentMediaActivities(telegramAgentMediaActivityFile)
      : [];
    const latestSkipRequests = new Map();
    const latestSendRequests = new Map();
    const latestRegradeRequests = new Map();
    const latestReminderRequests = new Map();
    const latestScoreMessageRequests = new Map();
    for (const request of lessonSkipQueues.Telegram.read()) {
      if (request.requestType === 'send_lesson') {
        latestSendRequests.set(request.studentKey, request);
      } else if (request.requestType === 'regrade_task') {
        latestRegradeRequests.set(request.studentKey, request);
      } else if (request.requestType === 'manual_reminder') {
        latestReminderRequests.set(request.studentKey, request);
      } else if (request.requestType === 'score_message') {
        latestScoreMessageRequests.set(request.studentKey, request);
      } else {
        latestSkipRequests.set(request.studentKey, request);
      }
    }
    return {
      ...progress,
      students: progress.students.map(student => {
        const request = latestSkipRequests.get(student.jid);
        const sendRequest = latestSendRequests.get(student.jid);
        const regradeRequest = latestRegradeRequests.get(student.jid);
        const reminderRequest = latestReminderRequests.get(student.jid);
        const scoreMessageRequest = latestScoreMessageRequests.get(student.jid);
        const sendActivity = sendRequest
          ? telegramMediaActivities
            .filter(activity =>
              activity.platform === 'Telegram' &&
              activity.studentKey === student.jid &&
              activity.lessonId === sendRequest.nextLessonId &&
              Date.parse(activity.updatedAt || '') >= Date.parse(sendRequest.createdAt || ''))
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
          : null;
        const telegramStudent = data.telegramProgress[student.jid];
        const telegramBotBlocked = blockedPrivateChatIds.has(
          String(telegramStudent?.telegramPrivateChatId || '')
        );
        const latestStudentMessageAt = Math.max(
          Date.parse(telegramStudent?.lastStudentMessage?.receivedAt || '') || 0,
          ...(Array.isArray(telegramStudent?.telegramChatHistory)
            ? telegramStudent.telegramChatHistory
              .filter(message => message?.role === 'student')
              .map(message => Date.parse(message.timestamp || '') || 0)
            : [0])
        );
        return {
          ...student,
          paymentVerified: paymentStatusByStudent.get(student.paymentKey) === 'paid',
          telegramBotBlocked,
          canReplyPrivately: student.canReplyPrivately && !telegramBotBlocked,
          canSkipToNextLesson: student.canSkipToNextLesson && !telegramBotBlocked,
          canRegradeTask: student.canRegradeTask && !telegramBotBlocked,
          unread: latestStudentMessageAt > 0 &&
            latestStudentMessageAt > Number(telegramChatReadState[student.jid] || 0),
          gender: getTelegramStudentGender(telegramStudent, genderOverrides[student.jid]),
          genderOverride: genderOverrides[student.jid] || 'auto',
          telegramPresence: presenceIsFresh
            ? presenceByUserId.get(String(telegramStudent?.telegramUserId)) || 'unknown'
            : 'unknown',
          telegramPresenceUpdatedAt: presenceIsFresh
            ? telegramAccountState.groupRosterSyncedAt
            : null,
          availableLessons: getReadyTelegramLessons(student.grade, data.lessons),
          canSendReminder: Boolean(
            !telegramBotBlocked &&
            data.telegramProgress[student.jid]?.telegramPrivateChatId &&
            ['awaiting_task', 'awaiting_reattempt'].includes(
              data.telegramProgress[student.jid]?.status
            )
          ),
          reminderRequest: reminderRequest?.currentLessonId === student.currentLessonId
            ? {
                status: reminderRequest.status,
                  error: reminderRequest.error,
                  updatedAt: reminderRequest.updatedAt
              }
            : null,
          scoreMessageRequest: scoreMessageRequest?.scorePercent === student.exerciseScorePercent
            ? {
                scorePercent: scoreMessageRequest.scorePercent,
                status: scoreMessageRequest.status,
                error: scoreMessageRequest.error,
                updatedAt: scoreMessageRequest.updatedAt
              }
            : null,
          skipRequest: request?.currentLessonId === student.currentLessonId
            ? {
                status: request.status,
                error: request.error,
                nextLessonTitle: request.nextLessonTitle
              }
            : null,
          sendLessonRequest: sendRequest
            ? {
                status: sendRequest.status,
                error: sendRequest.error,
                nextLessonId: sendRequest.nextLessonId,
                nextLessonTitle: sendRequest.nextLessonTitle,
                progress: sendActivity
                  ? {
                      status: sendActivity.status,
                      percent: Number.isFinite(sendActivity.percent)
                        ? Math.max(0, Math.min(100, sendActivity.percent))
                        : null,
                      loaded: Number.isFinite(sendActivity.loaded) ? sendActivity.loaded : null,
                      total: Number.isFinite(sendActivity.total) ? sendActivity.total : null
                    }
                  : null
              }
            : null,
          regradeRequest: regradeRequest?.currentLessonId === student.currentLessonId
            ? {
                status: regradeRequest.status,
                error: regradeRequest.error
              }
            : null
        };
      })
    };
  };
  let telegramMemberCountCache = {
    count: null,
    updatedAt: null,
    checkedAt: 0
  };
  const getTelegramGroupMemberCount = async () => {
    if (Date.now() - telegramMemberCountCache.checkedAt < 60_000) {
      return telegramMemberCountCache;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (typeof telegramMemberCountProvider !== 'function' &&
        (!token || !telegramGroupId)) {
      telegramMemberCountCache = {
        count: null,
        updatedAt: null,
        checkedAt: Date.now()
      };
      return telegramMemberCountCache;
    }

    try {
      const count = typeof telegramMemberCountProvider === 'function'
        ? await telegramMemberCountProvider(telegramGroupId)
        : await (async () => {
            const response = await fetch(
              `https://api.telegram.org/bot${token}/getChatMemberCount`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chat_id: telegramGroupId }),
                signal: AbortSignal.timeout(10_000)
              }
            );
            const payload = await response.json();
            if (!response.ok || payload?.ok !== true) {
              throw new Error('Telegram did not return the group member count.');
            }
            return payload.result;
          })();
      if (!Number.isInteger(count) || count < 0) {
        throw new Error('Telegram returned an invalid group member count.');
      }
      telegramMemberCountCache = {
        count,
        updatedAt: new Date().toISOString(),
        checkedAt: Date.now()
      };
    } catch (error) {
      console.error('[Admin Dashboard] Could not fetch Telegram group member count:', error.message);
      telegramMemberCountCache = {
        ...telegramMemberCountCache,
        checkedAt: Date.now()
      };
    }
    return telegramMemberCountCache;
  };
  const eventClients = new Set();
  const pendingChanges = new Set();
  const watchedFiles = new Set([
    telegramAgentLogFile,
    telegramAgentMediaActivityFile,
    telegramUpdateQueueFile,
    telegramAgentControlFile,
    lessonsFile,
    telegramProgressFile,
    telegramDashboardChatRepliesFile,
    telegramUserBroadcastFiles.requests,
    telegramUserBroadcastFiles.state,
    paymentLedgerFile,
    historicalPaymentReceiptsFile,
    paymentLabelsFile,
    telegramAgentStatusFile,
    telegramLessonSkipRequestsFile,
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
  const overviewWorkbook = overviewWorkbookFile
    ? createOverviewWorkbookManager({
        filePath: overviewWorkbookFile,
        onUpdated: () => scheduleChange(path.basename(overviewWorkbookFile)),
        readSnapshot: async () => {
          const now = Date.now();
          const timeZone = 'Africa/Khartoum';
          const telegramProgress = readJsonFileOr(telegramProgressFile, {});
          const lessons = readJsonFile(lessonsFile);
          const uniqueTelegramRecords = getTelegramUniqueStudentRecords(telegramProgress);
          const telegramClasses = getTelegramClassStatistics(
            telegramProgress,
            lessons,
            telegramGroupGrades,
            now,
            timeZone
          );
          const sumClassStatistics = key => telegramClasses.reduce((total, classStats) =>
            total + classStats[key], 0);
          const genderOverrides = telegramStudentGenders.list();
          const telegramGenderStatistics = uniqueTelegramRecords.reduce((counts, record) => {
            const studentKey =
              `telegram:${record.student.telegramChatId}:${record.student.telegramUserId || record.userId}`;
            const gender = getTelegramStudentGender(
              record.student,
              genderOverrides[studentKey]
            ).value;
            counts[['female', 'male'].includes(gender) ? gender : 'unknown'] += 1;
            return counts;
          }, { female: 0, male: 0, unknown: 0 });
          const groupStats = await getTelegramGroupMemberCount();
          const telegramAccountState = readJsonFileOr(telegramUserBroadcastFiles.state, {});
          const onlineCountUpdatedAt = Date.parse(
            telegramAccountState.onlineGroupMembersUpdatedAt || ''
          );
          const onlineCountIsFresh = Number.isSafeInteger(
            telegramAccountState.onlineGroupMembersCount
          ) && telegramAccountState.onlineGroupMembersCount >= 0 &&
            Number.isFinite(onlineCountUpdatedAt) &&
            now >= onlineCountUpdatedAt &&
            now - onlineCountUpdatedAt <= TELEGRAM_PRESENCE_MAX_AGE_MS;
          const dailyStats = getRecentCalendarDates(now, 30, timeZone).map(date => ({
            date,
            joins: 0,
            activeLearners: 0
          }));
          const dailyByDate = new Map(dailyStats.map(day => [day.date, day]));
          const joinsByDate = new Map();
          for (const student of Object.values(telegramProgress)) {
            const joinedAt = Date.parse(student?.groupJoinedAt || '');
            if (!Number.isFinite(joinedAt) || joinedAt > now) continue;
            const date = calendarDateKey(joinedAt, timeZone);
            joinsByDate.set(date, (joinsByDate.get(date) || 0) + 1);
          }
          for (const day of dailyStats) day.joins = joinsByDate.get(day.date) || 0;
          for (const { student } of uniqueTelegramRecords) {
            const activeDates = new Set(telegramActivityTimestamps(student)
              .filter(timestamp => timestamp <= now)
              .map(timestamp => calendarDateKey(timestamp, timeZone)));
            for (const date of activeDates) {
              const day = dailyByDate.get(date);
              if (day) day.activeLearners += 1;
            }
          }
          const today = calendarDateKey(now, timeZone);
          const recentSevenDays = dailyStats.slice(-7);
          const lessonCounts = Object.values(lessons)
            .reduce((count, grade) =>
              count + (Array.isArray(grade.lessons) ? grade.lessons.length : 0), 0);
          return {
            snapshotDate: today,
            snapshotAt: new Date(now).toISOString(),
            overview: {
              telegramStudents: uniqueTelegramRecords.length,
              female: telegramGenderStatistics.female,
              male: telegramGenderStatistics.male,
              unknown: telegramGenderStatistics.unknown,
              lessonsCompleted: sumClassStatistics('lessonsCompleted'),
              lessonCompletionsLast7Days: sumClassStatistics('lessonCompletionsLast7Days'),
              joinedToday: joinsByDate.get(today) || 0,
              joinedLast7Days: recentSevenDays.reduce((total, day) => total + day.joins, 0),
              awaitingTask: sumClassStatistics('awaitingTask'),
              awaitingReattempt: sumClassStatistics('awaitingReattempt'),
              completed: sumClassStatistics('completed'),
              configuredLessons: lessonCounts,
              totalGroupMembers: groupStats.count,
              onlineGroupMembers: onlineCountIsFresh
                ? telegramAccountState.onlineGroupMembersCount
                : null,
              onlineGroupMembersStatus: onlineCountIsFresh
                ? 'available'
                : Number.isFinite(onlineCountUpdatedAt) ? 'stale' : 'unavailable'
            },
            classes: telegramClasses,
            dailyStats
          };
        }
      })
    : null;
  const googleSheetsOverview = overviewWorkbookFile
    ? createGoogleSheetsOverviewManager({
        workbookFilePath: overviewWorkbookFile,
        stateFilePath: overviewGoogleSheetStateFile,
        onUpdated: () => scheduleChange('overview-google-sheet')
      })
    : null;
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
          if (fileNames.has(path.basename(paymentLabelsFile))) {
            lastBaseData = null;
            cachedDashboardData = null;
          }
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
          if (fileName === path.basename(paymentLabelsFile)) {
            lastBaseData = null;
            cachedDashboardData = null;
          }
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
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

    if (requestUrl.pathname.startsWith('/api/viewer/auth/')) {
      if (req.method === 'GET' && requestUrl.pathname === '/api/viewer/auth/status') {
        try {
          sendJson(res, 200, viewerAuthManager.status(req));
        } catch (error) {
          console.error('[Admin Dashboard] Could not read viewer authentication state:', error.message);
          sendJson(res, 500, { error: 'Could not read viewer authentication state.' });
        }
        return;
      }

      if (req.method === 'POST' &&
          ['/api/viewer/auth/setup', '/api/viewer/auth/login', '/api/viewer/auth/logout'].includes(requestUrl.pathname)) {
        const isSetup = requestUrl.pathname === '/api/viewer/auth/setup';
        if (isSetup && !isSameOriginLoopbackRequest(req)) {
          sendJson(res, 403, { error: 'Viewer access can only be set up from this local dashboard.' });
          return;
        }
        if (!isSetup && !isSameOriginDashboardRequest(req)) {
          sendJson(res, 403, { error: 'Viewer authentication must come from this dashboard.' });
          return;
        }
        if (isSetup && !authManager.isAuthenticated(req)) {
          sendJson(res, 401, { error: 'Sign in to the local admin dashboard before setting up viewer access.' });
          return;
        }

        if (requestUrl.pathname === '/api/viewer/auth/logout') {
          viewerAuthManager.logout(req);
          viewerAuthManager.clearCookie(res, new URL(req.headers.origin).protocol === 'https:');
          sendJson(res, 200, { authenticated: false });
          return;
        }

        readRequestBody(req).then(async body => {
          if (isSetup) {
            if (body.password !== body.confirmPassword) {
              sendJson(res, 400, { error: 'The passwords do not match.' });
              return;
            }
            const result = await viewerAuthManager.setup(body.password);
            sendJson(res, result.ok ? 201 : result.status, result.ok ? { configured: true } : { error: result.error });
            return;
          }

          if (!viewerAuthManager.isConfigured()) {
            sendJson(res, 409, { error: 'Viewer access has not been set up on the local dashboard yet.' });
            return;
          }
          const result = await viewerAuthManager.login(req, body.password);
          if (!result.ok) {
            if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
            sendJson(res, result.status, { error: result.error });
            return;
          }
          const secure = new URL(req.headers.origin).protocol === 'https:';
          viewerAuthManager.setCookie(res, result.token, result.maxAge, secure);
          sendJson(res, 200, { authenticated: true });
        }).catch(error => {
          console.error('[Admin Dashboard] Could not process viewer authentication:', error.message);
          sendJson(res, 500, { error: 'Could not process viewer authentication.' });
        });
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const isAdminApi = requestUrl.pathname.startsWith('/api/admin/');
    const isAdminAuthenticated = authManager.isAuthenticated(req);
    const isViewerReadRequest = req.method === 'GET' && viewerAuthManager.isAuthenticated(req);
    if (isAdminApi && !isAdminAuthenticated && !isViewerReadRequest) {
      sendJson(res, 401, { error: 'Dashboard login required.' });
      return;
    }

    if (isAdminApi &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
        (!isAdminAuthenticated || !isSameOriginLoopbackRequest(req))) {
      sendJson(res, 403, {
        error: 'State-changing dashboard requests require a local admin session.'
      });
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

    if (req.method === 'GET' &&
        ['/api/admin/telegram-overview', '/api/admin/telegram-progress'].includes(requestUrl.pathname)) {
      const timeZone = requestUrl.searchParams.get('timeZone') || 'UTC';
      try {
        new Intl.DateTimeFormat('en-US', { timeZone });
      } catch {
        sendJson(res, 400, { error: 'A valid time zone is required.' });
        return;
      }

      try {
        const now = Date.now();
        const dateParameter = requestUrl.pathname === '/api/admin/telegram-progress'
          ? 'trendEndDate'
          : 'endDate';
        const requestedEndDate = requestUrl.searchParams.get(dateParameter);
        const requestedEnrollmentEndDate =
          requestUrl.pathname === '/api/admin/telegram-progress'
            ? requestUrl.searchParams.get('enrollmentEndDate')
            : null;
        const today = calendarDateKey(now, timeZone);
        if (requestedEndDate &&
            (!isValidCalendarDateKey(requestedEndDate) || requestedEndDate > today)) {
          sendJson(res, 400, { error: 'A valid past or current end date is required.' });
          return;
        }
        if (requestedEnrollmentEndDate &&
            (!isValidCalendarDateKey(requestedEnrollmentEndDate) ||
              requestedEnrollmentEndDate > today)) {
          sendJson(res, 400, { error: 'A valid past or current enrollment end date is required.' });
          return;
        }
        const progress = getTelegramProgressSnapshot(
          timeZone,
          now,
          requestUrl.pathname === '/api/admin/telegram-progress',
          requestUrl.pathname === '/api/admin/telegram-progress' ? requestedEndDate : null,
          requestUrl.pathname === '/api/admin/telegram-progress'
            ? requestedEnrollmentEndDate
            : null
        );
        if (requestUrl.pathname === '/api/admin/telegram-progress') {
          sendJson(res, 200, progress);
          return;
        }

        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const uniqueTelegramRecords = getTelegramUniqueStudentRecords(telegramProgress);
        const uniqueStudentKeys = new Set(uniqueTelegramRecords.map(({ student }) =>
          `telegram:${student.telegramChatId}:${student.telegramUserId}`));
        const uniqueStudents = progress.students.filter(student => uniqueStudentKeys.has(student.jid));
        const lessons = readJsonFile(lessonsFile);
        const lessonCounts = Object.values(lessons)
          .reduce((count, grade) => count + (Array.isArray(grade.lessons) ? grade.lessons.length : 0), 0);
        const telegramGenderStatistics = uniqueStudents.reduce((counts, student) => {
          const gender = ['female', 'male'].includes(student.gender?.value)
            ? student.gender.value
            : 'unknown';
          counts[gender] += 1;
          return counts;
        }, { female: 0, male: 0, unknown: 0 });
        const telegramClasses = getTelegramClassStatistics(
          telegramProgress,
          lessons,
          telegramGroupGrades,
          now,
          timeZone,
          requestedEndDate
        );
        const sumClassStatistics = key => telegramClasses.reduce((total, classStats) =>
          total + classStats[key], 0);
        sendJson(res, 200, {
          telegramStudents: uniqueStudents.length,
          telegramGenderStatistics,
          telegramLessonsCompleted: sumClassStatistics('lessonsCompleted'),
          telegramLessonCompletionsLast7Days: sumClassStatistics('lessonCompletionsLast7Days'),
          telegramJoinedToday: sumClassStatistics('joinedToday'),
          telegramJoinedLast7Days: sumClassStatistics('joinedLast7Days'),
          awaitingTask: sumClassStatistics('awaitingTask'),
          awaitingReattempt: sumClassStatistics('awaitingReattempt'),
          completed: sumClassStatistics('completed'),
          configuredLessons: lessonCounts,
          telegramClasses
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load Telegram dashboard data:', error.message);
        sendJson(res, 500, { error: 'Could not load Telegram dashboard data.' });
      }
      return;
    }

    if (req.method === 'GET' &&
        requestUrl.pathname === '/api/admin/telegram-student-chat') {
      const studentKey = requestUrl.searchParams.get('studentKey') || '';
      if (!/^telegram:-?\d+:\d+$/.test(studentKey)) {
        sendJson(res, 400, { error: 'A valid Telegram student is required.' });
        return;
      }
      try {
        const progress = readJsonFileOr(telegramProgressFile, {});
        const student = progress[studentKey];
        if (!student ||
            studentKey !== `telegram:${student.telegramChatId}:${student.telegramUserId}`) {
          sendJson(res, 404, { error: 'Telegram student was not found.' });
          return;
        }
        const agentMessages = Array.isArray(student.telegramChatHistory)
          ? student.telegramChatHistory
          : [];
        const dashboardReplies = readJsonFileOr(telegramDashboardChatRepliesFile, {})[studentKey] || [];
        const latestStudentMessage = student.lastStudentMessage;
        const hasLatestStudentMessage = typeof latestStudentMessage?.text === 'string' &&
          Number.isFinite(Date.parse(latestStudentMessage.receivedAt || '')) &&
          !agentMessages.some(message =>
            message?.role === 'student' &&
            message.text === latestStudentMessage.text &&
            Math.abs(Date.parse(message.timestamp || '') -
              Date.parse(latestStudentMessage.receivedAt)) <= 60_000);
        const messages = [
          ...agentMessages,
          ...dashboardReplies,
          ...(hasLatestStudentMessage ? [{
            role: 'student',
            text: latestStudentMessage.text,
            timestamp: latestStudentMessage.receivedAt
          }] : [])
        ]
          .filter(message =>
            ['student', 'bot'].includes(message?.role) &&
            typeof message.text === 'string' &&
            Number.isFinite(Date.parse(message.timestamp || '')))
          .map(message => ({
            role: message.role,
            text: message.text.slice(0, 4096),
            timestamp: message.timestamp
          }))
          .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
          .slice(-200);
        const telegramBotBlocked = isTelegramPrivateChatBlocked(
          student.telegramPrivateChatId,
          telegramBlockedRecipientsFile
        );
        sendJson(res, 200, {
          student: {
            jid: studentKey,
            name: student.name || (student.telegramUsername ? `@${student.telegramUsername}` : 'Telegram student'),
            lastStudentActivityAt: Number.isFinite(Date.parse(
              student.lastActivityAt || student.lastStudentMessage?.receivedAt || ''
            ))
              ? Date.parse(student.lastActivityAt || student.lastStudentMessage?.receivedAt || '')
              : null,
            telegramBotBlocked,
            canReplyPrivately: typeof student.telegramPrivateChatId === 'string' &&
              Boolean(student.telegramPrivateChatId.trim()) &&
              !telegramBotBlocked
          },
          messages
        });
      } catch (error) {
        console.error(`[Admin Dashboard] Could not load Telegram chat for ${studentKey}:`, error.message);
        sendJson(res, 500, { error: 'Could not load the Telegram student chat.' });
      }
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/telegram-student-chat-read') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Student chat read updates must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const studentKey = body.studentKey;
        const readThrough = Date.parse(body.readThrough || '');
        if (typeof studentKey !== 'string' || !/^telegram:-?\d+:\d+$/.test(studentKey) ||
            !Number.isFinite(readThrough)) {
          sendJson(res, 400, { error: 'A valid Telegram student and read timestamp are required.' });
          return;
        }
        const progress = readJsonFileOr(telegramProgressFile, {});
        const student = progress[studentKey];
        if (!student ||
            studentKey !== `telegram:${student.telegramChatId}:${student.telegramUserId}`) {
          sendJson(res, 404, { error: 'Telegram student was not found.' });
          return;
        }
        const latestStudentMessageAt = Math.max(
          Date.parse(student.lastStudentMessage?.receivedAt || '') || 0,
          ...(Array.isArray(student.telegramChatHistory)
            ? student.telegramChatHistory
              .filter(message => message?.role === 'student')
              .map(message => Date.parse(message.timestamp || '') || 0)
            : [0])
        );
        if (readThrough > latestStudentMessageAt) {
          sendJson(res, 400, { error: 'The read timestamp is newer than the latest saved student message.' });
          return;
        }
        const readState = chatReadState.read();
        readState[studentKey] = Math.max(Number(readState[studentKey] || 0), readThrough);
        chatReadState.write(readState);
        scheduleChange(path.basename(chatReadStateFile));
        sendJson(res, 200, { studentKey, readAt: readState[studentKey] });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not mark Telegram student chat as read:', error.message);
        sendJson(res, 500, { error: 'Could not mark the Telegram student chat as read.' });
      });
      return;
    }

    if (req.method === 'GET' &&
        requestUrl.pathname === '/api/admin/telegram-leaderboard') {
      try {
        const period = requestUrl.searchParams.get('period') || 'weekly';
        const leaderboard = getLessonLeaderboard(
          readJsonFileOr(telegramProgressFile, {}),
          Date.now(),
          period
        );
        const preview = { ...leaderboard };
        delete preview.messageEntities;
        sendJson(res, 200, {
          ...preview,
          groupConfigured: Boolean(telegramGroupId),
          botConfigured: Boolean(telegramLeaderboardNotifier || process.env.TELEGRAM_BOT_TOKEN?.trim())
        });
      } catch (error) {
        const invalidPeriod = requestUrl.searchParams.has('period') &&
          !['daily', 'weekly'].includes(requestUrl.searchParams.get('period'));
        if (invalidPeriod) {
          sendJson(res, 400, { error: 'Leaderboard period must be daily or weekly.' });
          return;
        }
        console.error('[Admin Dashboard] Could not build the Telegram leaderboard:', error.message);
        sendJson(res, 500, { error: 'Could not load the Telegram leaderboard.' });
      }
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/telegram-leaderboard') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'The leaderboard can only be shared from this local dashboard.' });
        return;
      }
      const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
      if (!telegramGroupId || (!telegramLeaderboardNotifier && !botToken)) {
        sendJson(res, 503, { error: 'Configure TELEGRAM_BOT_TOKEN and TELEGRAM_GROUP_ID before sharing the leaderboard.' });
        return;
      }
      void (async () => {
        try {
          const period = requestUrl.searchParams.get('period') || 'weekly';
          if (!['daily', 'weekly'].includes(period)) {
            sendJson(res, 400, { error: 'Leaderboard period must be daily or weekly.' });
            return;
          }
          const leaderboard = getLessonLeaderboard(
            readJsonFileOr(telegramProgressFile, {}),
            Date.now(),
            period
          );
          if (!leaderboard.students.length) {
            sendJson(res, 409, {
              error: period === 'daily'
                ? 'No students have completed a lesson today yet.'
                : 'No students have completed a lesson this week yet.'
            });
            return;
          }
          if (telegramLeaderboardNotifier) {
            await telegramLeaderboardNotifier(
              String(telegramGroupId),
              leaderboard.message,
              leaderboard.messageEntities
            );
          } else {
            const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                chat_id: String(telegramGroupId),
                text: leaderboard.message,
                entities: leaderboard.messageEntities
              }),
              signal: AbortSignal.timeout(10_000)
            });
            const result = await response.json();
            if (!response.ok || result?.ok !== true) {
              throw new Error(result?.description || 'Telegram rejected the message.');
            }
          }
          sendJson(res, 200, {
            sent: true,
            studentsCount: leaderboard.students.length,
            period: leaderboard.period,
            date: leaderboard.date,
            weekStart: leaderboard.weekStart,
            weekEnd: leaderboard.weekEnd
          });
        } catch (error) {
          console.error('[Admin Dashboard] Could not share the Telegram leaderboard:', error.message);
          sendJson(res, 502, { error: 'Telegram could not deliver the leaderboard.' });
        }
      })();
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/telegram-stats') {
      const timeZone = requestUrl.searchParams.get('timeZone') || 'UTC';
      try {
        new Intl.DateTimeFormat('en-US', { timeZone });
      } catch {
        sendJson(res, 400, { error: 'A valid time zone is required.' });
        return;
      }

      const now = Date.now();
      const today = calendarDateKey(now, timeZone);
      const requestedEndDate = requestUrl.searchParams.get('endDate') || today;
      if (!isValidCalendarDateKey(requestedEndDate) || requestedEndDate > today) {
        sendJson(res, 400, { error: 'A valid past or current end date is required.' });
        return;
      }

      try {
        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const uniqueTelegramRecords = getTelegramUniqueStudentRecords(telegramProgress);
        const telegramAccountState = readJsonFileOr(telegramUserBroadcastFiles.state, {});
        const onlineCountUpdatedAt = Date.parse(
          telegramAccountState.onlineGroupMembersUpdatedAt || ''
        );
        const onlineCountIsFresh = Number.isSafeInteger(
          telegramAccountState.onlineGroupMembersCount
        ) && telegramAccountState.onlineGroupMembersCount >= 0 &&
          Number.isFinite(onlineCountUpdatedAt) &&
          now >= onlineCountUpdatedAt &&
          now - onlineCountUpdatedAt <= TELEGRAM_PRESENCE_MAX_AGE_MS;
        getTelegramGroupMemberCount().then(async memberCount => {
          const groupMemberHistory = telegramGroupMemberHistoryFile
            ? await readTelegramGroupMemberHistory(telegramGroupMemberHistoryFile)
            : [];
          const activeByDate = new Map();
          for (const { student } of uniqueTelegramRecords) {
            const activeDates = new Set(telegramActivityTimestamps(student)
              .filter(timestamp => timestamp <= now)
              .map(timestamp => calendarDateKey(timestamp, timeZone)));
            for (const date of activeDates) {
              activeByDate.set(date, (activeByDate.get(date) || 0) + 1);
            }
          }
          const joinsByDate = new Map();
          for (const student of Object.values(telegramProgress)) {
            const joinedAt = Date.parse(student?.groupJoinedAt || '');
            if (!Number.isFinite(joinedAt) || joinedAt > now) continue;
            const date = calendarDateKey(joinedAt, timeZone);
            joinsByDate.set(date, (joinsByDate.get(date) || 0) + 1);
          }
          const dailyStats = getCalendarDatesEndingAt(requestedEndDate, 30).map(date => ({
            date,
            joins: joinsByDate.get(date) || 0,
            activeLearners: activeByDate.get(date) || 0
          }));
          const joinsLast7Days = getRecentCalendarDates(now, 7, timeZone)
            .reduce((total, date) => total + (joinsByDate.get(date) || 0), 0);
          sendJson(res, 200, {
            totalGroupMembers: memberCount.count,
            memberCountUpdatedAt: memberCount.updatedAt,
            memberCountStatus: memberCount.count === null
              ? process.env.TELEGRAM_BOT_TOKEN?.trim() && telegramGroupId
                ? 'unavailable'
                : 'not_configured'
              : 'available',
            onlineGroupMembers: onlineCountIsFresh
              ? telegramAccountState.onlineGroupMembersCount
              : null,
            onlineGroupMembersUpdatedAt: Number.isFinite(onlineCountUpdatedAt)
              ? telegramAccountState.onlineGroupMembersUpdatedAt
              : null,
            onlineGroupMembersStatus: onlineCountIsFresh
              ? 'available'
              : Number.isFinite(onlineCountUpdatedAt) ? 'stale' : 'unavailable',
            trackedLearners: uniqueTelegramRecords.length,
            joinsToday: joinsByDate.get(today) || 0,
            joinsLast7Days,
            periodStart: dailyStats[0].date,
            periodEnd: requestedEndDate,
            groupMemberHistory,
            dailyStats
          });
        }).catch(error => {
          console.error('[Admin Dashboard] Could not load Telegram statistics:', error.message);
          sendJson(res, 500, { error: 'Could not load Telegram statistics.' });
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load Telegram statistics:', error.message);
        sendJson(res, 500, { error: 'Could not load Telegram statistics.' });
      }
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

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/telegram-chat-queue') {
      try {
        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const adminActions = lessonSkipQueues.Telegram.read()
          .filter(request => ['queued', 'processing'].includes(request.status))
          .map((request, index) => {
            const student = telegramProgress[request.studentKey] || {};
            const name = student.name ||
              (student.telegramUsername ? `@${student.telegramUsername}` : `Telegram user ${request.userId || ''}`);
            const action = request.requestType === 'send_lesson'
              ? `Send ${request.nextLessonTitle || request.nextLessonId}`
              : request.requestType === 'skip_next' || !request.requestType
                ? `Skip to ${request.nextLessonTitle || request.nextLessonId}`
                : request.nextLessonTitle || request.requestType;
            return {
              id: request.id,
              name: name.trim() || 'Telegram user',
              action,
              status: request.status,
              position: index + 1,
              queuedAt: request.createdAt,
              ...(request.status === 'processing' ? { startedAt: request.updatedAt } : {})
            };
          });
        const updateQueue = readTelegramUpdateQueue(
          telegramUpdateQueueFile,
          telegramAgentControlFile
        );
        sendJson(res, 200, {
          ...updateQueue,
          adminActions
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not read the Telegram update queue:', error.message);
        sendJson(res, 500, { error: 'Could not read the Telegram update queue.' });
      }
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/telegram-chat-queue-mode') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Telegram queue controls must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(async body => {
        if (typeof body?.paused !== 'boolean') {
          sendJson(res, 400, { error: 'A boolean paused value is required.' });
          return;
        }
        const status = readJsonFileOr(telegramAgentStatusFile, null);
        if (status?.connectionState !== 'connected') {
          sendJson(res, 409, { error: 'Connect the Telegram bot before changing queue handling.' });
          return;
        }
        const control = setTelegramUpdateQueuePaused(body.paused, telegramAgentControlFile);
        sendJson(res, 202, { status: body.paused ? 'pausing_queue' : 'resuming_queue', ...control });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not change Telegram queue handling:', error.message);
        sendJson(res, 500, { error: 'Could not change Telegram queue handling.' });
      });
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

    if (req.method === 'GET' && requestUrl.pathname === '/favicon.svg') {
      const faviconPath = path.join(ROOT_DIR, 'public', 'favicon.svg');
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      });
      fs.createReadStream(faviconPath).pipe(res);
      return;
    }

    if (req.method === 'GET' &&
        ['/', '/admin', '/viewer'].includes(requestUrl.pathname)) {
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

    if (req.method === 'DELETE' && requestUrl.pathname === '/api/admin/curriculum/video') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Media can only be deleted from this local dashboard.' });
        return;
      }
      try {
        const result = deleteUnusedLessonVideo({
          gradeKey: requestUrl.searchParams.get('gradeKey'),
          relativePath: requestUrl.searchParams.get('relativePath'),
          filePath: lessonsFile,
          mediaDir: lessonMediaDirectory
        });
        scheduleChange(path.basename(lessonsFile));
        sendJson(res, 200, result);
      } catch (error) {
        console.error('[Admin Dashboard] Could not delete unused lesson video:', error.message);
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/curriculum/generate-answer-key') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Answer keys can only be generated from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(async body => {
        if (typeof body?.taskMessage !== 'string' ||
            (typeof body?.notes !== 'undefined' && typeof body.notes !== 'string')) {
          sendJson(res, 400, { error: 'Lesson questions and optional supporting notes are required.' });
          return;
        }
        if (!body.taskMessage.trim() || body.taskMessage.length > 12_000 ||
            (body.notes || '').length > 8_000) {
          sendJson(res, 400, { error: 'Questions must be 1-12,000 characters; supporting notes may be up to 8,000 characters.' });
          return;
        }
        try {
          sendJson(res, 200, await generateAnswerKey(body.taskMessage, body.notes || ''));
        } catch (error) {
          console.error('[Admin Dashboard] Could not generate a lesson answer key:', error.message);
          sendJson(res, 502, { error: error.message });
        }
      }).catch(error => {
        console.error('[Admin Dashboard] Could not read an answer-key request:', error.message);
        const invalidInput = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.';
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput ? error.message : 'Could not process the answer-key request.'
        });
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
          sourceGradeKey: typeof body.sourceGradeKey === 'string' ? body.sourceGradeKey : body.gradeKey,
          sourceType: typeof body.sourceType === 'string' ? body.sourceType : null,
          sourceLessonId: typeof body.sourceLessonId === 'string' ? body.sourceLessonId : null,
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
        lastBaseData = null;
        cachedDashboardData = null;
        scheduleChange(path.basename(paymentLabelsFile));
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

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/telegram-user-broadcasts') {
      try {
        const progress = readJsonFileOr(telegramProgressFile, {});
        const optedInStudents = Object.values(progress)
          .filter(student => isTelegramAnnouncementRecipient(student, telegramGroupId));
        const recipientOffset = Number(requestUrl.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(recipientOffset) || recipientOffset < 0) {
          sendJson(res, 400, { error: 'Recipient offset must be a non-negative integer.' });
          return;
        }
        const requests = readJsonFileOr(telegramUserBroadcastFiles.requests, []);
        const state = readJsonFileOr(telegramUserBroadcastFiles.state, { jobs: {} });
        if (!Array.isArray(requests) || !state?.jobs || typeof state.jobs !== 'object') {
          throw new Error('Invalid Telegram account broadcast data.');
        }
        const groupRoster = Array.isArray(state.groupRoster)
          ? state.groupRoster.filter(member =>
            member && typeof member === 'object' &&
            (typeof member.userId === 'string' || Number.isSafeInteger(member.userId)))
          : [];
        const privateChatUserIds = getTelegramPrivateChatUserIds(progress, telegramGroupId);
        const audienceVersion = getTelegramGroupAudienceVersion(groupRoster, privateChatUserIds);
        const audienceFilter = requestUrl.searchParams.get('filter') || 'all';
        if (!['all', 'not-messaged-privately', 'online-only'].includes(audienceFilter)) {
          sendJson(res, 400, { error: 'Choose a supported group member filter.' });
          return;
        }
        const joinDateFilters = getTelegramJoinDateFilters({
          joinedAfter: requestUrl.searchParams.get('joinedAfter') || '',
          joinedBefore: requestUrl.searchParams.get('joinedBefore') || '',
          timeZone: requestUrl.searchParams.get('timeZone') || 'UTC'
        });
        if (joinDateFilters.error) {
          sendJson(res, 400, { error: joinDateFilters.error });
          return;
        }
        const audienceFilteredGroupRoster = groupRoster
          .map(member => ({
            ...member,
            hasPrivateChat: privateChatUserIds.has(String(member.userId))
          }))
          .filter(member =>
            (audienceFilter !== 'not-messaged-privately' || !member.hasPrivateChat) &&
            (audienceFilter !== 'online-only' || member.presence === 'online'));
        const filteredGroupRoster = filterTelegramGroupRosterByJoinDate(
          audienceFilteredGroupRoster,
          joinDateFilters
        );
        const unknownGroupJoinDateCount =
          audienceFilteredGroupRoster.length -
          audienceFilteredGroupRoster.filter(member =>
            Number.isFinite(Date.parse(member.joinedAt || ''))).length;
        const heartbeat = Date.parse(state.worker?.lastHeartbeatAt || '');
        const workerConnected = state.worker?.connected === true &&
          Number.isFinite(heartbeat) && Date.now() - heartbeat < 30_000;
        const detailedJobId = requestUrl.searchParams.get('jobId');
        const recentRequests = requests.slice(-20).reverse();
        if (detailedJobId && !recentRequests.some(request => request.id === detailedJobId)) {
          sendJson(res, 404, { error: 'Telegram broadcast not found in recent announcements.' });
          return;
        }
        const jobs = recentRequests.map(request => {
          const jobState = state.jobs[request.id] || {
            status: request.cancelled ? 'cancelled' : 'needs_review',
            total: request.recipients.length,
            sent: 0,
            skipped: 0,
            uncertain: 0
          };
          const job = {
            id: request.id,
            status: request.cancelled
              ? ['running', 'cancellation_requested'].includes(jobState.status)
                ? 'cancellation_requested'
                : 'cancelled'
              : jobState.status,
            total: jobState.total,
            sent: jobState.sent,
            skipped: jobState.skipped,
            uncertain: jobState.uncertain,
            createdAt: request.createdAt,
            completedAt: jobState.completedAt || null,
            retryAt: jobState.retryAt || null,
            error: jobState.error || null
          };
          if (request.id === detailedJobId) {
            const recipientResults = Array.isArray(jobState.recipientResults)
              ? jobState.recipientResults
              : [];
            const resultByIndex = new Map();
            for (const result of recipientResults) {
              if (!Number.isSafeInteger(result?.index) ||
                  result.index < 0 ||
                  result.index >= request.recipients.length ||
                  String(request.recipients[result.index]?.userId) !== String(result.userId) ||
                  !['sent', 'skipped', 'uncertain'].includes(result.status)) continue;
              resultByIndex.set(result.index, {
                index: result.index,
                userId: String(result.userId),
                name: typeof result.name === 'string' && result.name.trim()
                  ? result.name.trim()
                  : request.recipients[result.index].name ||
                    `Telegram user ${result.userId}`,
                ...(typeof result.reason === 'string' && result.reason
                  ? { reason: result.reason }
                  : {}),
                status: result.status
              });
            }
            const uncertainCount = Number.isSafeInteger(jobState.uncertain) ? jobState.uncertain : 0;
            const recordedUncertain = [...resultByIndex.values()]
              .filter(result => result.status === 'uncertain').length;
            if (jobState.status === 'failed' &&
                recordedUncertain < uncertainCount &&
                Number.isSafeInteger(jobState.nextIndex) &&
                jobState.nextIndex >= 0 &&
                jobState.nextIndex < request.recipients.length) {
              const index = jobState.nextIndex;
              const recipient = request.recipients[index];
              resultByIndex.set(index, {
                index,
                userId: String(recipient.userId),
                name: recipient.name || `Telegram user ${recipient.userId}`,
                ...(jobState.error ? { reason: jobState.error } : {}),
                status: 'uncertain'
              });
            }
            const sentCount = Number.isSafeInteger(jobState.sent) ? jobState.sent : 0;
            const skippedCount = Number.isSafeInteger(jobState.skipped) ? jobState.skipped : 0;
            if (resultByIndex.size === 0 &&
                skippedCount === 0 &&
                sentCount > 0 &&
                Number.isSafeInteger(jobState.nextIndex) &&
                sentCount <= jobState.nextIndex) {
              for (let index = 0; index < sentCount; index += 1) {
                const recipient = request.recipients[index];
                resultByIndex.set(index, {
                  index,
                  userId: String(recipient.userId),
                  name: typeof recipient.name === 'string' && recipient.name.trim()
                    ? recipient.name.trim()
                    : `Telegram user ${recipient.userId}`,
                  status: 'sent'
                });
              }
            }
            const results = [...resultByIndex.values()];
            const outcomes = {
              sent: results.filter(result => result.status === 'sent'),
              skipped: results.filter(result => result.status === 'skipped'),
              uncertain: results.filter(result => result.status === 'uncertain'),
              remaining: request.recipients
                .map((recipient, index) => ({ recipient, index }))
                .filter(({ index }) =>
                  index >= (Number.isSafeInteger(jobState.nextIndex) ? jobState.nextIndex : 0) &&
                  !resultByIndex.has(index))
                .map(({ recipient, index }) => ({
                  index,
                  userId: String(recipient.userId),
                  name: typeof recipient.name === 'string' && recipient.name.trim()
                    ? recipient.name.trim()
                    : `Telegram user ${recipient.userId}`,
                  status: 'remaining'
                }))
            };
            const recipientDetailsComplete =
              outcomes.sent.length === sentCount &&
              outcomes.skipped.length === skippedCount &&
              outcomes.uncertain.length === uncertainCount;
            job.recipientOutcomes = outcomes;
            job.recipientDetailsComplete = recipientDetailsComplete;
          }
          return job;
        });
        sendJson(res, 200, {
          optedInCount: optedInStudents.length,
          ...(requestUrl.searchParams.get('audience') === 'group-members' ? {
            groupMemberCount: filteredGroupRoster.length,
            allGroupMemberCount: groupRoster.length,
            groupRosterSyncedAt: state.groupRosterSyncedAt || null,
            groupRosterUpdatedAt: state.groupRosterUpdatedAt || null,
            groupAudienceVersion: audienceVersion,
            groupAudienceFilter: audienceFilter,
            joinedAfter: joinDateFilters.joinedAfter || null,
            joinedBefore: joinDateFilters.joinedBefore || null,
            unknownGroupJoinDateCount,
            ...(requestUrl.searchParams.get('includeStudents') === 'true' ? {
              groupMembers: filteredGroupRoster
                .slice(recipientOffset, recipientOffset + 30)
                .map(member => ({
                  userId: String(member.userId),
                  name: typeof member.name === 'string' && member.name.trim()
                    ? member.name
                    : `Telegram user ${member.userId}`,
                  username: typeof member.username === 'string' ? member.username : null,
                  hasPrivateChat: member.hasPrivateChat,
                  joinedAt: typeof member.joinedAt === 'string' ? member.joinedAt : null
                })),
              groupMemberOffset: recipientOffset
            } : {})
          } : {}),
          ...(requestUrl.searchParams.get('includeStudents') === 'true' ? {
            optedInStudents: optedInStudents.slice(recipientOffset, recipientOffset + 30).map(student => ({
              userId: String(student.telegramUserId),
              name: student.name || student.telegramUsername || `Telegram user ${student.telegramUserId}`,
              optedInAt: student.telegramAnnouncementsOptInAt || null,
              lessonsCompleted: Number.isSafeInteger(student.lessonsCompleted) && student.lessonsCompleted > 0
                ? student.lessonsCompleted
                : 0
            })),
            optedInOffset: recipientOffset
          } : {}),
          workerConnected,
          workerError: state.worker?.error || null,
          jobs
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load Telegram account broadcasts:', error.message);
        sendJson(res, 500, { error: 'Could not load Telegram account broadcasts.' });
      }
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/telegram-user-broadcasts') {
      handleTelegramUserBroadcastPost(
        req,
        res,
        telegramProgressFile,
        telegramUserBroadcastFiles,
        telegramGroupId
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

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/telegram-agent-status') {
      try {
        const status = readJsonFileOr(telegramAgentStatusFile, null);
        sendJson(res, 200, getDashboardTelegramAgentStatus(status));
      } catch (error) {
        console.error('[Admin Dashboard] Could not load Telegram agent status:', error.message);
        sendJson(res, 500, { error: 'Could not read Telegram agent status.' });
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

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/agent-history') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'History restore requests must come from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const status = readJsonFileOr(agentStatusFile, null);
        const heartbeatAt = Date.parse(status?.updatedAt || '');
        if (status?.connectionState !== 'connected' ||
            !Number.isFinite(heartbeatAt) ||
            Date.now() - heartbeatAt > AGENT_HEARTBEAT_MAX_AGE_MS) {
          sendJson(res, 409, { error: 'The WhatsApp agent must be connected to restore chat history.' });
          return;
        }

        const request = requestAgentHistorySync(
          body?.jid,
          body?.messageKey,
          body?.timestamp,
          agentControlFile
        );
        sendJson(res, 202, {
          status: 'requested',
          jid: request.jid,
          requestedAt: request.requestedAt
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not request older WhatsApp chat history:', error.message);
        const status = error instanceof TypeError ? 400 : 500;
        sendJson(res, status, {
          error: status === 400
            ? error.message
            : 'Could not request older WhatsApp chat history.'
        });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/agent-connect') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Agent controls must come from this local dashboard.' });
        return;
      }
      try {
        if (launchedAgent && launchedAgent.exitCode === null) {
          sendJson(res, 409, { error: 'The WhatsApp agent is already starting.' });
          return;
        }

        const status = readJsonFileOr(agentStatusFile, null);
        const currentStatus = getDashboardAgentStatus(status, 0);
        if (['connected', 'connecting'].includes(currentStatus.connectionState)) {
          sendJson(res, 409, { error: 'The WhatsApp agent is already running.' });
          return;
        }

        if (currentStatus.lastHeartbeatAt) {
          const heartbeatAge = Date.now() - Date.parse(currentStatus.lastHeartbeatAt);
          if (heartbeatAge >= 0 && heartbeatAge <= AGENT_HEARTBEAT_MAX_AGE_MS) {
            const processId = Number.isSafeInteger(status?.processId) && status.processId > 0
              ? status.processId
              : null;
            if (!processId) {
              sendJson(res, 409, { error: 'The WhatsApp agent is still shutting down.' });
              return;
            }
            try {
              process.kill(processId, 0);
              sendJson(res, 409, { error: 'The WhatsApp agent is still shutting down.' });
              return;
            } catch (error) {
              if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
              if (error.code === 'EPERM') {
                sendJson(res, 409, { error: 'The WhatsApp agent is still running.' });
                return;
              }
            }
          }
        }

        const child = launchAgent();
        launchedAgent = child;
        child.once('error', error => {
          if (launchedAgent === child) launchedAgent = null;
          console.error('[Admin Dashboard] Could not start the WhatsApp agent:', error.message);
        });
        child.once('exit', () => {
          if (launchedAgent === child) launchedAgent = null;
        });
        child.unref();
        sendJson(res, 202, { status: 'connecting', processId: child.pid });
      } catch (error) {
        console.error('[Admin Dashboard] Could not start the WhatsApp agent:', error.message);
        sendJson(res, 500, { error: 'Could not start the WhatsApp agent.' });
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

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/telegram-agent-logs') {
      try {
        const limitValue = requestUrl.searchParams.get('limit') || '250';
        if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 500) {
          sendJson(res, 400, { error: 'Log line limit must be between 1 and 500.' });
          return;
        }
        sendJson(res, 200, readRecentAgentLogs(telegramAgentLogFile, Number(limitValue)));
      } catch (error) {
        console.error('[Admin Dashboard] Could not load Telegram agent logs:', error.message);
        sendJson(res, 500, { error: 'Could not read Telegram agent logs.' });
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

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/telegram-agent-media') {
      try {
        const lessonsConfig = readJsonFile(lessonsFile);
        const activities = readAgentMediaActivities(telegramAgentMediaActivityFile).map(activity => {
          const lesson = lessonsConfig?.[activity.grade]?.lessons?.find(item =>
            item?.id === activity.lessonId);
          return {
            ...activity,
            retryAvailable: activity.platform === 'Telegram' &&
              typeof activity.studentKey === 'string' &&
              typeof activity.videoFile === 'string' &&
              lesson?.videoFile === activity.videoFile
          };
        });
        sendJson(res, 200, { activities });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load Telegram media activity:', error.message);
        sendJson(res, 500, { error: 'Could not read Telegram media activity.' });
      }
      return;
    }

    const retryTelegramMediaMatch =
      /^\/api\/admin\/telegram-agent-media\/([\w-]+)\/retry$/.exec(requestUrl.pathname);
    if (req.method === 'POST' && retryTelegramMediaMatch) {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Telegram media retries must come from this local dashboard.' });
        return;
      }
      try {
        const status = readJsonFileOr(telegramAgentStatusFile, null);
        if (status?.connectionState !== 'connected') {
          sendJson(res, 409, { error: 'Connect the Telegram bot before retrying this video.' });
          return;
        }
        const activityId = retryTelegramMediaMatch[1];
        const activity = readAgentMediaActivities(telegramAgentMediaActivityFile)
          .find(item => item.id === activityId);
        if (!activity || activity.status !== 'failed' || activity.platform !== 'Telegram') {
          sendJson(res, 409, { error: 'Only failed Telegram video uploads can be retried.' });
          return;
        }
        if (typeof activity.lessonId !== 'string' ||
            typeof activity.grade !== 'string' ||
            typeof activity.studentKey !== 'string' ||
            typeof activity.videoFile !== 'string') {
          sendJson(res, 409, { error: 'The Telegram lesson video source could not be identified for retry.' });
          return;
        }
        const student = readJsonFileOr(telegramProgressFile, {})[activity.studentKey];
        if (!student?.telegramPrivateChatId ||
            String(student.telegramPrivateChatId) !== String(activity.recipientJid)) {
          sendJson(res, 409, {
            error: 'The student must start a private chat with the bot before this lesson video can be retried.'
          });
          return;
        }
        const lesson = readJsonFile(lessonsFile)?.[activity.grade]?.lessons?.find(item =>
          item?.id === activity.lessonId);
        if (lesson?.videoFile !== activity.videoFile) {
          sendJson(res, 409, { error: 'The Telegram lesson video source could not be identified for retry.' });
          return;
        }
        enqueueAgentMediaRetry(activityId, telegramAgentMediaRetryRequestsFile);
        writeAgentMediaActivity({
          ...activity,
          status: 'retrying',
          retryError: undefined,
          updatedAt: new Date().toISOString()
        }, telegramAgentMediaActivityFile);
        sendJson(res, 202, { status: 'retrying', activityId });
      } catch (error) {
        console.error('[Admin Dashboard] Could not queue Telegram video retry:', error.message);
        sendJson(res, 500, { error: 'Could not queue the Telegram video retry.' });
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
          .filter(([, record]) => record.label === 'paid' && record.source === 'manual')
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
              paidAt: payment.paidAt,
              source: payment.source || record.source || 'manual',
              amount: payment.amount ?? null,
              currency: payment.currency || 'SDG',
              bank: payment.bank ?? null,
              transactionId: payment.transactionId ?? null
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

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/payment-ledger') {
      try {
        const progressSnapshot = getTelegramProgressSnapshot('UTC');
        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const paymentEligibleStudents = progressSnapshot.students
          .filter(student => student.paymentKey && (student.enrolledAt || student.lessonStartedAt));
        const currentPaymentsByStudent = new Map(
          studentPaymentLedger.getCurrentForStudents(
            paymentEligibleStudents
              .filter(student => student.lessonStartedAt)
              .map(student => ({
                studentKey: student.paymentKey,
                enrolledAt: student.lessonStartedAt
              }))
          ).map(current => [current.studentKey, current])
        );
        const studentRecords = paymentEligibleStudents.map(student => {
          const progress = telegramProgress[student.paymentKey] || {};
          const currentPayment = currentPaymentsByStudent.get(student.paymentKey);
          return {
            platform: 'Telegram',
            studentKey: student.paymentKey,
            name: student.name,
            gradeName: student.gradeName,
            enrolledAt: student.lessonStartedAt,
            currentLesson: student.lessonTitle || '',
            currentLessonNumber: student.currentLessonNumber,
            hasStartedLessons: Boolean(
              progress.deliveredAt ||
              progress.currentLessonId ||
              (Array.isArray(progress.lessonHistory) && progress.lessonHistory.length > 0) ||
              (Number.isSafeInteger(progress.currentLessonIndex) && progress.currentLessonIndex >= 0)
            ),
            privateChatStarted: Boolean(progress.telegramPrivateChatId),
            paymentInformationDelivery: currentPayment?.paymentInformationDelivery || null,
            payment: currentPayment?.payment || null
          };
        });
        const students = studentRecords.filter(student =>
          student.hasStartedLessons && student.enrolledAt && student.payment);
        const studentsByKey = new Map(
          studentRecords.map(student => [student.studentKey, student])
        );
        const payments = Object.entries(studentPaymentLedger.list())
          .flatMap(([studentKey, record]) => Object.values(record.periods || {})
            .filter(payment => payment.status === 'paid' && payment.paidAt)
            .map(payment => {
              const student = studentsByKey.get(studentKey);
              return {
                platform: 'Telegram',
                studentKey,
                name: student?.name || studentKey,
                gradeName: student?.gradeName || '',
                paidAt: payment.paidAt,
                amount: payment.amount ?? null,
                currency: payment.currency || 'SDG',
                periodStart: payment.periodStart,
                source: payment.source || 'admin'
              };
            }))
          .concat(historicalPaymentReceipts.list())
          .sort((left, right) => Date.parse(right.paidAt) - Date.parse(left.paidAt));
        sendJson(res, 200, { students, payments });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load the student payment ledger:', error.message);
        sendJson(res, 500, { error: 'Could not read the student payment ledger.' });
      }
      return;
    }

    const receiptImageMatch = /^\/api\/admin\/payment-receipts\/([0-9a-f-]+)$/i
      .exec(requestUrl.pathname);
    if (req.method === 'GET' && receiptImageMatch) {
      const receiptId = receiptImageMatch[1];
      try {
        const ledgerReference = Object.values(studentPaymentLedger.list())
          .flatMap(record => Object.values(record.periods || {}))
          .find(payment =>
            payment.source === 'telegram-receipt' &&
            payment.details?.receiptId === receiptId);
        const historicalReference = historicalPaymentReceipts.list()
          .find(payment => payment.receiptId === receiptId);
        const receiptReference = ledgerReference || historicalReference;
        if (!receiptReference) {
          sendJson(res, 404, { error: 'Receipt image not found.' });
          return;
        }
        const mimeType = historicalReference?.mimeType || 'image/jpeg';
        const image = readPaymentReceiptImage(receiptId, paymentReceiptImageDirectory, mimeType);
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Disposition': 'inline',
          'Content-Length': image.length,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
        });
        res.end(image);
      } catch (error) {
        if (error.code === 'ENOENT') {
          sendJson(res, 404, { error: 'Receipt image not found.' });
          return;
        }
        console.error('[Admin Dashboard] Could not load payment receipt image:', error.message);
        sendJson(res, 500, { error: 'Could not load the payment receipt image.' });
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

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/overview-workbook') {
      if (!overviewWorkbook) {
        sendJson(res, 503, { error: 'Daily Overview workbook generation is not enabled.' });
        return;
      }
      overviewWorkbook.getStatus().then(status => sendJson(res, 200, status)).catch(error => {
        console.error('[Admin Dashboard] Could not get Overview workbook status:', error.message);
        sendJson(res, 500, { error: 'Could not get Overview workbook status.' });
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/overview-workbook.xlsx') {
      if (!overviewWorkbook) {
        sendJson(res, 503, { error: 'Daily Overview workbook generation is not enabled.' });
        return;
      }
      overviewWorkbook.getStatus().then(status => {
        if (status.state !== 'ready') {
          sendJson(res, 503, { error: status.error || 'Overview workbook is not ready yet.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="overview-statistics.xlsx"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        const workbookStream = fs.createReadStream(overviewWorkbookFile);
        workbookStream.on('error', error => {
          console.error('[Admin Dashboard] Could not stream Overview workbook:', error.message);
          if (!res.headersSent) sendJson(res, 500, { error: 'Could not read the Overview workbook.' });
          else res.destroy(error);
        });
        workbookStream.pipe(res);
      }).catch(error => {
        console.error('[Admin Dashboard] Could not prepare Overview workbook download:', error.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'Could not prepare the Overview workbook.' });
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/overview-google-sheet') {
      if (!googleSheetsOverview) {
        sendJson(res, 503, { error: 'Google Sheets sync is not enabled.' });
        return;
      }
      googleSheetsOverview.getStatus().then(status => sendJson(res, 200, status)).catch(error => {
        console.error('[Admin Dashboard] Could not get Google Sheets status:', error.message);
        sendJson(res, 500, { error: 'Could not get Google Sheets status.' });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/historical-payment-receipts') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Payment receipts can only be uploaded from this local dashboard.' });
        return;
      }
      const contentLength = Number(req.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > MAX_HISTORICAL_PAYMENT_RECEIPT_BYTES) {
        sendJson(res, 413, { error: 'Receipt files must be 10 MB or smaller.' });
        return;
      }
      readBinaryRequestBody(req, MAX_HISTORICAL_PAYMENT_RECEIPT_BYTES).then(image => {
        const studentKey = String(req.headers['x-payment-student-key'] || '').trim();
        const paidAtValue = String(req.headers['x-payment-paid-at'] || '').trim();
        const amountValue = String(req.headers['x-payment-amount'] || '').trim();
        const amount = Number(amountValue);
        const currency = String(req.headers['x-payment-currency'] || '').trim().toUpperCase();
        const mimeType = String(req.headers['content-type'] || '')
          .split(';', 1)[0].trim().toLowerCase();
        const paidAtTimestamp = Date.parse(paidAtValue);
        if (!studentKey || !Number.isFinite(paidAtTimestamp) ||
            !/^\d+(?:\.\d+)?$/.test(amountValue) || !Number.isFinite(amount) || amount <= 0 ||
            !/^[A-Z]{3}$/.test(currency)) {
          sendJson(res, 400, { error: 'Student, payment date, positive amount, and three-letter currency are required.' });
          return;
        }
        const paidAt = new Date(paidAtTimestamp).toISOString();
        if (paidAtTimestamp > Date.now()) {
          sendJson(res, 400, { error: 'Historical payment date cannot be in the future.' });
          return;
        }
        const student = getTelegramProgressSnapshot('UTC').students.find(item =>
          item.paymentKey === studentKey && item.lessonStartedAt);
        if (!student) {
          sendJson(res, 404, { error: 'Student was not found in the current progress list.' });
          return;
        }
        const samePeriodPayment = Object.values(studentPaymentLedger.list()[studentKey]?.periods || {})
          .some(payment =>
            payment.status === 'paid' &&
            typeof payment.paidAt === 'string' &&
            payment.paidAt.slice(0, 10) === paidAt.slice(0, 10) &&
            payment.amount === amount &&
            (payment.currency || 'SDG').toUpperCase() === currency);
        if (samePeriodPayment) {
          sendJson(res, 409, {
            error: 'A confirmed payment with the same student, date, amount, and currency already exists.'
          });
          return;
        }

        let receiptId = null;
        try {
          validatePaymentReceiptUpload(image, mimeType);
          receiptId = savePaymentReceiptImage(image, paymentReceiptImageDirectory, mimeType);
          const payment = historicalPaymentReceipts.add({
            studentKey,
            name: student.name,
            gradeName: student.gradeName || '',
            paidAt,
            amount,
            currency,
            receiptId,
            mimeType,
            image
          });
          scheduleChange(path.basename(historicalPaymentReceiptsFile));
          sendJson(res, 201, { payment });
        } catch (error) {
          if (receiptId) {
            try {
              deletePaymentReceiptImage(receiptId, paymentReceiptImageDirectory, mimeType);
            } catch (cleanupError) {
              console.error('[Admin Dashboard] Could not clean up an unused historical receipt:', cleanupError.message);
            }
          }
          throw error;
        }
      }).catch(error => {
        const status = /exceeds the \d+ MB size limit/.test(error.message)
          ? 413
          : /already been added|already recorded/.test(error.message)
            ? 409
            : /^(?:Receipt file data|This receipt file|The receipt content|Payment amount|Currency|A student|A receipt image|Payment date)/.test(error.message)
              ? 400
              : 500;
        if (status >= 500) {
          console.error('[Admin Dashboard] Could not record historical payment receipt:', error.message);
        }
        sendJson(res, status, {
          error: status === 500
            ? 'Could not save the historical payment receipt.'
            : error.message
        });
      });
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/payment-information') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Payment information can only be sent from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(async body => {
        if (!body || typeof body.studentKey !== 'string' || !body.studentKey.trim()) {
          sendJson(res, 400, { error: 'A student is required to send payment information.' });
          return;
        }
        const student = getTelegramProgressSnapshot('UTC').students.find(item =>
          item.paymentKey === body.studentKey);
        if (!student) {
          sendJson(res, 404, { error: 'Student was not found in the current progress list.' });
          return;
        }
        const progress = readJsonFileOr(telegramProgressFile, {});
        const studentProgress = progress[body.studentKey];
        if (!studentProgress?.telegramPrivateChatId) {
          sendJson(res, 409, { error: 'The student must start the Telegram private chat before receiving payment information.' });
          return;
        }
        const hasStartedLessons = Boolean(
          studentProgress.deliveredAt ||
          studentProgress.currentLessonId ||
          (Array.isArray(studentProgress.lessonHistory) &&
            studentProgress.lessonHistory.length > 0) ||
          (Number.isSafeInteger(studentProgress.currentLessonIndex) &&
            studentProgress.currentLessonIndex >= 0)
        );
        if (!hasStartedLessons) {
          sendJson(res, 409, { error: 'Payment information is available after the student starts lessons.' });
          return;
        }

        const attempt = studentPaymentLedger.beginPaymentInformationDelivery(
          body.studentKey,
          { enrolledAt: student.lessonStartedAt, force: true }
        );
        if (!attempt) {
          sendJson(res, 409, { error: 'Payment information is already being sent to this student.' });
          return;
        }
        try {
          const gender = getTelegramStudentGender(
            studentProgress,
            telegramStudentGenders.list()[body.studentKey]
          ).value;
          await sendTelegramPaymentMessage(
            studentProgress.telegramPrivateChatId,
            personalizeTelegramMessage(STUDENT_PAYMENT_INFORMATION_MESSAGE, gender)
          );
          studentPaymentLedger.completePaymentInformationDelivery(body.studentKey, {
            attemptId: attempt.attemptId,
            sent: true
          });
          scheduleChange(path.basename(paymentLedgerFile));
          sendJson(res, 200, {
            delivery: studentPaymentLedger.getPaymentInformationDelivery(body.studentKey)
          });
        } catch (error) {
          try {
            studentPaymentLedger.completePaymentInformationDelivery(body.studentKey, {
              attemptId: attempt.attemptId,
              sent: false,
              error: error.message
            });
          } catch (recordError) {
            console.error(
              `[Admin Dashboard] Could not record failed payment information delivery for ${body.studentKey}:`,
              recordError.message
            );
          }
          scheduleChange(path.basename(paymentLedgerFile));
          console.error(
            `[Admin Dashboard] Could not send payment information to ${body.studentKey}:`,
            error.message
          );
          sendJson(res, 502, {
            error: 'Could not deliver payment information through Telegram.',
            delivery: studentPaymentLedger.getPaymentInformationDelivery(body.studentKey)
          });
        }
      }).catch(error => {
        console.error('[Admin Dashboard] Could not send student payment information:', error.message);
        sendJson(res, 500, { error: 'Could not send student payment information.' });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/payment-ledger') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Payment records can only be changed from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(async body => {
        if (!body || typeof body.studentKey !== 'string' || !body.studentKey.trim() ||
            !PAYMENT_STATUSES.includes(body.status)) {
          sendJson(res, 400, { error: 'A student and valid payment status are required.' });
          return;
        }
        const student = getTelegramProgressSnapshot('UTC').students.find(item =>
          item.paymentKey === body.studentKey);
        if (!student) {
          sendJson(res, 404, { error: 'Student was not found in the current progress list.' });
          return;
        }
        if (!student.lessonStartedAt) {
          sendJson(res, 409, { error: 'This student has no lesson start date to anchor a rolling payment period.' });
          return;
        }
        const payment = studentPaymentLedger.setStatus(body.studentKey, {
          enrolledAt: student.lessonStartedAt,
          status: body.status,
          ...(Object.hasOwn(body, 'amount') ? { amount: body.amount } : {}),
          ...(Object.hasOwn(body, 'currency') ? { currency: body.currency } : {}),
          ...(Object.hasOwn(body, 'note') ? { note: body.note } : {})
        });
        scheduleChange(path.basename(paymentLedgerFile));
        let notification = { sent: false, reason: 'not_needed' };
        if (body.status === 'paid') {
          const progress = readJsonFileOr(telegramProgressFile, {});
          const privateChatId = progress[body.studentKey]?.telegramPrivateChatId;
          if (!privateChatId) {
            notification = { sent: false, reason: 'private_chat_not_started' };
          } else {
            const text = `السلام عليكم ${student.name}،\n${formatStudentPaymentStatus(payment)}\nشكراً ليك، وربنا يوفقك في دراستك 📚`;
            try {
              await sendTelegramPaymentMessage(privateChatId, text);
              notification = { sent: true, reason: 'sent' };
            } catch (error) {
              console.error(
                `[Admin Dashboard] Payment confirmed for ${body.studentKey}, but Telegram notification failed:`,
                error.message
              );
              notification = { sent: false, reason: 'delivery_failed' };
            }
          }
        }
        sendJson(res, 200, { payment, notification });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not update student payment status:', error.message);
        const invalidInput = /Payment amount|Currency must|Payment status|Student identifier|enrollment date|review date/.test(error.message);
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput ? error.message : 'Could not update student payment status.'
        });
      });
      return;
    }

    if (req.method === 'GET' &&
        requestUrl.pathname === '/api/admin/telegram-score-messages') {
      const requestIds = requestUrl.searchParams.get('requestIds')?.split(',') || [];
      if (requestIds.length === 0 ||
          requestIds.length > 500 ||
          requestIds.some(id =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ||
          new Set(requestIds).size !== requestIds.length) {
        sendJson(res, 400, { error: 'Provide 1–500 unique score-message request IDs.' });
        return;
      }

      try {
        const requestsById = new Map(
          lessonSkipQueues.Telegram.read()
            .filter(request => request.requestType === 'score_message')
            .map(request => [request.id, request])
        );
        const requests = requestIds.map(id => requestsById.get(id));
        if (requests.some(request => !request)) {
          sendJson(res, 404, {
            error: 'One or more score-message delivery records are no longer available.'
          });
          return;
        }
        sendJson(res, 200, {
          requests: requests.map(request => ({
            id: request.id,
            status: request.status,
            error: request.error
          }))
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not read Telegram score-message progress:', error.message);
        sendJson(res, 500, { error: 'Could not read Telegram score-message progress.' });
      }
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/telegram-score-messages') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Score messages must be requested from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        const validRange = Number.isSafeInteger(body?.rangeMin) &&
          Number.isSafeInteger(body?.rangeMax) &&
          ((body.rangeMin === 0 && body.rangeMax === 10) ||
            (body.rangeMin >= 11 && body.rangeMax - body.rangeMin === 9 &&
              (body.rangeMin - 1) % 10 === 0 && body.rangeMax <= 100));
        if (!validRange ||
            typeof body.messageTemplates?.masculine !== 'string' ||
            !body.messageTemplates.masculine.trim() ||
            body.messageTemplates.masculine.trim().length > 4096 ||
            !body.messageTemplates.masculine.includes('{{name}}') ||
            !body.messageTemplates.masculine.includes('{{percent}}') ||
            typeof body.messageTemplates?.feminine !== 'string' ||
            !body.messageTemplates.feminine.trim() ||
            body.messageTemplates.feminine.trim().length > 4096 ||
            !body.messageTemplates.feminine.includes('{{name}}') ||
            !body.messageTemplates.feminine.includes('{{percent}}') ||
            !Array.isArray(body.expectedStudents) ||
            body.expectedStudents.length === 0 ||
            body.expectedStudents.length > 500 ||
            body.expectedStudents.some(student =>
              !student ||
              typeof student.studentKey !== 'string' ||
              !/^telegram:-?\d+:\d+$/.test(student.studentKey) ||
              typeof student.name !== 'string' ||
              !Number.isSafeInteger(student.percent) ||
              student.percent < 0 ||
              student.percent > 100 ||
              student.percent < body.rangeMin ||
              student.percent > body.rangeMax ||
              !Number.isSafeInteger(student.correct) ||
              student.correct < 0 ||
              !Number.isSafeInteger(student.total) ||
              student.total < 1 ||
              student.correct > student.total ||
              student.percent !== Math.round(student.correct / student.total * 100) ||
              !['male', 'female', 'unknown'].includes(student.gender)) ||
            new Set(body.expectedStudents.map(student => student.studentKey)).size !==
              body.expectedStudents.length) {
          sendJson(res, 400, {
            error: 'Choose a valid 10-point score range, include {{name}} and {{percent}} in both templates, and select 1–500 Telegram students with valid scores and gender.'
          });
          return;
        }

        const snapshotStudents = getTelegramProgressSnapshot('UTC').students;
        const rangeStudents = snapshotStudents.filter(student =>
          student.platform === 'Telegram' &&
          Number.isFinite(student.exerciseScorePercent) &&
          student.exerciseScorePercent >= body.rangeMin &&
          student.exerciseScorePercent <= body.rangeMax);
        const eligibleStudents = rangeStudents.filter(student =>
          student.canReplyPrivately === true);
        const expectedStudents = body.expectedStudents
          .map(student => ({
            studentKey: student.studentKey,
            name: student.name,
            percent: student.percent,
            correct: student.correct,
            total: student.total,
            gender: student.gender
          }))
          .sort((left, right) => left.studentKey.localeCompare(right.studentKey));
        const currentStudents = eligibleStudents
          .map(student => ({
            studentKey: student.jid,
            name: student.name,
            percent: student.exerciseScorePercent,
            correct: student.scoreCorrectQuestions,
            total: student.scoreTotalQuestions,
            gender: ['male', 'female'].includes(student.gender?.value)
              ? student.gender.value
              : 'unknown'
          }))
          .sort((left, right) => left.studentKey.localeCompare(right.studentKey));
        if (JSON.stringify(expectedStudents) !== JSON.stringify(currentStudents)) {
          sendJson(res, 409, {
            error: 'The students or scores changed since the preview. Refresh the distribution and review the recipients again.'
          });
          return;
        }

        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const invalidStudent = eligibleStudents.find(student => {
          const state = telegramProgress[student.jid];
          return !state ||
            student.jid !== `telegram:${state.telegramChatId}:${state.telegramUserId}` ||
            typeof state.telegramPrivateChatId !== 'string' ||
            !state.telegramPrivateChatId.trim();
        });
        if (invalidStudent) {
          sendJson(res, 409, {
            error: 'One or more students no longer have an available private chat. Refresh the distribution and try again.'
          });
          return;
        }

        const scoreRange = `${body.rangeMin}–${body.rangeMax}%`;
        const requests = eligibleStudents.map(student => {
          const state = telegramProgress[student.jid];
          const gender = student.gender?.value === 'female' ? 'feminine' : 'masculine';
          const messageTemplate = body.messageTemplates[gender].trim();
          const message = messageTemplate
            .replaceAll('{{name}}', student.name || 'Student')
            .replaceAll('{{percent}}', String(student.exerciseScorePercent))
            .replaceAll('{{correct}}', String(student.scoreCorrectQuestions))
            .replaceAll('{{total}}', String(student.scoreTotalQuestions))
            .replaceAll('{{range}}', scoreRange);
          if (message.length > 4096) {
            throw new Error('A personalized score message exceeds 4,096 characters.');
          }
          const currentLessonId = typeof state.currentLessonId === 'string'
            ? state.currentLessonId
            : '';
          return {
            requestType: 'score_message',
            platform: 'Telegram',
            studentKey: student.jid,
            chatId: String(state.telegramChatId),
            userId: String(state.telegramUserId),
            gradeKey: typeof state.grade === 'string' ? state.grade : '',
            currentLessonId,
            nextLessonId: currentLessonId,
            nextLessonTitle: `Exercise score ${student.exerciseScorePercent}%`,
            scorePercent: student.exerciseScorePercent,
            message
          };
        });
        const queued = lessonSkipQueues.Telegram.enqueueMany(requests);
        if (queued.conflict) {
          sendJson(res, 409, {
            error: 'One or more selected students already have a pending Telegram action. Refresh progress and try again.'
          });
          return;
        }
        scheduleChange(path.basename(telegramLessonSkipRequestsFile));
        sendJson(res, 202, {
          queuedCount: queued.requests.length,
          requestIds: queued.requests.map(request => request.id)
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not queue Telegram score messages:', error.message);
        const invalidInput = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.' ||
          error.message === 'A personalized score message exceeds 4,096 characters.';
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput
            ? error.message
            : 'Could not queue the Telegram score messages.'
        });
      });
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/telegram-student-reply') {
      readRequestBody(req).then(async body => {
        if (!body || typeof body.studentKey !== 'string' ||
            !/^telegram:-?\d+:\d+$/.test(body.studentKey) ||
            typeof body.message !== 'string' ||
            !body.message.trim() ||
            body.message.trim().length > 4096) {
          sendJson(res, 400, { error: 'A Telegram student and a message of 1–4096 characters are required.' });
          return;
        }
        const progress = readJsonFileOr(telegramProgressFile, {});
        const student = progress[body.studentKey];
        if (!student ||
            body.studentKey !== `telegram:${student.telegramChatId}:${student.telegramUserId}`) {
          sendJson(res, 404, { error: 'Telegram student was not found.' });
          return;
        }
        const privateChatId = student.telegramPrivateChatId;
        if (typeof privateChatId !== 'string' || !privateChatId.trim()) {
          sendJson(res, 409, {
            error: 'The student has not started a private chat with the bot yet.'
          });
          return;
        }
        if (isTelegramPrivateChatBlocked(privateChatId, telegramBlockedRecipientsFile)) {
          sendJson(res, 409, {
            error: 'The student blocked the bot; the private message was not sent.'
          });
          return;
        }
        try {
          if (telegramMessageNotifier) {
            await telegramMessageNotifier(privateChatId, body.message.trim());
          } else {
            const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
            if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
            const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                chat_id: privateChatId,
                text: body.message.trim()
              }),
              signal: AbortSignal.timeout(10_000)
            });
            const result = await response.json();
            if (!response.ok || result?.ok !== true) {
              throw new Error(result?.description || 'Telegram rejected the message.');
            }
          }
          const replies = readJsonFileOr(telegramDashboardChatRepliesFile, {});
          const studentReplies = Array.isArray(replies[body.studentKey])
            ? replies[body.studentKey]
            : [];
          studentReplies.push({
            role: 'bot',
            text: body.message.trim(),
            timestamp: new Date().toISOString()
          });
          replies[body.studentKey] = studentReplies.slice(-200);
          writeJsonFile(telegramDashboardChatRepliesFile, replies);
          scheduleChange(path.basename(telegramDashboardChatRepliesFile));
          sendJson(res, 200, { sent: true });
        } catch (error) {
          if (isTelegramBotBlockedError(error)) {
            markTelegramPrivateChatBlocked(privateChatId, telegramBlockedRecipientsFile);
          }
          console.error(
            `[Admin Dashboard] Could not send a private reply to ${body.studentKey}:`,
            error.message
          );
          sendJson(res, 502, { error: 'Could not deliver the private Telegram reply.' });
        }
      }).catch(error => {
        console.error('[Admin Dashboard] Could not send Telegram student reply:', error.message);
        const invalidInput = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.';
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput ? error.message : 'Could not process the Telegram student reply.'
        });
      });
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/telegram-student-gender') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Student settings can only be changed from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (!body || typeof body.jid !== 'string' ||
            !/^telegram:-?\d+:\d+$/.test(body.jid) ||
            !['female', 'male', 'unknown', 'auto'].includes(body.gender)) {
          sendJson(res, 400, { error: 'Choose feminine, masculine, not specified, or automatic addressing.' });
          return;
        }
        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const student = telegramProgress[body.jid];
        if (!student ||
            body.jid !== `telegram:${student.telegramChatId}:${student.telegramUserId}`) {
          sendJson(res, 404, { error: 'Telegram student was not found.' });
          return;
        }
        try {
          telegramStudentGenders.set(body.jid, body.gender);
          sendJson(res, 200, {
            gender: getTelegramStudentGender(
              student,
              body.gender === 'auto' ? null : body.gender
            ),
            genderOverride: body.gender
          });
        } catch (error) {
          console.error('[Admin Dashboard] Could not update Telegram student addressing:', error.message);
          sendJson(res, 500, { error: 'Could not save the student addressing setting.' });
        }
      }).catch(error => {
        console.error('[Admin Dashboard] Could not update Telegram student addressing:', error.message);
        const invalidInput = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.';
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput ? error.message : 'Could not update the student addressing setting.'
        });
      });
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/progress/regrade-task') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Task rechecks must be requested from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (!body || typeof body.jid !== 'string' || typeof body.currentLessonId !== 'string') {
          sendJson(res, 400, { error: 'A Telegram student and current lesson ID are required.' });
          return;
        }
        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const student = telegramProgress[body.jid];
        const savedSubmission = student?.lastTaskSubmission;
        if (!student || student.currentLessonId !== body.currentLessonId ||
            student.grade !== savedSubmission?.grade ||
            savedSubmission?.lessonId !== student.currentLessonId ||
            typeof savedSubmission?.text !== 'string' ||
            !student.telegramPrivateChatId ||
            !['awaiting_task', 'awaiting_reattempt'].includes(student.status)) {
          sendJson(res, 409, {
            error: 'There is no saved submission for this active lesson. Only new submissions can be rechecked.'
          });
          return;
        }
        if (typeof student.telegramChatId === 'undefined' ||
            typeof student.telegramUserId === 'undefined' ||
            body.jid !== `telegram:${student.telegramChatId}:${student.telegramUserId}`) {
          sendJson(res, 409, { error: 'This Telegram student does not have a valid group identity.' });
          return;
        }
        const { request, alreadyQueued, conflict } = lessonSkipQueues.Telegram.enqueue({
          requestType: 'regrade_task',
          platform: 'Telegram',
          studentKey: body.jid,
          chatId: String(student.telegramChatId),
          userId: String(student.telegramUserId),
          gradeKey: student.grade,
          currentLessonId: student.currentLessonId,
          nextLessonId: student.currentLessonId,
          nextLessonTitle: 'Recheck latest task answers'
        });
        if (conflict) {
          sendJson(res, 409, { error: 'Another lesson action is already queued for this student.' });
          return;
        }
        if (!alreadyQueued) scheduleChange(path.basename(telegramLessonSkipRequestsFile));
        sendJson(res, 202, {
          requestId: request.id,
          status: request.status,
          alreadyQueued
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not queue a Telegram task recheck:', error.message);
        const invalidInput = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.';
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput ? error.message : 'Could not queue the task recheck.'
        });
      });
      return;
    }

    if (req.method === 'POST' &&
        requestUrl.pathname === '/api/admin/progress/send-reminder') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Student reminders must be requested from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (!body || typeof body.jid !== 'string' || typeof body.currentLessonId !== 'string') {
          sendJson(res, 400, { error: 'A Telegram student and current lesson ID are required.' });
          return;
        }
        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const student = telegramProgress[body.jid];
        if (!student || student.currentLessonId !== body.currentLessonId ||
            !['awaiting_task', 'awaiting_reattempt'].includes(student.status)) {
          sendJson(res, 409, { error: 'The student no longer has a pending exercise for this lesson.' });
          return;
        }
        if (!student.telegramPrivateChatId) {
          sendJson(res, 409, {
            error: 'The student must start a private chat with the bot before receiving a reminder.'
          });
          return;
        }
        if (typeof student.telegramChatId === 'undefined' ||
            typeof student.telegramUserId === 'undefined' ||
            body.jid !== `telegram:${student.telegramChatId}:${student.telegramUserId}`) {
          sendJson(res, 409, { error: 'This Telegram student does not have a valid group identity.' });
          return;
        }
        const { request, alreadyQueued, conflict } = lessonSkipQueues.Telegram.enqueue({
          requestType: 'manual_reminder',
          platform: 'Telegram',
          studentKey: body.jid,
          chatId: String(student.telegramChatId),
          userId: String(student.telegramUserId),
          gradeKey: student.grade,
          currentLessonId: student.currentLessonId,
          nextLessonId: student.currentLessonId,
          nextLessonTitle: 'Send private lesson reminder'
        });
        if (conflict) {
          sendJson(res, 409, { error: 'Another lesson action or reminder is already queued for this student.' });
          return;
        }
        if (!alreadyQueued) scheduleChange(path.basename(telegramLessonSkipRequestsFile));
        sendJson(res, 202, {
          requestId: request.id,
          status: request.status,
          alreadyQueued
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not queue a Telegram student reminder:', error.message);
        const invalidInput = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.';
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput ? error.message : 'Could not queue the student reminder.'
        });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/progress/skip-lesson') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Lesson skips must be requested from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (!body || !['WhatsApp', 'Telegram'].includes(body.platform) ||
            typeof body.jid !== 'string' || !body.jid || body.jid.length > 200 ||
            typeof body.currentLessonId !== 'string') {
          sendJson(res, 400, { error: 'A platform, student ID, and current lesson ID are required.' });
          return;
        }

        const data = body.platform === 'Telegram'
          ? {
              lessons: readJsonFile(lessonsFile),
              telegramProgress: readJsonFileOr(telegramProgressFile, {})
            }
          : readDataWithBlockedContacts();
        const student = body.platform === 'WhatsApp'
          ? data.progress?.[body.jid]
          : data.telegramProgress?.[body.jid];
        if (!student || student.currentLessonId !== body.currentLessonId) {
          sendJson(res, 409, { error: 'The student progress changed. Refresh the progress table and try again.' });
          return;
        }
        if (body.platform === 'WhatsApp' && !isDirectChat(body.jid)) {
          sendJson(res, 400, { error: 'A valid WhatsApp student chat is required.' });
          return;
        }
        if (body.platform === 'Telegram' &&
            (typeof student.telegramChatId === 'undefined' ||
             typeof student.telegramUserId === 'undefined' ||
             body.jid !== `telegram:${student.telegramChatId}:${student.telegramUserId}`)) {
          sendJson(res, 409, { error: 'This Telegram student does not have a valid group destination.' });
          return;
        }
        if (body.platform === 'Telegram' &&
            (typeof student.telegramPrivateChatId !== 'string' ||
             !student.telegramPrivateChatId.trim())) {
          sendJson(res, 409, {
            error: 'The student must start a private chat with the bot before receiving a lesson.'
          });
          return;
        }

        const nextLesson = getNextLessonToSkip(student, data.lessons);
        if (!nextLesson) {
          sendJson(res, 409, { error: 'There is no fully configured next lesson available for this student.' });
          return;
        }

        let phoneJid = null;
        if (body.platform === 'WhatsApp') {
          const contact = data.contacts?.[body.jid];
          phoneJid = getPhoneJid(body.jid, contact?.phoneJid, contact?.jid);
          const agentStatus = readJsonFileOr(agentStatusFile, null);
          const heartbeatAt = Date.parse(agentStatus?.updatedAt || '');
          if (agentStatus?.connectionState !== 'connected' ||
              !Number.isFinite(heartbeatAt) ||
              Date.now() - heartbeatAt > AGENT_HEARTBEAT_MAX_AGE_MS) {
            sendJson(res, 409, { error: 'The WhatsApp agent must be connected before skipping a lesson.' });
            return;
          }
        }

        const queue = lessonSkipQueues[body.platform];
        const { request, alreadyQueued, conflict } = queue.enqueue({
          platform: body.platform,
          studentKey: body.jid,
          jid: body.platform === 'WhatsApp' ? body.jid : null,
          phoneJid,
          chatId: body.platform === 'Telegram' ? String(student.telegramChatId) : null,
          userId: body.platform === 'Telegram' ? String(student.telegramUserId) : null,
          gradeKey: student.grade,
          currentLessonId: student.currentLessonId,
          nextLessonId: nextLesson.lessonId,
          lessonIndex: nextLesson.lessonIndex,
          nextLessonTitle: nextLesson.lessonTitle
        });
        if (conflict) {
          sendJson(res, 409, { error: 'Another lesson request is already queued for this student.' });
          return;
        }
        if (!alreadyQueued) scheduleChange(path.basename(
          body.platform === 'WhatsApp'
            ? whatsappLessonSkipRequestsFile
            : telegramLessonSkipRequestsFile
        ));
        sendJson(res, 202, {
          requestId: request.id,
          status: request.status,
          alreadyQueued,
          nextLessonTitle: request.nextLessonTitle
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not queue a lesson skip:', error.message);
        const isInvalidBody = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.';
        sendJson(res, isInvalidBody ? 400 : 500, {
          error: isInvalidBody ? error.message : 'Could not queue the lesson skip.'
        });
      });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/progress/send-lesson') {
      if (!isSameOriginLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'Lesson delivery must be requested from this local dashboard.' });
        return;
      }
      readRequestBody(req).then(body => {
        if (!body || typeof body.jid !== 'string' || !body.jid || body.jid.length > 200 ||
            typeof body.currentLessonId !== 'string' ||
            typeof body.lessonId !== 'string' || !body.lessonId) {
          sendJson(res, 400, { error: 'A Telegram student, current lesson value, and destination lesson ID are required.' });
          return;
        }

        const telegramProgress = readJsonFileOr(telegramProgressFile, {});
        const student = telegramProgress[body.jid];
        const currentLessonId = student?.currentLessonId || '';
        if (!student || currentLessonId !== body.currentLessonId) {
          sendJson(res, 409, { error: 'The student progress changed. Refresh the progress table and try again.' });
          return;
        }
        if (typeof student.telegramChatId === 'undefined' ||
            typeof student.telegramUserId === 'undefined' ||
            body.jid !== `telegram:${student.telegramChatId}:${student.telegramUserId}`) {
          sendJson(res, 409, { error: 'This Telegram student does not have a valid group destination.' });
          return;
        }
        if (typeof student.telegramPrivateChatId !== 'string' ||
            !student.telegramPrivateChatId.trim()) {
          sendJson(res, 409, {
            error: 'The student must start a private chat with the bot before receiving a lesson.'
          });
          return;
        }

        const lessons = readJsonFile(lessonsFile);
        const selectedLesson = getReadyTelegramLessons(student.grade, lessons)
          .find(lesson =>
            lesson.id === body.lessonId &&
            lesson.track === (body.track || 'grammar') &&
            lesson.collectionId === (body.collectionId || null));
        if (!selectedLesson) {
          sendJson(res, 409, {
            error: 'The selected lesson is missing its video or required exercise and answer key.'
          });
          return;
        }

        const { request, alreadyQueued, conflict } = lessonSkipQueues.Telegram.enqueue({
          requestType: 'send_lesson',
          platform: 'Telegram',
          studentKey: body.jid,
          chatId: String(student.telegramChatId),
          userId: String(student.telegramUserId),
          gradeKey: student.grade,
          currentLessonId,
          nextLessonId: selectedLesson.id,
          lessonIndex: selectedLesson.lessonIndex,
          nextLessonTitle: selectedLesson.title,
          track: selectedLesson.track,
          collectionId: selectedLesson.collectionId
        });
        if (conflict) {
          sendJson(res, 409, { error: 'Another lesson request is already queued for this student.' });
          return;
        }
        if (!alreadyQueued) scheduleChange(path.basename(telegramLessonSkipRequestsFile));
        sendJson(res, 202, {
          requestId: request.id,
          status: request.status,
          alreadyQueued,
          lessonId: request.nextLessonId,
          lessonTitle: request.nextLessonTitle
        });
      }).catch(error => {
        console.error('[Admin Dashboard] Could not queue a lesson delivery:', error.message);
        const invalidInput = error.message === 'Request body is too large.' ||
          error.message === 'Request body must contain valid JSON.';
        sendJson(res, invalidInput ? 400 : 500, {
          error: invalidInput ? error.message : 'Could not queue the lesson delivery.'
        });
      });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    try {
      const data = requestUrl.pathname.startsWith('/api/admin/curriculum')
        ? { lessons: readJsonFile(lessonsFile) }
        : readDataWithBlockedContacts();
      if (requestUrl.pathname === '/api/admin/overview') {
        const timeZone = requestUrl.searchParams.get('timeZone') || 'UTC';
        try {
          const now = Date.now();
          const endDate = requestUrl.searchParams.get('endDate');
          const today = calendarDateKey(now, timeZone);
          if (endDate && (!isValidCalendarDateKey(endDate) || endDate > today)) {
            sendJson(res, 400, { error: 'A valid past or current end date is required.' });
            return;
          }
          const overview = memoizeDashboardQuery(
            data,
            `overview:${timeZone}:${endDate || today}:${Math.floor(now / 60_000)}`,
            () => getDashboardOverview(data, now, timeZone, endDate)
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
        const offsetValue = requestUrl.searchParams.get('offset') || '0';
        if (!/^\d+$/.test(offsetValue) || !Number.isSafeInteger(Number(offsetValue))) {
          sendJson(res, 400, { error: 'Conversation offset must be a non-negative integer.' });
          return;
        }
        const offset = Number(offsetValue);
        const conversation = memoizeDashboardQuery(data, `conversation:${jid}:${offset}`, () =>
          getDashboardConversation(data, jid, offset));
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
        const now = Date.now();
        const endDate = requestUrl.searchParams.get('endDate');
        if (endDate &&
            (!isValidCalendarDateKey(endDate) || endDate > calendarDateKey(now, timeZone))) {
          sendJson(res, 400, { error: 'A valid past or current activity end date is required.' });
          return;
        }
        const activity = getDashboardStudentActivity(
          data,
          requestUrl.searchParams.get('jid'),
          Number(daysValue),
          timeZone,
          now,
          endDate
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
          const latestSkipRequests = Object.fromEntries(
            Object.entries(lessonSkipQueues).map(([platform, queue]) => {
              const latest = new Map();
              for (const request of queue.read()) latest.set(request.studentKey, request);
              return [platform, latest];
            })
          );
          sendJson(res, 200, {
            ...progress,
            students: progress.students.map(student => {
              const request = latestSkipRequests[student.platform].get(student.jid);
              return {
                ...student,
                skipRequest: request?.currentLessonId === student.currentLessonId
                  ? {
                      status: request.status,
                      error: request.error,
                      nextLessonTitle: request.nextLessonTitle
                    }
                  : null
              };
            })
          });
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
        sendJson(
          res,
          200,
          addLessonCompletionStats(
            gradeCurriculum,
            readJsonFileOr(telegramProgressFile, {})
          )
        );
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
    overviewWorkbook?.stop();
    googleSheetsOverview?.stop();
    for (const watcher of watchers) watcher.close();
    for (const response of eventClients) response.end();
    eventClients.clear();
  });
  if (studentWorkbook) {
    server.on('listening', () => {
      studentWorkbook.refresh();
    });
  }
  if (overviewWorkbook) {
    server.on('listening', () => {
      overviewWorkbook.start()
        .then(() => googleSheetsOverview?.start())
        .catch(error =>
          console.error('[Admin Dashboard] Could not start daily Overview workbook updates:', error.message));
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

  const server = createAdminDashboardServer({
    overviewWorkbookFile: OVERVIEW_WORKBOOK_FILE
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[Admin Dashboard] Running locally at http://127.0.0.1:${port}`);
  });
}
