import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { config } from './config.js';
import { installAgentLogCapture, TELEGRAM_AGENT_LOG_FILE } from './agent_runtime.js';
import {
  readAgentMediaActivities,
  TELEGRAM_AGENT_MEDIA_ACTIVITY_FILE,
  writeAgentMediaActivity
} from './agent_media_activity.js';
import {
  consumeAgentMediaRetryRequests,
  TELEGRAM_AGENT_MEDIA_RETRY_REQUESTS_FILE
} from './agent_media_retry.js';
import { getAnswerFreeHint } from './answer_feedback.js';
import { evaluateStudentTask, parseAnswerKey } from './task_evaluator.js';
import { lessonManager, resolveLessonVideoPath } from './lesson_manager.js';
import {
  LessonSkipQueue,
  TELEGRAM_LESSON_SKIP_REQUESTS_FILE
} from './lesson_skip_queue.js';
import { scanPaymentReceipt } from './payment_scanner.js';
import {
  createStudentPaymentLedger,
  formatStudentPaymentStatus,
  getLessonPaymentStartAt,
  STUDENT_PAYMENT_LEDGER_FILE
} from './student_payment_ledger.js';
import { STUDENT_PAYMENT_INFORMATION_MESSAGE } from './student_payment_information.js';
import {
  deletePaymentReceiptImage,
  PAYMENT_RECEIPT_IMAGE_DIRECTORY,
  savePaymentReceiptImage
} from './payment_receipt_images.js';
import {
  TELEGRAM_AGENT_STATUS_FILE,
  writeTelegramAgentStatus
} from './telegram_agent_status.js';
import {
  TELEGRAM_AGENT_CONTROL_FILE,
  TELEGRAM_UPDATE_QUEUE_FILE,
  TelegramUpdateQueue
} from './telegram_update_queue.js';
import { isExplicitPaidClaim } from './contact_payment_labels.js';
import {
  getTelegramStudentGender,
  inferTelegramGenderFromMessage,
  inferTelegramGenderFromName,
  personalizeTelegramMessage
} from './telegram_student_gender.js';
import {
  clearTelegramPrivateChatBlocked,
  isTelegramBotBlockedError,
  isTelegramPrivateChatBlocked,
  markTelegramPrivateChatBlocked,
  TELEGRAM_BLOCKED_RECIPIENTS_FILE
} from './telegram_blocked_recipients.js';
import { createTelegramStudentGenderStore } from './telegram_student_gender_store.js';
import {
  getDueLessonAnswerReminders,
  LESSON_ANSWER_REMINDER_CHECK_INTERVAL_MS,
  LESSON_ANSWER_REMINDER_MESSAGE,
  markLessonAnswerReminderSuppressed,
  markLessonAnswerReminderSent
} from './lesson_answer_reminders.js';
import { recordTelegramLessonAnnouncementOptIn } from './telegram_announcement_recipients.js';
import {
  DAILY_MOTIVATION_REMINDER_MESSAGE,
  formatWeeklyGoalMessage,
  getDueStudentMotivationMessages,
  getStudentGoalCommand,
  getStudentLocalDate,
  getStudentReminderCommand,
  STUDENT_MOTIVATION_CHECK_INTERVAL_MS,
  STUDENT_MOTIVATION_TIME_ZONE
} from './student_motivation.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(APP_DIR, 'data');
const DEFAULT_PROGRESS_FILE = path.join(DATA_DIR, 'telegram_progress.json');
const DEFAULT_OFFSET_FILE = path.join(DATA_DIR, 'telegram_update_offset.json');
const TELEGRAM_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const TELEGRAM_PAYMENT_REMINDER_LESSONS = 5;
const TELEGRAM_MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const EXERCISE_SCORING_POLICY = 'first_attempt';
const TELEGRAM_LESSON_REQUEST_COOLDOWN_MS = 2 * 60 * 1000;
const TELEGRAM_TRACK_SELECTION_SETTLE_MS = 1000;
const TELEGRAM_UPDATE_CONCURRENCY = 5;
const TELEGRAM_CHAT_HISTORY_LIMIT = 200;
const IGNORED_TELEGRAM_USER_IDS = new Set(['6413779313']);
const LONG_POLL_SECONDS = 25;
const NETWORK_TIMEOUT_MS = 35_000;
const TELEGRAM_UPLOAD_TIMEOUT_MS = 180_000;
const POLL_RETRY_DELAY_MS = 5_000;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

function saveJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, filePath);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) ||
            attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Telegram] Could not clean temporary state file:', cleanupError.message);
    }
    throw error;
  }
}

function getStudentMilestoneMessage(lessonsCompleted) {
  return `🎉 برافو عليك! كملت ${lessonsCompleted} حصص بنجاح.\n\nتقدمك واضح، وخطوة صغيرة كل يوم بتقربك من هدفك. واصل بالوتيرة المناسبة ليك 🌟`;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getProgressKey(chatId, userId) {
  return `telegram:${chatId}:${userId}`;
}

function getStudentName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
    user.username ||
    `Student ${user.id}`;
}

function isLessonRequest(text) {
  const normalized = text.trim().replace(/[؟?!.,،؛]+$/u, '').replace(/\s+/g, ' ');
  return /^\/(?:lesson|grammar)(?:@[a-z0-9_]+)?(?:\s|$)/i.test(normalized) ||
    /^(?:وين|وينو|وينها)\s+(?:ال)?(?:حصة|حصه|درس)(?:ي)?$/u.test(normalized) ||
    /^(?:ال)?(?:حصة|حصه|درس)(?:ي)?\s+(?:وين|وينها)$/u.test(normalized);
}

function getTelegramTrackCommand(text) {
  const command = /^\/(lesson|grammar|literature|spine)(?:@[a-z0-9_]+)?(?:\s|$)/i
    .exec(text.trim())?.[1]?.toLowerCase();
  if (command === 'lesson' || command === 'grammar') return 'grammar';
  return command || null;
}

function getTelegramTrackLessons(lessonsConfig, grade, track) {
  if (track === 'grammar') {
    const lessons = lessonsConfig[grade]?.lessons;
    return Array.isArray(lessons) ? lessons.filter(isReadyLesson) : [];
  }
  if (track === 'literature') {
    const lessons = lessonsConfig[grade]?.collections?.treasure_island?.lessons;
    return Array.isArray(lessons)
      ? lessons.filter(lesson => isReadyLesson(lesson) && lesson.hasExercise !== false)
      : [];
  }
  if (track === 'spine') {
    const lessons = lessonsConfig[grade]?.standaloneLessons;
    return Array.isArray(lessons)
      ? lessons.filter(lesson => isReadyLesson(lesson) && lesson.hasExercise !== false)
      : [];
  }
  return [];
}

function getTrackProgress(state, track = state?.activeTelegramTrack || 'grammar') {
  if (track === 'grammar') return state;
  return state?.telegramLessonTracks?.[track] || null;
}

function getSequentialLessonForProgress(lessonsConfig, grade, state) {
  const lessons = lessonsConfig[grade]?.lessons;
  if (!Array.isArray(lessons)) return { lesson: null, lessonIndex: -1 };

  const lessonIndex = typeof state?.currentLessonId === 'string' && state.currentLessonId
    ? lessons.findIndex(lesson => lesson?.id === state.currentLessonId)
    : Number.isInteger(state?.currentLessonIndex)
      ? state.currentLessonIndex
      : -1;
  return {
    lesson: lessonIndex >= 0 ? lessons[lessonIndex] || null : null,
    lessonIndex
  };
}

function hasActiveTelegramTask(state) {
  const taskProgress = getTrackProgress(state);
  return ['awaiting_task', 'awaiting_reattempt'].includes(taskProgress?.status);
}

function isAcknowledgmentMessage(text) {
  const normalized = text.trim().replace(/[؟?!.,،؛]+$/u, '').replace(/\s+/g, ' ');
  return /^(?:تمام|طيب|حاضر|اوكي|أوكي|okay|ok|شكرا|شكراً|تسلم)(?:\s+(?:شكرا|شكراً|يا زول))?$/iu
    .test(normalized);
}

function getLessonNavigationCommand(text) {
  const command = /^\/(previous|next)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(text.trim())?.[1];
  return command?.toLowerCase() || null;
}

function isHelpCommand(text) {
  return /^\/help(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function getNumberedLessonCommand(text) {
  const match = /^\/(\d+)(?:@[a-z0-9_]+)?\s*$/i.exec(text.trim());
  return match ? Number(match[1]) : null;
}

function isPaymentClaimCommand(text) {
  return /^\/paid(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function isPaymentStatusCommand(text) {
  return /^\/(?:payment|paystatus)(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function isTelegramPaymentQuestion(text) {
  if (!text || text.startsWith('/')) return false;
  const normalized = text.normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .toLowerCase();
  return /(?:سعر|اسعار|رسوم|اشتراك|بكم|قروش|مبلغ|بنكك|حساب|تحويل|احول|ادفع)/u
    .test(normalized) ||
    /كم.{0,20}(?:حق|الدروس|الحصص)/u.test(normalized) ||
    /(?:كيف|طريقة|وين|شنو|شني).{0,24}(?:الدفع|ادفع|تحويل|احول|بنكك)/u.test(normalized);
}

function getTelegramAnnouncementPreferenceCommand(text) {
  const command = /^\/(announcements_on|announcements_off|broadcasts_on|broadcasts_off)(?:@[a-z0-9_]+)?(?:\s|$)/i
    .exec(text.trim())?.[1]?.toLowerCase() || null;
  if (command === null) return null;
  return command.endsWith('_on');
}

function getTelegramCelebrationPreferenceCommand(text) {
  const command = /^\/celebrations_(on|off)(?:@[a-z0-9_]+)?(?:\s|$)/i
    .exec(text.trim())?.[1]?.toLowerCase() || null;
  return command === null ? null : command === 'on';
}

function getLessonCelebrationMessage(studentName, lessonTitle, username) {
  const recipient = typeof username === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)
    ? `@${username}`
    : studentName;
  return `عايز أحتفل معاكم
🎉 برافو يا ${recipient}!
جاوبت تمرين الحصة ${lessonTitle} كامل وكل إجاباتك صحيحة 👏🌟

يلا نستمر كدا بي نفس التركيز، وعقبال الشهادة يا رب! 💪`;
}

function isGroupChat(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

function isReadyLesson(lesson) {
  if (!lesson || typeof lesson.videoFile !== 'string' || !lesson.videoFile.trim()) {
    return false;
  }
  if (lesson.hasExercise === false) return true;
  return typeof lesson.taskMessage === 'string' &&
    Boolean(lesson.taskMessage.trim()) &&
    Array.isArray(lesson.answerKey) &&
    lesson.answerKey.length > 0;
}

function getLessonTaskVersion(lesson) {
  return createHash('sha256')
    .update(JSON.stringify(
      lesson.hasExercise === false
        ? [lesson.id, 'video-only']
        : [lesson.taskMessage, lesson.answerKey]
    ))
    .digest('hex');
}

function taskFailureMessage() {
  return 'ما قدرت أصحح إجابتك هسي بسبب مشكلة فنية. ما اتسجلت كغلط؛ أرسلها تاني بعد شوية.';
}

function getNewStudentInstructions(users) {
  const mentions = users.map(user => ({
    name: getStudentName(user),
    user
  }));
  const textPrefix = 'أهلاً ';
  let text = textPrefix;
  const entities = [];
  mentions.forEach((mention, index) => {
    if (index > 0) text += '، ';
    const offset = text.length;
    text += mention.name;
    entities.push({
      type: 'text_mention',
      offset,
      length: mention.name.length,
      user: mention.user
    });
  });
  const plural = mentions.length > 1;
  text += ` 👋\n\nعشان تبدأ${plural ? 'وا' : ''} الدروس:
١. ${plural ? 'افتحوا' : 'أفتح'} المحادثة الخاصة مع @eSchoolsdBot واضغط${plural ? 'وا' : ''} Start.
٢. بعد الضغط على Start، اختار${plural ? 'وا' : ''} المسار البتبدأ${plural ? 'وا' : ''} بيه في الخاص:
• /spine لدروس SPINE.
• /grammar لدروس القواعد.
• /literature لفصول Treasure Island.
الدروس حتوصلك${plural ? 'م' : ''} في الخاص.`;
  for (const command of ['/spine', '/grammar', '/literature']) {
    entities.push({
      type: 'code',
      offset: text.indexOf(command),
      length: command.length
    });
  }
  return { text, entities };
}

function getTelegramCourseSelectionMessage() {
  return `أهلين بيك 😍 اتسجلت معانا خلاص.

اختار المسار البتبدأ بيه بإرسال واحد من الأوامر دي:
• /spine لدروس SPINE.
• /grammar لدروس القواعد.
• /literature لفصول Treasure Island.

لو عندك تقدم سابق، حتواصل من الدرس الجاي. وللقواعد تقدر تستخدم /lesson كاختصار.
لما تجاوب تمرين الحصة كامل وكل إجاباتك تكون صحيحة، حنحتفل بيك في القروب.

للمساعدة رسل /help

أو راسل مستر مازن هنا
@eschoolsd`;
}

function getTelegramStudentHelpMessage() {
  return `مساعدة استخدام بوت الدروس 📚

• أول مرة: افتح المحادثة الخاصة مع @eSchoolsdBot واضغط Start.

• اختار المسار بإرسال الأمر في الخاص: /grammar للقواعد، /spine لدروس SPINE، أو /literature لفصول Treasure Island. /lesson اختصار للقواعد.

• أرسل إجابات التمرين كنص في الخاص. لو في إجابات محتاجة تصحيح، حأحدد أرقام الأسئلة البتحتاج تعيدها.

• تقدر تبدّل المسار في أي وقت. تقدمك في التمرين الحالي محفوظ، ولما ترجع للمسار حتواصل من نفس الدرس.

• أرسل /previous للرجوع للحصة السابقة، أو /next للانتقال للحصة الجاية. الحصص التي تستلمها تُحفظ في سجل دروسك.

• أرسل /payment لمعرفة حالة الدفع، أو /paid لإرسال بلاغ للمراجعة. أرسل صورة الإيصال في الخاص.

• في الخاص أرسل /goal لاختيار هدف أسبوعي من 1 إلى 7 حصص. حأرسل ليك ملخصًا كل يوم اثنين الساعة 6 مساءً بتوقيت السودان، وتقدر توقفه بـ /goal_off.

• في الخاص أرسل /reminder 18:30 لاختيار زمن تذكير يومي اختياري (بتوقيت السودان)، أو /reminder_off لإيقافه. تذكير التمرين بعد 8 ساعات يظل منفصلًا.

• لما تجاوب تمرين الحصة كامل وكل إجاباتك تكون صحيحة، حنحتفل بيك في القروب.

• أرسل /help في أي وقت لعرض المساعدة تاني.`;
}

function isPrivateChatUnavailable(error) {
  return /bot can't initiate conversation|bot was blocked by the user|previously blocked|user is deactivated|chat not found|have no rights to send/i.test(error.message);
}

export class TelegramBotApi {
  constructor(token, fetchImpl = globalThis.fetch) {
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('Telegram bot token is required.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('This Node.js version must provide the built-in fetch API.');
    }
    this.token = token.trim();
    this.fetchImpl = fetchImpl;
  }

  async request(method, parameters = {}, { upload = false } = {}) {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const isForm = parameters instanceof FormData;
    const options = {
      method: 'POST',
      signal: AbortSignal.timeout(upload ? TELEGRAM_UPLOAD_TIMEOUT_MS : NETWORK_TIMEOUT_MS),
      ...(isForm
        ? { body: parameters }
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(parameters)
          })
    };
    if (upload && !isForm) {
      throw new Error(`Telegram ${method} upload requires multipart form data.`);
    }

    let response;
    try {
      response = await this.fetchImpl(url, options);
    } catch (error) {
      const reason = error?.cause?.code || error?.name || 'network error';
      throw new Error(`Telegram ${method} request failed before a response was received (${reason}).`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Telegram ${method} returned an invalid response.`);
    }
    if (!response.ok || payload?.ok !== true) {
      const reason = typeof payload?.description === 'string'
        ? payload.description
        : `HTTP ${response.status}`;
      throw new Error(`Telegram ${method} failed: ${reason}`);
    }
    return payload.result;
  }

  getMe() {
    return this.request('getMe');
  }

  getWebhookInfo() {
    return this.request('getWebhookInfo');
  }

  getUpdates(offset) {
    return this.request('getUpdates', {
      offset,
      timeout: LONG_POLL_SECONDS,
      allowed_updates: ['message']
    });
  }

  getFile(fileId) {
    return this.request('getFile', { file_id: fileId });
  }

  async downloadFile(filePath, maxBytes = TELEGRAM_MAX_RECEIPT_BYTES) {
    if (typeof filePath !== 'string' || !filePath ||
        filePath.startsWith('/') || filePath.split(/[\\/]/).includes('..')) {
      throw new Error('Telegram returned an invalid receipt file path.');
    }
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
      });
    } catch {
      throw new Error('Telegram receipt download failed before a response was received.');
    }
    if (!response.ok) throw new Error(`Telegram receipt download failed: HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maxBytes) {
      throw new Error(`Telegram receipt image must be between 1 byte and ${Math.round(maxBytes / (1024 * 1024))} MB.`);
    }
    return buffer;
  }

  sendMessage(chatId, text, replyToMessageId, entities) {
    return this.request('sendMessage', {
      chat_id: chatId,
      text,
      ...(Array.isArray(entities) && entities.length ? { entities } : {}),
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {})
    });
  }

  sendVideo(chatId, video, caption, replyToMessageId, onProgress) {
    if (this.fetchImpl === globalThis.fetch) {
      return this.requestVideoUpload(chatId, video, caption, replyToMessageId, onProgress);
    }
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('video', new Blob([video], { type: 'video/mp4' }), 'lesson.mp4');
    form.append('caption', caption || '');
    if (replyToMessageId) {
      form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
    }
    return this.request('sendVideo', form, { upload: true }).then(result => {
      onProgress?.(video.length, video.length);
      return result;
    });
  }

  async requestVideoUpload(chatId, video, caption, replyToMessageId, onProgress) {
    const boundary = `----TelegramBoundary${randomUUID().replaceAll('-', '')}`;
    const fields = [
      ['chat_id', String(chatId)],
      ['caption', caption || ''],
      ...(replyToMessageId
        ? [['reply_parameters', JSON.stringify({ message_id: replyToMessageId })]]
        : [])
    ];
    const prefix = Buffer.concat([
      ...fields.flatMap(([name, value]) => [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      ]),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="lesson.mp4"\r\nContent-Type: video/mp4\r\n\r\n`)
    ]);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = prefix.length + video.length + suffix.length;
    const url = new URL(`https://api.telegram.org/bot${this.token}/sendVideo`);

    let response;
    try {
      response = await new Promise((resolve, reject) => {
        const request = https.request(url, {
          method: 'POST',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': contentLength
          },
          signal: AbortSignal.timeout(TELEGRAM_UPLOAD_TIMEOUT_MS)
        }, resolve);
        request.on('error', reject);

        const chunks = [prefix];
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < video.length; offset += chunkSize) {
          chunks.push(video.subarray(offset, Math.min(offset + chunkSize, video.length)));
        }
        chunks.push(suffix);
        let videoBytesWritten = 0;
        const reportProgress = loaded => {
          try {
            onProgress?.(loaded, video.length);
          } catch (error) {
            request.destroy(error);
          }
        };

        const writeNext = index => {
          if (index >= chunks.length) {
            request.end();
            return;
          }
          const chunk = chunks[index];
          request.write(chunk, error => {
            if (error) {
              request.destroy(error);
              return;
            }
            if (index > 0 && index < chunks.length - 1) {
              videoBytesWritten += chunk.length;
              reportProgress(videoBytesWritten);
            }
            if (request.destroyed) return;
            writeNext(index + 1);
          });
        };
        writeNext(0);
      });
    } catch (error) {
      const reason = error?.cause?.code || error?.code || error?.name || 'network error';
      throw new Error(`Telegram sendVideo request failed before a response was received (${reason}).`);
    }

    let payload;
    try {
      const responseBody = await new Promise((resolve, reject) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      });
      payload = JSON.parse(responseBody);
    } catch {
      throw new Error('Telegram sendVideo returned an invalid response.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300 || payload?.ok !== true) {
      const reason = typeof payload?.description === 'string'
        ? payload.description
        : `HTTP ${response.statusCode}`;
      throw new Error(`Telegram sendVideo failed: ${reason}`);
    }
    onProgress?.(video.length, video.length);
    return payload.result;
  }
}

export class TelegramLessonAgent {
  constructor({
    bot,
    groupId,
    classGroups = {},
    lessonManager: lessonManagerInstance = lessonManager,
    evaluateTask = evaluateStudentTask,
    videoPathResolver = resolveLessonVideoPath,
    progressFile = DEFAULT_PROGRESS_FILE,
    defaultGrade = config.defaultStudentGrade,
    maxVideoBytes = TELEGRAM_MAX_VIDEO_BYTES,
    lessonSkipQueue = new LessonSkipQueue(TELEGRAM_LESSON_SKIP_REQUESTS_FILE),
    mediaActivityFile = TELEGRAM_AGENT_MEDIA_ACTIVITY_FILE,
    mediaRetryRequestsFile = TELEGRAM_AGENT_MEDIA_RETRY_REQUESTS_FILE,
    blockedRecipientsFile = TELEGRAM_BLOCKED_RECIPIENTS_FILE,
    paymentLedger = createStudentPaymentLedger(STUDENT_PAYMENT_LEDGER_FILE),
    paymentReceiptImageDirectory = PAYMENT_RECEIPT_IMAGE_DIRECTORY,
    scanReceipt = scanPaymentReceipt,
    motivationTimeZone = STUDENT_MOTIVATION_TIME_ZONE,
    studentGenderStore = createTelegramStudentGenderStore(),
    logger = console
  }) {
    if (!bot || typeof bot.sendMessage !== 'function' || typeof bot.sendVideo !== 'function') {
      throw new Error('A Telegram Bot API client is required.');
    }
    this.bot = bot;
    this.groupId = groupId ? String(groupId).trim() : '';
    this.lessonManager = lessonManagerInstance;
    this.evaluateTask = evaluateTask;
    this.videoPathResolver = videoPathResolver;
    this.progressFile = progressFile;
    this.defaultGrade = defaultGrade;
    if (!classGroups || typeof classGroups !== 'object' || Array.isArray(classGroups)) {
      throw new Error('Telegram class groups must be a JSON object mapping group IDs to grade keys.');
    }
    this.groupGrades = new Map();
    if (this.groupId) this.groupGrades.set(this.groupId, this.defaultGrade);
    for (const [chatId, grade] of Object.entries(classGroups)) {
      if (!/^-?\d+$/.test(chatId) || typeof grade !== 'string' || !grade.trim()) {
        throw new Error('Each Telegram class group must have a numeric chat ID and a grade key.');
      }
      this.groupGrades.set(chatId, grade.trim());
    }
    this.maxVideoBytes = maxVideoBytes;
    this.lessonSkipQueue = lessonSkipQueue;
    this.mediaActivityFile = mediaActivityFile;
    this.mediaRetryRequestsFile = mediaRetryRequestsFile;
    this.blockedRecipientsFile = blockedRecipientsFile;
    this.paymentLedger = paymentLedger;
    this.paymentReceiptImageDirectory = paymentReceiptImageDirectory;
    this.scanReceipt = scanReceipt;
    this.motivationTimeZone = motivationTimeZone;
    this.studentGenderStore = studentGenderStore;
    this.logger = logger;
    this.processingLessonSkips = false;
    this.lastScoreMessageSentAt = 0;
    this.processingAnswerReminders = false;
    this.processingMediaRetries = false;
    this.progress = readJsonFile(progressFile, {});
    if (!this.progress || typeof this.progress !== 'object' || Array.isArray(this.progress)) {
      throw new Error(`Invalid Telegram lesson progress in ${progressFile}.`);
    }
    let clearedPendingGrammarSelection = false;
    for (const state of Object.values(this.progress)) {
      if (state.pendingTelegramLessonTrack) {
        delete state.pendingTelegramLessonTrack;
        clearedPendingGrammarSelection = true;
      }
    }
    if (clearedPendingGrammarSelection) this.saveProgress();
    const sendMessage = bot.sendMessage.bind(bot);
    const sendVideo = bot.sendVideo.bind(bot);
    this.bot.sendMessage = async (chatId, text, ...args) => {
      if (isTelegramPrivateChatBlocked(chatId, this.blockedRecipientsFile)) {
        throw new Error('Telegram private chat was previously blocked; send skipped.');
      }
      const studentEntry = Object.entries(this.progress).find(([, state]) =>
        state.telegramPrivateChatId &&
        String(state.telegramPrivateChatId) === String(chatId));
      const override = studentEntry
        ? this.studentGenderStore.list()[studentEntry[0]]
        : null;
      const gender = getTelegramStudentGender(studentEntry?.[1], override).value;
      const personalizedText = personalizeTelegramMessage(text, gender);
      let result;
      try {
        result = await sendMessage(chatId, personalizedText, ...args);
      } catch (error) {
        if (isTelegramBotBlockedError(error)) {
          markTelegramPrivateChatBlocked(chatId, this.blockedRecipientsFile);
          this.logger.info('[Telegram] A recipient blocked the bot; future private messages will be skipped.');
        }
        throw error;
      }
      if (studentEntry && typeof personalizedText === 'string') {
        this.recordTelegramChatMessage(studentEntry[0], 'bot', personalizedText);
      }
      return result;
    };
    this.bot.sendVideo = async (chatId, video, caption, ...args) => {
      if (isTelegramPrivateChatBlocked(chatId, this.blockedRecipientsFile)) {
        throw new Error('Telegram private chat was previously blocked; send skipped.');
      }
      const studentEntry = Object.entries(this.progress).find(([, state]) =>
        state.telegramPrivateChatId &&
        String(state.telegramPrivateChatId) === String(chatId));
      let result;
      try {
        result = await sendVideo(chatId, video, caption, ...args);
      } catch (error) {
        if (isTelegramBotBlockedError(error)) {
          markTelegramPrivateChatBlocked(chatId, this.blockedRecipientsFile);
          this.logger.info('[Telegram] A recipient blocked the bot; future private messages will be skipped.');
        }
        throw error;
      }
      if (studentEntry) {
        this.recordTelegramChatMessage(
          studentEntry[0],
          'bot',
          `Video lesson${caption ? `: ${caption}` : ' sent.'}`
        );
      }
      return result;
    };
    this.discoveredGroupIds = new Set();
    this.ignoredGroupIds = new Set();
    this.studentOperations = new Map();
  }

  async handleUpdate(update, onProgress) {
    const reportProgress = detail => {
      if (typeof onProgress === 'function') onProgress(detail);
    };
    const message = update?.message;
    if (!message) return;
    const isGroupMemberAddition = Array.isArray(message.new_chat_members) &&
      message.new_chat_members.length > 0;
    if (Number.isSafeInteger(message.from?.id) &&
        IGNORED_TELEGRAM_USER_IDS.has(String(message.from.id)) &&
        !isGroupMemberAddition) {
      this.logger.info(`[Telegram] Ignoring messages from configured admin user ${message.from.id}.`);
      return;
    }
    if (message.chat?.type === 'private') {
      await this.handlePrivateUpdate(message, reportProgress);
      return;
    }
    if (!isGroupChat(message.chat)) return;

    const chatId = String(message.chat.id);
    if (this.groupGrades.size === 0) {
      if (!this.discoveredGroupIds.has(chatId)) {
        this.discoveredGroupIds.add(chatId);
        this.logger.info(
          `[Telegram] Group detected: ${chatId}. Add it to TELEGRAM_GROUP_ID or TELEGRAM_CLASS_GROUPS and restart to enable lesson replies.`
        );
      }
      return;
    }
    const groupGrade = this.groupGrades.get(chatId);
    if (!groupGrade) {
      if (!this.ignoredGroupIds.has(chatId)) {
        this.ignoredGroupIds.add(chatId);
        this.logger.info(
          `[Telegram] Ignoring messages from group ${chatId}; it does not match TELEGRAM_GROUP_ID or TELEGRAM_CLASS_GROUPS.`
        );
      }
      return;
    }
    if (isGroupMemberAddition) {
      reportProgress('Recording group join');
      const eventDate = Number.isSafeInteger(message.date) && message.date > 0
        ? new Date(message.date * 1000)
        : null;
      const joinedAt = eventDate && Number.isFinite(eventDate.getTime())
        ? eventDate.toISOString()
        : new Date().toISOString();
      let recorded = false;
      const studentsToWelcome = [];
      for (const user of message.new_chat_members) {
        if (!Number.isSafeInteger(user?.id) || user.is_bot ||
            IGNORED_TELEGRAM_USER_IDS.has(String(user.id))) continue;
        const studentKey = getProgressKey(chatId, user.id);
        const previous = this.progress[studentKey] || {};
        if (!previous.telegramPrivateChatId && !previous.onboardingInstructionsSentAt) {
          studentsToWelcome.push({ user, studentKey });
        }
        this.progress[studentKey] = {
          ...previous,
          grade: groupGrade,
          status: previous.status || 'awaiting_content',
          telegramChatId: chatId,
          telegramUserId: user.id,
          telegramUsername: user.username || previous.telegramUsername || '',
          name: getStudentName(user),
          groupJoinedAt: previous.groupJoinedAt || joinedAt
        };
        recorded = true;
      }
      if (recorded) this.saveProgress();
      if (studentsToWelcome.length) {
        reportProgress(`Onboarding ${studentsToWelcome.length} new student${studentsToWelcome.length === 1 ? '' : 's'}`);
        const instructions = getNewStudentInstructions(
          studentsToWelcome.map(({ user }) => user)
        );
        try {
          await this.bot.sendMessage(
            chatId,
            instructions.text,
            message.message_id,
            instructions.entities
          );
          const sentAt = new Date().toISOString();
          for (const { studentKey } of studentsToWelcome) {
            this.progress[studentKey].onboardingInstructionsSentAt = sentAt;
          }
          this.saveProgress();
        } catch (error) {
          this.logger.error(
            `[Telegram] Could not send new-student instructions in group ${chatId}: ${error.message}`
          );
        }
      }
      return;
    }
    if (!Number.isSafeInteger(message.from?.id)) {
      this.logger.info('[Telegram] Ignoring a group message without an individual Telegram user sender.');
      return;
    }
    if (message.from.is_bot) return;

    this.lessonManager.refreshLessonsConfig?.();
    const studentKey = getProgressKey(chatId, message.from.id);
    const studentName = getStudentName(message.from);
    const currentStudent = this.progress[studentKey] || {
      status: 'awaiting_content'
    };
    currentStudent.grade = groupGrade;
    currentStudent.telegramChatId = chatId;
    currentStudent.telegramUserId = message.from.id;
    currentStudent.telegramUsername = message.from.username || '';
    currentStudent.name = studentName;
    currentStudent.lastTelegramGroupActivityAt = new Date().toISOString();
    this.progress[studentKey] = currentStudent;
    this.saveProgress();
    const messageKind = typeof message.text === 'string'
      ? 'text'
      : typeof message.caption === 'string'
        ? 'captioned media'
        : 'media without text';
    this.logger.info(
      `[Telegram] Received ${messageKind} in the configured group from user ${message.from.id}.`
    );
    const text = typeof message.text === 'string'
      ? message.text.trim()
      : typeof message.caption === 'string'
        ? message.caption.trim()
        : '';
    if (text) {
      this.recordTelegramChatMessage(studentKey, 'student', text, {
        initialState: {
          grade: groupGrade,
          telegramChatId: chatId,
          telegramUserId: message.from.id,
          telegramUsername: message.from.username || '',
          name: studentName
        }
      });
    }
    if (text && !text.startsWith('/')) {
      this.recordLatestStudentMessage(studentKey, {
        text,
        source: 'group',
        messageId: message.message_id
      }, {
        grade: groupGrade,
        telegramChatId: chatId,
        telegramUserId: message.from.id,
        telegramUsername: message.from.username || '',
        name: studentName
      });
    }
    this.recordStudentGenderEvidence(studentKey, text);
    if (!text) {
      if (Array.isArray(message.photo) && message.photo.length) {
        await this.sendPrivateNotice(
          studentKey,
          'عشان خصوصيتك، أرسل إيصال الدفع في الخاص. افتح المحادثة الخاصة معاي واضغط Start، وبعدها أرسل صورة الإيصال.'
        );
        return;
      }
      this.logger.info('[Telegram] Media-only messages are not graded; submit task answers as text.');
      return;
    }

    if (isHelpCommand(text)) {
      await this.bot.sendMessage(chatId, getTelegramStudentHelpMessage(), message.message_id);
      return;
    }

    if (isTelegramPaymentQuestion(text)) {
      if (this.progress[studentKey]?.telegramPrivateChatId) {
        await this.sendPrivateNotice(studentKey, STUDENT_PAYMENT_INFORMATION_MESSAGE);
      } else {
        const instructions = getNewStudentInstructions([message.from]);
        await this.bot.sendMessage(
          chatId,
          instructions.text,
          message.message_id,
          instructions.entities
        );
      }
      return;
    }

    if (isPaymentStatusCommand(text)) {
      const state = this.progress[studentKey];
      if (state?.telegramPrivateChatId) {
        const lessonStartedAt = getLessonPaymentStartAt(state);
        if (!lessonStartedAt) {
          await this.sendPrivateNotice(
            studentKey,
            'فترة الاشتراك بتبدأ من يوم استلام أول درس. حتقدر تتابع حالة الدفع بعد ما يبدأ الدرس.'
          );
          return;
        }
        const payment = this.paymentLedger.getCurrent(
          studentKey,
          lessonStartedAt
        );
        await this.bot.sendMessage(
          state.telegramPrivateChatId,
          formatStudentPaymentStatus(payment)
        );
      } else {
        this.logger.info(
          `[Telegram] Could not send payment status to ${studentKey}; no private chat has been started.`
        );
      }
      return;
    }

    if (isPaymentClaimCommand(text) || isExplicitPaidClaim(text)) {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, chatId, message.from);
        const state = this.progress[studentKey];
        const lessonStartedAt = getLessonPaymentStartAt(state);
        if (!lessonStartedAt) {
          await this.sendPrivateNotice(
            studentKey,
            'فترة الاشتراك بتبدأ من يوم استلام أول درس. أرسل /paid بعد ما يبدأ الدرس.'
          );
          return;
        }
        const payment = this.paymentLedger.recordClaim(studentKey, {
          enrolledAt: lessonStartedAt,
          source: 'telegram-claim'
        });
        await this.sendPrivateNotice(
          studentKey,
          payment.status === 'paid'
            ? 'دفعك للفترة الحالية متأكد من قبل. حفظت البلاغ الجديد للرجوع ليه.'
            : 'وصل إشعار الدفع للمراجعة، حنراجعه وبأكد ليك. موفق يا رب! أرسل /payment في الخاص عشان تعرف حالة الدفع.'
        );
        this.logger.info(`[Telegram] Recorded a payment claim for ${studentKey} as ${payment.status}.`);
      });
      return;
    }

    const requestedTrack = getTelegramTrackCommand(text);
    if (requestedTrack === 'literature' || requestedTrack === 'spine') {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, chatId, message.from);
        const currentState = this.progress[studentKey];
        const privateChatId = currentState.telegramPrivateChatId;
        if (!privateChatId) {
          await this.sendPrivateStartInstructions(chatId, studentKey, message, reportProgress);
          return;
        }
        try {
          const delivered = await this.requestNextTelegramTrackLesson(
            studentKey,
            requestedTrack,
            privateChatId,
            reportProgress
          );
          if (delivered) {
            await this.bot.sendMessage(
              chatId,
              'تمام، بعت ليك الدرس في الخاص. كل التوفيق يا رب!',
              message.message_id
            );
          }
        } catch (error) {
          if (isPrivateChatUnavailable(error)) {
            delete currentState.telegramPrivateChatId;
            this.saveProgress();
            await this.sendPrivateStartInstructions(chatId, studentKey, message, reportProgress);
            return;
          }
          this.logger.error(
            `[Telegram] Could not send the next ${requestedTrack} lesson to ${studentKey}: ${error.message}`
          );
          await this.bot.sendMessage(
            chatId,
            'ما قدرت أرسل الدرس في الخاص هسي. جرّب تاني بعد شوية.',
            message.message_id
          );
        }
      });
      return;
    }
    if (isLessonRequest(text)) {
      this.logger.info(`[Telegram] Starting or resuming a lesson for ${studentName}.`);
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, chatId, message.from);
        const currentState = this.progress[studentKey];
        delete currentState.pendingTelegramLessonTrack;
        const now = Date.now();
        const lastLessonRequestAt = Date.parse(currentState.lastLessonRequestAt || '');
        const sameRequestedLesson =
          (currentState.lastLessonRequestLessonId || null) ===
          (currentState.currentLessonId || null);
        const pendingFirstDelivery = currentState.lastLessonRequestLessonId === null;
        if ((sameRequestedLesson || pendingFirstDelivery) &&
            Number.isFinite(lastLessonRequestAt) &&
            now - lastLessonRequestAt < TELEGRAM_LESSON_REQUEST_COOLDOWN_MS &&
            ['awaiting_task', 'awaiting_reattempt', 'awaiting_content'].includes(currentState.status)) {
          await this.bot.sendMessage(
            chatId,
            'حسابك مسجل معانا وطلبك وصل قبل شوية. يرجى فتح الخاص مع @eSchoolsdBot واضغط Start لو لسه، وراجع آخر رسالة هناك.',
            message.message_id
          );
          return;
        }
        const privateChatId = currentState.telegramPrivateChatId;
        if (!privateChatId) {
          reportProgress('Sending private-chat setup instructions');
          currentState.lastLessonRequestAt = new Date(now).toISOString();
          currentState.lastLessonRequestLessonId = currentState.currentLessonId || null;
          this.saveProgress();
          await this.sendPrivateStartInstructions(chatId, studentKey, message, reportProgress);
          return;
        }
        recordTelegramLessonAnnouncementOptIn(currentState);
        currentState.lastLessonRequestAt = new Date(now).toISOString();
        currentState.lastLessonRequestLessonId = currentState.currentLessonId || null;
        this.saveProgress();
        try {
          await this.startOrResumeLesson(privateChatId, studentKey, undefined, reportProgress);
          const deliveredState = this.progress[studentKey];
          deliveredState.lastLessonRequestAt = new Date().toISOString();
          deliveredState.lastLessonRequestLessonId = deliveredState.currentLessonId || null;
          this.saveProgress();
          await this.bot.sendMessage(
            chatId,
            'تمام، رديت عليك في الخاص. راجع المحادثة هناك، كل التوفيق يا رب.',
            message.message_id
          );
        } catch (error) {
          this.logger.error(`[Telegram] Could not deliver a private lesson to ${studentKey}: ${error.message}`);
          if (isPrivateChatUnavailable(error)) {
            delete this.progress[studentKey].telegramPrivateChatId;
            this.saveProgress();
            await this.sendPrivateStartInstructions(chatId, studentKey, message, reportProgress);
            return;
          }
          await this.sendPrivateNotice(
            studentKey,
            'واجهت مشكلة فنية في إرسال الدرس في الخاص. جرّب /lesson تاني بعد شوية.'
          );
        }
      });
      return;
    }
    if (text.startsWith('/')) {
      this.logger.info(`[Telegram] Ignoring unsupported command from ${studentName}.`);
      return;
    }
    const activeTaskState = this.progress[studentKey];
    if (!activeTaskState?.telegramPrivateChatId) {
      this.logger.info(
        `[Telegram] Ignoring unrelated text from ${studentName}; they have no active lesson task or private chat. Send /lesson to start.`
      );
      return;
    }
    if (!hasActiveTelegramTask(activeTaskState)) {
      this.logger.info(`[Telegram] Ignoring unrelated group text from ${studentName}; no task is active.`);
      return;
    }
    if (await this.isTaskSubmissionForStudent(studentKey, text, studentName)) {
      await this.sendPrivateNotice(
        studentKey,
        'رسل لي الأجوبة في المحادثة الخاصة معاي.'
      );
    }
  }

  async sendPrivateStartInstructions(chatId, studentKey, message, reportProgress) {
    reportProgress?.('Sending private-chat setup instructions');
    const instructions = getNewStudentInstructions([message.from]);
    await this.bot.sendMessage(
      chatId,
      instructions.text,
      message.message_id,
      instructions.entities
    );
    const state = this.progress[studentKey];
    if (state) {
      state.onboardingInstructionsSentAt = new Date().toISOString();
      this.saveProgress();
    }
  }

  async sendPrivateNotice(studentKey, text) {
    const privateChatId = this.progress[studentKey]?.telegramPrivateChatId;
    if (!privateChatId) {
      this.logger.info(
        `[Telegram] Could not send a private notice to ${studentKey}; no private chat has been started.`
      );
      return false;
    }
    try {
      await this.bot.sendMessage(privateChatId, text);
      return true;
    } catch (error) {
      this.logger.error(
        `[Telegram] Could not send a private notice to ${studentKey}: ${error.message}`
      );
      return false;
    }
  }

  async isTaskSubmissionForStudent(studentKey, submission, studentName) {
    this.lessonManager.refreshLessonsConfig?.();
    const state = this.progress[studentKey];
    const { taskProgress, lesson } = this.getActiveTelegramTaskContext(state);
    if (!hasActiveTelegramTask(state) || !isReadyLesson(lesson) || lesson.hasExercise === false) {
      return false;
    }

    const taskVersionMatches = taskProgress.taskVersion === getLessonTaskVersion(lesson);
    const completedQuestionNumbers = new Set(
      taskVersionMatches
        ? [
            ...(Array.isArray(taskProgress.correctQuestionNumbers)
              ? taskProgress.correctQuestionNumbers
              : []),
            ...(Array.isArray(taskProgress.resolvedQuestionNumbers)
              ? taskProgress.resolvedQuestionNumbers
              : [])
          ].filter(number =>
            Number.isInteger(number) && number >= 1 && number <= lesson.answerKey.length)
        : []
    );
    const pendingQuestionNumbers = lesson.answerKey
      .map((_, index) => index + 1)
      .filter(number => !completedQuestionNumbers.has(number));
    if (pendingQuestionNumbers.length === 0) return false;

    try {
      const result = await this.evaluateTask(lesson, submission, studentName, {
        pendingQuestionNumbers
      });
      return result?.isTaskSubmission === true;
    } catch (error) {
      this.logger.error(
        `[Telegram] Could not classify a group message as a task submission for ${studentKey}: ${error.message}`
      );
      return false;
    }
  }

  getTelegramTrackLessons(studentKey, track) {
    this.lessonManager.refreshLessonsConfig?.();
    const state = this.progress[studentKey];
    return getTelegramTrackLessons(
      this.lessonManager.lessonsConfig,
      state?.grade || this.defaultGrade,
      track
    );
  }

  async requestNextTelegramTrackLesson(studentKey, track, chatId, reportProgress) {
    reportProgress?.(`Checking ${track === 'literature' ? 'Literature' : 'Spine'} lessons`);
    const state = this.progress[studentKey];
    if (hasActiveTelegramTask(state)) {
      this.lessonManager.refreshLessonsConfig?.();
      const { track: activeTrack, taskProgress, lesson } =
        this.getActiveTelegramTaskContext(state);
      const activeLessonId = activeTrack === 'grammar'
        ? state.currentLessonId
        : taskProgress?.activeLessonId;
      if (lesson?.id !== activeLessonId) {
        if (taskProgress) {
          taskProgress.status = 'lesson_unavailable';
          this.saveProgress();
        }
        this.logger.error(
          `[Telegram] ${activeTrack} lesson "${activeLessonId}" is no longer available for ${studentKey}; allowing a track change without grading against another lesson.`
        );
        await this.bot.sendMessage(
          chatId,
          'الدرس السابق اتنقل لمسار تاني؛ ما حأصحح إجابته بمفتاح مختلف. حأبدأ المسار اللي اخترته هسي.'
        );
      }
    }

    const lessons = this.getTelegramTrackLessons(studentKey, track);
    if (lessons.length === 0) {
      await this.bot.sendMessage(
        chatId,
        track === 'literature'
          ? 'ما في فصول Treasure Island جاهزة هسي.'
          : 'ما في دروس مستقلة جاهزة هسي.'
      );
      return false;
    }

    state.telegramLessonTracks ||= {};
    const trackState = state.telegramLessonTracks[track] || {};
    const completedLessonIds = new Set(
      Array.isArray(trackState.completedLessonIds) ? trackState.completedLessonIds : []
    );
    const nextLessonIndex = lessons.findIndex(lesson =>
      !completedLessonIds.has(lesson.id));
    if (nextLessonIndex < 0) {
      await this.bot.sendMessage(
        chatId,
        track === 'literature'
          ? 'أكملت كل فصول Treasure Island المتوفرة. برافو عليك!'
          : 'أكملت كل دروس Spine المتوفرة. برافو عليك!'
      );
      return false;
    }

    try {
      const lesson = lessons[nextLessonIndex];
      reportProgress?.(
        `Sending ${track === 'literature' ? 'Literature' : 'Spine'} lesson ${nextLessonIndex + 1}: ${lesson.title || lesson.id}`
      );
      await this.deliverTelegramTrackLesson(
        studentKey,
        track,
        lesson,
        nextLessonIndex
      );
    } catch (error) {
      this.logger.error(
        `[Telegram] Could not deliver the next ${track} lesson to ${studentKey}: ${error.message}`
      );
      await this.bot.sendMessage(
        chatId,
        'ما قدرت أرسل الدرس هسي. جرّب ترسل الأمر تاني بعد شوية.'
      );
      return false;
    }
    return true;
  }

  async deliverTelegramTrackLesson(studentKey, track, lesson, lessonIndex) {
    const state = this.progress[studentKey];
    const grade = state.grade || this.defaultGrade;
    const collectionId = track === 'literature' ? 'treasure_island' : 'standalone';
    const deliveryChatId = state.telegramPrivateChatId;
    if (!deliveryChatId) throw new Error(`No private Telegram chat is available for ${studentKey}.`);

    const videoPath = this.videoPathResolver(lesson.videoFile);
    const videoStats = fs.statSync(videoPath);
    if (!videoStats.isFile() || videoStats.size === 0) {
      throw new Error(`Telegram lesson video is missing or empty: ${videoPath}`);
    }
    if (videoStats.size > this.maxVideoBytes) {
      throw new Error(
        `Telegram lesson video exceeds the ${Math.ceil(this.maxVideoBytes / (1024 * 1024))} MB Bot API upload limit.`
      );
    }
    await this.sendLessonVideo({
      chatId: deliveryChatId,
      video: fs.readFileSync(videoPath),
      lesson,
      studentKey,
      grade,
      lessonIndex,
      collectionId
    });
    await this.bot.sendMessage(deliveryChatId, lesson.taskMessage);

    state.telegramLessonTracks ||= {};
    const trackState = state.telegramLessonTracks[track] || {};
    const taskVersion = getLessonTaskVersion(lesson);
    const isSameActiveLesson = trackState.activeLessonId === lesson.id &&
      trackState.taskVersion === taskVersion;
    const deliveredAt = new Date().toISOString();
    state.telegramLessonTracks[track] = {
      ...trackState,
      activeLessonId: lesson.id,
      status: 'awaiting_task',
      taskVersion,
      deliveredAt,
      correctQuestionNumbers: isSameActiveLesson
        ? trackState.correctQuestionNumbers || []
        : [],
      resolvedQuestionNumbers: isSameActiveLesson
        ? trackState.resolvedQuestionNumbers || []
        : [],
      retryQuestionNumbers: isSameActiveLesson
        ? trackState.retryQuestionNumbers || []
        : []
    };
    state.firstLessonStartedAt ||= getLessonPaymentStartAt(state) || deliveredAt;
    state.activeTelegramTrack = track;
    delete state.pendingTelegramLessonTrack;
    this.saveProgress();
  }

  recordTelegramChatMessage(studentKey, role, text, { initialState } = {}) {
    if (typeof text !== 'string' || !text.trim()) return;
    const state = this.progress[studentKey] || (initialState
      ? { ...initialState, status: 'awaiting_content' }
      : null);
    if (!state) return;
    const messages = Array.isArray(state.telegramChatHistory)
      ? state.telegramChatHistory
      : [];
    messages.push({
      role,
      text: text.trim().slice(0, 4096),
      timestamp: new Date().toISOString()
    });
    state.telegramChatHistory = messages.slice(-TELEGRAM_CHAT_HISTORY_LIMIT);
    this.progress[studentKey] = state;
    this.saveProgress();
  }

  recordStudentActivity(studentKey, chatId, user, { submission = false } = {}) {
    const now = Date.now();
    const state = this.progress[studentKey] || {
      grade: this.defaultGrade,
      status: 'awaiting_content'
    };
    const activityTimestamps = Array.isArray(state.activityTimestamps)
      ? state.activityTimestamps.filter(timestamp =>
          Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) >= now - 90 * 24 * 60 * 60 * 1000)
      : [];
    activityTimestamps.push(new Date(now).toISOString());

    const joinedAt = state.joinedAt || new Date(now).toISOString();
    const nameGender = inferTelegramGenderFromName(getStudentName(user));
    const keepSelfDescription = state.inferredGenderSource === 'inferred from self-description';
    this.progress[studentKey] = {
      ...state,
      grade: state.grade || this.defaultGrade,
      telegramChatId: String(chatId),
      telegramUserId: user.id,
      telegramUsername: user.username || '',
      name: getStudentName(user),
      inferredGender: keepSelfDescription ? state.inferredGender : nameGender,
      inferredGenderSource: keepSelfDescription
        ? state.inferredGenderSource
        : nameGender === 'female' ? 'inferred from name' : 'unknown',
      joinedAt,
      enrolledAt: state.enrolledAt || joinedAt,
      lastActivityAt: new Date(now).toISOString(),
      submissionsReceived: (state.submissionsReceived || 0) + Number(submission),
      activityTimestamps
    };
    this.saveProgress();
  }

  recordStudentGenderEvidence(studentKey, text) {
    const gender = inferTelegramGenderFromMessage(text);
    const student = this.progress[studentKey];
    if (!student || gender === 'unknown') return;
    student.inferredGender = gender;
    student.inferredGenderSource = 'inferred from self-description';
    this.saveProgress();
  }

  findTelegramStudent(userId) {
    return Object.entries(this.progress)
      .filter(([, state]) =>
        String(state.telegramUserId) === String(userId) &&
        (this.groupGrades.size === 0 || this.groupGrades.has(String(state.telegramChatId))))
      .sort((left, right) =>
        Date.parse(right[1].lastTelegramGroupActivityAt || right[1].lastActivityAt || '') -
        Date.parse(left[1].lastTelegramGroupActivityAt || left[1].lastActivityAt || ''))[0] || null;
  }

  recordLatestStudentMessage(studentKey, message, initialState = {}) {
    const state = this.progress[studentKey] || {
      ...initialState,
      status: 'awaiting_content'
    };
    state.lastStudentMessage = {
      text: message.text.slice(0, 4096),
      receivedAt: new Date().toISOString(),
      source: message.source,
      messageId: Number.isSafeInteger(message.messageId) ? message.messageId : null
    };
    this.progress[studentKey] = state;
    this.saveProgress();
  }

  async handlePrivateUpdate(message, reportProgress) {
    const userId = message.from?.id;
    if (!Number.isSafeInteger(userId) || message.from.is_bot) return;
    if (clearTelegramPrivateChatBlocked(
      message.chat?.id,
      this.blockedRecipientsFile
    )) {
      this.logger.info('[Telegram] A recipient resumed the private chat; private messaging is re-enabled.');
    }
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const found = this.findTelegramStudent(userId);
    if (found && text) this.recordTelegramChatMessage(found[0], 'student', text);
    if (isHelpCommand(text)) {
      await this.bot.sendMessage(String(message.chat.id), getTelegramStudentHelpMessage(), message.message_id);
      return;
    }
    if (isTelegramPaymentQuestion(text)) {
      await this.bot.sendMessage(String(message.chat.id), STUDENT_PAYMENT_INFORMATION_MESSAGE);
      return;
    }
    if (!found) {
      const isRegistrationOrSupportedCommand =
        /^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text) ||
        isHelpCommand(text) ||
        isPaymentStatusCommand(text) ||
        isPaymentClaimCommand(text) ||
        isExplicitPaidClaim(text) ||
        getTelegramTrackCommand(text) !== null ||
        getStudentGoalCommand(text) !== null ||
        getStudentReminderCommand(text) !== null ||
        getLessonNavigationCommand(text) !== null ||
        getTelegramAnnouncementPreferenceCommand(text) !== null ||
        getTelegramCelebrationPreferenceCommand(text) !== null ||
        getNumberedLessonCommand(text) !== null ||
        isLessonRequest(text);
      if (!isRegistrationOrSupportedCommand) return;
      await this.bot.sendMessage(
        String(message.chat.id),
        text && (isLessonRequest(text) || ['literature', 'spine'].includes(getTelegramTrackCommand(text)))
          ? 'حسابك ما اتربط بقروب الدروس لسه. أرسل /lesson مرة واحدة في القروب، وبعدها افتح الخاص واضغط Start. ما محتاج تكرر الأمر هنا.'
          : 'حسابك ما اتربط بقروب الدروس لسه. أرسل /lesson في قروب الدروس، وبعدها افتح الخاص واضغط Start.'
      );
      return;
    }
    const [studentKey, initialState] = found;
    let state = initialState;
    if (text && !text.startsWith('/')) {
      this.recordLatestStudentMessage(studentKey, {
        text,
        source: 'private',
        messageId: message.message_id
      });
      state = this.progress[studentKey];
    }
    this.recordStudentGenderEvidence(studentKey, text);
    state = this.progress[studentKey];
    state.telegramPrivateChatId = String(message.chat.id);
    this.saveProgress();
    this.saveProgress();
    if (isAcknowledgmentMessage(text)) return;
    const announcementOptIn = getTelegramAnnouncementPreferenceCommand(text);
    if (announcementOptIn !== null) {
      state.telegramAnnouncementsOptIn = announcementOptIn;
      state.telegramAnnouncementsOptInAt = announcementOptIn
        ? new Date().toISOString()
        : null;
      this.saveProgress();
      await this.bot.sendMessage(
        String(message.chat.id),
        announcementOptIn
          ? 'تم تسجيل موافقتك على رسائل الإعلانات الخاصة. تقدر توقفها في أي وقت بإرسال /announcements_off.'
          : 'تم إيقاف رسائل الإعلانات الخاصة. ما حنرسل ليك إعلانات تاني إلا لو فعلتها بإرسال /announcements_on.'
      );
      return;
    }
    const celebrationOptIn = getTelegramCelebrationPreferenceCommand(text);
    if (celebrationOptIn !== null) {
      await this.bot.sendMessage(
        String(message.chat.id),
        'الاحتفال باسمك في القروب بيحصل تلقائياً بعد ما تجاوب تمرين الحصة كامل وكل إجاباتك تكون صحيحة.'
      );
      return;
    }
    const requestedTrack = getTelegramTrackCommand(text);
    if (requestedTrack === 'literature' || requestedTrack === 'spine') {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, state.telegramChatId, message.from);
        await this.requestNextTelegramTrackLesson(
          studentKey,
          requestedTrack,
          String(message.chat.id),
          reportProgress
        );
      });
      return;
    }
    const goalCommand = getStudentGoalCommand(text);
    if (goalCommand) {
      this.recordStudentActivity(studentKey, state.telegramChatId, message.from);
      state = this.progress[studentKey];
      if (goalCommand.action === 'invalid') {
        await this.bot.sendMessage(
          String(message.chat.id),
          'أرسل هدفك كعدد من 1 إلى 7، مثال: /goal 3. أرسل /goal_off لو داير توقف الملخص الأسبوعي.'
        );
      } else if (goalCommand.action === 'off') {
        delete state.weeklyLessonGoal;
        delete state.weeklyGoalMessageSentFor;
        this.saveProgress();
        await this.bot.sendMessage(String(message.chat.id), 'تم إيقاف ملخص الهدف الأسبوعي. تقدر تختار هدف جديد في أي وقت بإرسال /goal 3.');
      } else if (goalCommand.action === 'set') {
        state.weeklyLessonGoal = goalCommand.goal;
        this.saveProgress();
        await this.bot.sendMessage(
          String(message.chat.id),
          `تم تسجيل هدفك: ${goalCommand.goal} ${goalCommand.goal === 1 ? 'حصة' : 'حصص'} في الأسبوع 🌟 حأرسل ليك ملخصًا لطيفًا كل يوم اثنين الساعة 6 مساءً بتوقيت السودان. غيّر الهدف بإرسال /goal 1 إلى /goal 7، أو أوقفه بـ /goal_off.`
        );
      } else {
        const currentGoal = state.weeklyLessonGoal;
        await this.bot.sendMessage(
          String(message.chat.id),
          Number.isInteger(currentGoal)
            ? `هدفك الحالي ${currentGoal} ${currentGoal === 1 ? 'حصة' : 'حصص'} في الأسبوع. أرسل /goal 1 إلى /goal 7 لتغييره، أو /goal_off لإيقافه.`
            : 'اختار هدفًا واقعيًا من 1 إلى 7 حصص في الأسبوع، مثال: /goal 3. حأرسل ليك ملخصًا كل يوم اثنين الساعة 6 مساءً بتوقيت السودان، وتقدر تغيّر الهدف أو توقفه في أي وقت.'
        );
      }
      return;
    }
    const reminderCommand = getStudentReminderCommand(text);
    if (reminderCommand) {
      this.recordStudentActivity(studentKey, state.telegramChatId, message.from);
      state = this.progress[studentKey];
      if (reminderCommand.action === 'invalid') {
        await this.bot.sendMessage(
          String(message.chat.id),
          'اكتب الزمن بصيغة 24 ساعة، مثال: /reminder 18:30. أرسل /reminder_off لإيقاف التذكير.'
        );
      } else if (reminderCommand.action === 'off') {
        delete state.dailyMotivationReminderTime;
        delete state.dailyMotivationReminderSentFor;
        this.saveProgress();
        await this.bot.sendMessage(String(message.chat.id), 'تم إيقاف تذكير الحصة اليومي. تقدر تختار زمن جديد بإرسال /reminder 18:30.');
      } else if (reminderCommand.action === 'set') {
        state.dailyMotivationReminderTime = reminderCommand.time;
        delete state.dailyMotivationReminderSentFor;
        this.saveProgress();
        await this.bot.sendMessage(
          String(message.chat.id),
          `تم ضبط تذكيرك اليومي على ${reminderCommand.time} بتوقيت السودان. حأذكرك بلطف لو عندك تمرين منتظر وما كنت نشطت اليوم. أرسل /reminder_off لإيقافه.`
        );
      } else {
        await this.bot.sendMessage(
          String(message.chat.id),
          state.dailyMotivationReminderTime
            ? `زمن تذكيرك اليومي ${state.dailyMotivationReminderTime} بتوقيت السودان. أرسل /reminder 18:30 لتغييره أو /reminder_off لإيقافه.`
            : 'ما عندك تذكير يومي مفعّل. اختار زمنًا بصيغة 24 ساعة، مثال: /reminder 18:30.'
        );
      }
      return;
    }
    if (isPaymentStatusCommand(text)) {
      const lessonStartedAt = getLessonPaymentStartAt(state);
      if (!lessonStartedAt) {
        await this.bot.sendMessage(
          String(message.chat.id),
          'فترة الاشتراك بتبدأ من يوم استلام أول درس. حتقدر تتابع حالة الدفع بعد ما يبدأ الدرس.'
        );
        return;
      }
      const payment = this.paymentLedger.getCurrent(
        studentKey,
        lessonStartedAt
      );
      await this.bot.sendMessage(String(message.chat.id), formatStudentPaymentStatus(payment));
      return;
    }

    const navigationCommand = getLessonNavigationCommand(text);
    if (navigationCommand) {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, state.telegramChatId, message.from);
        const currentState = this.progress[studentKey];
        currentState.telegramPrivateChatId = String(message.chat.id);
        await this.navigateLesson(
          String(message.chat.id),
          studentKey,
          navigationCommand,
          message.message_id
        );
      });
      return;
    }

    if (/^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text)) {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, state.telegramChatId, message.from);
        await this.bot.sendMessage(
          String(message.chat.id),
          getTelegramCourseSelectionMessage()
        );
      });
      return;
    }

    if (isPaymentClaimCommand(text) || isExplicitPaidClaim(text)) {
      const lessonStartedAt = getLessonPaymentStartAt(state);
      if (!lessonStartedAt) {
        await this.bot.sendMessage(
          String(message.chat.id),
          'فترة الاشتراك بتبدأ من يوم استلام أول درس. أرسل /paid بعد ما يبدأ الدرس.'
        );
        return;
      }
      const payment = this.paymentLedger.recordClaim(studentKey, {
        enrolledAt: lessonStartedAt,
        source: 'telegram-claim'
      });
      await this.bot.sendMessage(
        String(message.chat.id),
        payment.status === 'paid'
          ? 'دفعك للفترة الحالية متأكد من قبل. حفظت البلاغ الجديد للرجوع ليه.'
          : 'وصل إشعار الدفع للمراجعة، حنراجعه وبأكد ليك. موفق يا رب!'
      );
      return;
    }

    const requestedLessonNumber = getNumberedLessonCommand(text);
    if (requestedLessonNumber !== null) {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(
          studentKey,
          state.telegramChatId,
          message.from
        );
        const currentState = this.progress[studentKey];
        currentState.telegramPrivateChatId = String(message.chat.id);
        this.lessonManager.refreshLessonsConfig?.();
        const lessons = this.lessonManager.lessonsConfig[currentState.grade || this.defaultGrade]?.lessons;
        const lessonIndex = Array.isArray(lessons)
          ? lessons.findIndex(lesson => lesson.id === `lesson_${requestedLessonNumber}`)
          : -1;
        const lesson = lessons?.[lessonIndex];
        if (!isReadyLesson(lesson)) {
          await this.bot.sendMessage(
            String(message.chat.id),
            `ما لقيت الحصة رقم ${requestedLessonNumber} جاهزة. راجع رقم الحصة أو جرّب بعد ما يجهز التمرين والفيديو.`
          );
          return;
        }
        try {
          reportProgress?.(`Sending Grammar lesson ${requestedLessonNumber}: ${lesson.title || lesson.id}`);
          await this.deliverLesson(
            studentKey,
            currentState.grade || this.defaultGrade,
            lessonIndex,
            lesson
          );
        } catch (error) {
          this.logger.error(
            `[Telegram] Could not deliver requested lesson ${requestedLessonNumber} to ${studentKey}: ${error.message}`
          );
          await this.bot.sendMessage(
            String(message.chat.id),
            'ما قدرت أرسل ليك الحصة هسي بسبب مشكلة فنية. جرّب بعد شوية.'
          );
        }
      });
      return;
    }

    if (isLessonRequest(text)) {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, state.telegramChatId, message.from);
        const currentState = this.progress[studentKey];
        recordTelegramLessonAnnouncementOptIn(currentState);
        delete currentState.pendingTelegramLessonTrack;
        currentState.telegramPrivateChatId = String(message.chat.id);
        this.saveProgress();
        try {
          await this.startOrResumeLesson(
            String(message.chat.id),
            studentKey,
            message.message_id,
            reportProgress
          );
        } catch (error) {
          this.logger.error(`[Telegram] Could not deliver a private lesson to ${studentKey}: ${error.message}`);
          if (isPrivateChatUnavailable(error)) {
            delete this.progress[studentKey].telegramPrivateChatId;
            this.saveProgress();
          }
          await this.bot.sendMessage(
            String(message.chat.id),
            isPrivateChatUnavailable(error)
              ? 'ما قدرت أرسل ليك رسالة. أرسل /start في المحادثة الخاصة وبعدها جرّب /lesson.'
              : 'واجهت مشكلة فنية في إرسال الدرس. جرّب /lesson تاني بعد شوية.'
          );
        }
      });
      return;
    }

    if (Array.isArray(message.photo) && message.photo.length) {
      const lessonStartedAt = getLessonPaymentStartAt(state);
      if (!lessonStartedAt) {
        await this.bot.sendMessage(
          String(message.chat.id),
          'فترة الاشتراك بتبدأ من يوم استلام أول درس؛ أرسل الإيصال بعد ما يبدأ الدرس.'
        );
        return;
      }
      let receiptId = null;
      let receiptRecorded = false;
      try {
        const photo = [...message.photo].sort((left, right) =>
          (right.file_size || 0) - (left.file_size || 0))[0];
        if (photo.file_size > TELEGRAM_MAX_RECEIPT_BYTES) {
          throw new Error('Receipt image exceeds the 10 MB review limit.');
        }
        const file = await this.bot.getFile(photo.file_id);
        const image = await this.bot.downloadFile(file.file_path);
        const scan = await this.scanReceipt([{
          data: image,
          mimeType: 'image/jpeg'
        }], typeof message.caption === 'string' ? message.caption : '');
        if (!scan?.isPayment) {
          await this.bot.sendMessage(
            String(message.chat.id),
            'ما قدرت أتعرف على الإيصال كدفع مكتمل. أرسل صورة واضحة للإيصال أو أرسل /paid عشان نراجع البلاغ يدوياً.'
          );
          return;
        }
        receiptId = savePaymentReceiptImage(image, this.paymentReceiptImageDirectory);
        const payment = this.paymentLedger.recordClaim(studentKey, {
          enrolledAt: lessonStartedAt,
          source: 'telegram-receipt',
          details: { ...scan.details, receiptId }
        });
        receiptRecorded = true;
        await this.bot.sendMessage(
          String(message.chat.id),
          'وصل إشعار الدفع للمراجعة، حنراجعه وبأكد ليك. موفق يا رب!'
        );
      } catch (error) {
        if (receiptId && !receiptRecorded) {
          try {
            deletePaymentReceiptImage(receiptId, this.paymentReceiptImageDirectory);
          } catch (cleanupError) {
            this.logger.error(
              `[Telegram] Could not clean up an unrecorded receipt for ${studentKey}: ${cleanupError.message}`
            );
          }
        }
        this.logger.error(`[Telegram] Could not review a private receipt for ${studentKey}: ${error.message}`);
        await this.bot.sendMessage(
          String(message.chat.id),
          'ما قدرت أراجع الإيصال هسي، وما اتسجل الدفع كمدفوع. جرّب تاني بعد شوية أو أرسل /paid عشان نراجع البلاغ يدوياً.'
        );
      }
      return;
    }

    if (text && !text.startsWith('/') && hasActiveTelegramTask(state)) {
      const submittedTrack = state.activeTelegramTrack || 'grammar';
      const submittedLessonId = submittedTrack === 'grammar'
        ? state.currentLessonId
        : state.telegramLessonTracks?.[submittedTrack]?.activeLessonId;
      await this.runStudentOperation(studentKey, async () => {
        const currentState = this.progress[studentKey];
        const currentTaskState = getTrackProgress(currentState, submittedTrack);
        const currentTaskLessonId = submittedTrack === 'grammar'
          ? currentState?.currentLessonId
          : currentTaskState?.activeLessonId;
        if (!currentState || currentTaskLessonId !== submittedLessonId ||
            !['awaiting_task', 'awaiting_reattempt'].includes(currentTaskState?.status)) {
          await this.bot.sendMessage(
            String(message.chat.id),
            'الحصة اتغيرت قبل ما أراجع إجابتك. جاوب على تمرين آخر حصة وصلتك.'
          );
          return;
        }
        const studentName = getStudentName(message.from);
        this.recordStudentActivity(
          studentKey,
          currentState.telegramChatId,
          message.from,
          { submission: true }
        );
        currentState.telegramPrivateChatId = String(message.chat.id);
        await this.gradeSubmission({
          chatId: String(message.chat.id),
          studentKey,
          studentName,
          messageId: message.message_id,
          submission: text
        });
      });
      return;
    }

  }

  saveProgress() {
    saveJsonAtomically(this.progressFile, this.progress);
  }

  async runStudentOperation(studentKey, operation) {
    const previous = this.studentOperations.get(studentKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.studentOperations.set(studentKey, current);
    try {
      return await current;
    } finally {
      if (this.studentOperations.get(studentKey) === current) {
        this.studentOperations.delete(studentKey);
      }
    }
  }

  recoverPendingLessonSkips() {
    return this.lessonSkipQueue.recoverProcessing();
  }

  async processUncheckedTaskSubmissions({ limit = Infinity } = {}) {
    let processed = 0;
    for (const [studentKey, state] of Object.entries(this.progress)) {
      if (processed >= limit) break;
      const submission = state?.lastTaskSubmission;
      const track = submission?.track || state?.activeTelegramTrack || 'grammar';
      const taskProgress = getTrackProgress(state, track);
      const activeLessonId = track === 'grammar'
        ? state?.currentLessonId
        : taskProgress?.activeLessonId;
      const hasInterruptedCheck = Number.isFinite(
        Date.parse(submission?.checkingStartedAt || '')
      );
      if (!submission ||
          Number.isFinite(Date.parse(submission.checkedAt || '')) ||
          !['awaiting_task', 'awaiting_reattempt'].includes(taskProgress?.status) ||
          !state.telegramPrivateChatId ||
          submission.grade !== state.grade ||
          submission.lessonId !== activeLessonId ||
          typeof submission.text !== 'string' ||
          !submission.text.trim()) continue;

      const hasGradingProgress = !hasInterruptedCheck &&
        (taskProgress.status === 'awaiting_reattempt' ||
        [taskProgress.correctQuestionNumbers, taskProgress.resolvedQuestionNumbers,
          taskProgress.retryQuestionNumbers].some(numbers =>
          Array.isArray(numbers) && numbers.length > 0));
      if (hasGradingProgress) continue;

      try {
        await this.runStudentOperation(studentKey, async () => {
          processed += 1;
          this.lessonManager.refreshLessonsConfig?.();
          const currentState = this.progress[studentKey];
          const currentSubmission = currentState?.lastTaskSubmission;
          const currentTrack = currentSubmission?.track ||
            currentState?.activeTelegramTrack || 'grammar';
          const currentTaskProgress = getTrackProgress(currentState, currentTrack);
          const currentLessonId = currentTrack === 'grammar'
            ? currentState?.currentLessonId
            : currentTaskProgress?.activeLessonId;
          if (currentSubmission !== submission ||
              currentLessonId !== submission.lessonId ||
              !['awaiting_task', 'awaiting_reattempt'].includes(currentTaskProgress?.status)) {
            return;
          }
          this.logger.info(`[Telegram] Rechecking an unchecked saved task submission for ${studentKey}.`);
          await this.gradeSubmission({
            chatId: String(currentState.telegramPrivateChatId),
            studentKey,
            studentName: currentState.name || 'Student',
            submission: submission.text,
            recordSubmission: false
          });
        });
      } catch (error) {
        this.logger.error(
          `[Telegram] Could not recover the unchecked task submission for ${studentKey}: ${error.message}`
        );
      }
    }
  }

  async processPendingLessonSkips() {
    if (this.processingLessonSkips) return;
    this.processingLessonSkips = true;
    try {
      let request;
      while ((request = this.lessonSkipQueue.claimNext())) {
        try {
          await this.runStudentOperation(
            request.studentKey,
            () => this.deliverLessonSkipRequest(request)
          );
        } catch (error) {
          this.lessonSkipQueue.complete(request.id, 'failed', error.message);
          this.logger.error(`[Telegram] Could not deliver a lesson skip to ${request.studentKey}: ${error.message}`);
        }
      }
    } finally {
      this.processingLessonSkips = false;
    }
  }

  async deliverLessonSkipRequest(request) {
    this.lessonManager.refreshLessonsConfig?.();
    const state = this.progress[request.studentKey];
    const isScoreMessage = request.requestType === 'score_message';
    if (!state ||
        request.studentKey !== `telegram:${request.chatId}:${request.userId}` ||
        String(state.telegramChatId) !== request.chatId ||
        String(state.telegramUserId) !== request.userId ||
        state.grade !== request.gradeKey ||
        (!isScoreMessage &&
          (state.currentLessonId !== request.currentLessonId ||
            !['awaiting_task', 'awaiting_reattempt', 'awaiting_content', 'completed'].includes(state.status)))) {
      const errorMessage = isScoreMessage
        ? 'Student identity or grade changed before the score message could be delivered.'
        : 'Student progress changed before the lesson skip could be delivered.';
      this.lessonSkipQueue.complete(
        request.id,
        'failed',
        errorMessage
      );
      this.logger.info(
        `[Telegram] Discarded stale ${isScoreMessage ? 'score message' : 'lesson skip'} request ${request.id}.`
      );
      return false;
    }

    if (isScoreMessage) {
      if (!state.telegramPrivateChatId ||
          typeof request.message !== 'string' ||
          !request.message.trim() ||
          request.message.length > 4096) {
        this.lessonSkipQueue.complete(
          request.id,
          'failed',
          'A private chat and valid score message are required.'
        );
        return false;
      }
      const waitMs = 1000 - (Date.now() - this.lastScoreMessageSentAt);
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      this.lastScoreMessageSentAt = Date.now();
      try {
        await this.bot.sendMessage(state.telegramPrivateChatId, request.message);
        this.lessonSkipQueue.complete(request.id, 'sent');
        this.logger.info(`[Telegram] Sent a private exercise score update to ${request.studentKey}.`);
        return true;
      } catch (error) {
        this.lessonSkipQueue.complete(request.id, 'failed', error.message);
        this.logger.error(
          `[Telegram] Could not send a private exercise score update to ${request.studentKey}: ${error.message}`
        );
        return false;
      }
    }

    if (request.requestType === 'regrade_task') {
      const savedSubmission = state.lastTaskSubmission;
      if (!['awaiting_task', 'awaiting_reattempt'].includes(state.status) ||
          !savedSubmission ||
          savedSubmission.lessonId !== state.currentLessonId ||
          savedSubmission.grade !== state.grade ||
          typeof savedSubmission.text !== 'string' ||
          !state.telegramPrivateChatId) {
        this.lessonSkipQueue.complete(
          request.id,
          'failed',
          'The latest task submission is no longer available for private regrading.'
        );
        return false;
      }
      const previousRetryQuestionNumbers = Array.isArray(state.retryQuestionNumbers)
        ? [...state.retryQuestionNumbers]
        : [];
      state.retryQuestionNumbers = [];
      try {
        const graded = await this.gradeSubmission({
          chatId: String(state.telegramPrivateChatId),
          studentKey: request.studentKey,
          studentName: state.name || 'Student',
          submission: savedSubmission.text,
          manualReview: true,
          recordSubmission: false
        });
        if (!graded) {
          state.retryQuestionNumbers = previousRetryQuestionNumbers;
          this.saveProgress();
          this.lessonSkipQueue.complete(
            request.id,
            'failed',
            'The saved submission could not be graded as a task response.'
          );
          return false;
        }
        this.lessonSkipQueue.complete(request.id, 'sent');
        this.logger.info(`[Telegram] Rechecked the latest task submission for ${request.studentKey} by admin request.`);
        return true;
      } catch (error) {
        state.retryQuestionNumbers = previousRetryQuestionNumbers;
        this.saveProgress();
        this.lessonSkipQueue.complete(request.id, 'failed', error.message);
        this.logger.error(`[Telegram] Could not recheck a task for ${request.studentKey}: ${error.message}`);
        return false;
      }
    }

    if (request.requestType === 'manual_reminder') {
      if (!state.telegramPrivateChatId ||
          !['awaiting_task', 'awaiting_reattempt'].includes(state.status)) {
        this.lessonSkipQueue.complete(
          request.id,
          'failed',
          'The student no longer has a pending exercise or private chat.'
        );
        return false;
      }
      try {
        await this.bot.sendMessage(
          state.telegramPrivateChatId,
          LESSON_ANSWER_REMINDER_MESSAGE
        );
        const sentAt = new Date().toISOString();
        state.answerReminderSentForDeliveryAt = state.deliveredAt;
        state.answerReminderSentAt = sentAt;
        state.motivationMessageSentFor = getStudentLocalDate(
          Date.parse(sentAt),
          this.motivationTimeZone
        );
        this.saveProgress();
        this.lessonSkipQueue.complete(request.id, 'sent');
        this.logger.info(`[Telegram] Sent a private lesson reminder to ${request.studentKey} by admin request.`);
        return true;
      } catch (error) {
        this.lessonSkipQueue.complete(request.id, 'failed', error.message);
        this.logger.error(`[Telegram] Could not send a manual reminder to ${request.studentKey}: ${error.message}`);
        return false;
      }
    }

    const gradeConfig = this.lessonManager.lessonsConfig[state.grade] || {};
    const gradeLessons = gradeConfig.lessons || [];
    let lessonIndex;
    let lesson;
    const requestedTrack = request.track || 'grammar';
    if (request.requestType === 'send_lesson' && requestedTrack !== 'grammar') {
      const collectionId = requestedTrack === 'literature'
        ? 'treasure_island'
        : requestedTrack === 'spine'
          ? 'standalone'
          : null;
      const trackLessons = requestedTrack === 'literature'
        ? gradeConfig.collections?.[collectionId]?.lessons
        : requestedTrack === 'spine'
          ? gradeConfig.standaloneLessons
          : null;
      lessonIndex = Array.isArray(trackLessons)
        ? trackLessons.findIndex(candidate => candidate?.id === request.nextLessonId)
        : -1;
      lesson = lessonIndex >= 0 ? trackLessons[lessonIndex] : null;
      if (!collectionId || request.collectionId !== collectionId ||
          !lesson || !isReadyLesson(lesson) || lesson.hasExercise === false) {
        this.lessonSkipQueue.complete(
          request.id,
          'failed',
          'The requested lesson changed or is no longer ready.'
        );
        this.logger.info(`[Telegram] Could not find the requested lesson for ${request.studentKey}.`);
        return false;
      }
      try {
        await this.deliverTelegramTrackLesson(
          request.studentKey,
          requestedTrack,
          lesson,
          lessonIndex
        );
        this.lessonSkipQueue.complete(request.id, 'sent');
        this.logger.info(`[Telegram] Delivered ${lesson.id} to ${request.studentKey} by admin request.`);
        return true;
      } catch (error) {
        this.lessonSkipQueue.complete(request.id, 'failed', error.message);
        this.logger.error(`[Telegram] Could not deliver a lesson skip to ${request.studentKey}: ${error.message}`);
        return false;
      }
    } else if (request.requestType === 'send_lesson') {
      lessonIndex = gradeLessons.findIndex(candidate => candidate?.id === request.nextLessonId);
      lesson = gradeLessons[lessonIndex];
    } else {
      const next = this.lessonManager.getNextSequentialLesson(state.grade, state.currentLessonId);
      lessonIndex = next.lessonIndex;
      lesson = next.status === 'ready' ? gradeLessons[lessonIndex] : null;
    }
    if (!lesson || lesson.id !== request.nextLessonId || !isReadyLesson(lesson)) {
      this.lessonSkipQueue.complete(
        request.id,
        'failed',
        request.requestType === 'send_lesson'
          ? 'The requested lesson changed or is no longer ready.'
          : 'The configured next lesson changed or is no longer ready.'
      );
      this.logger.info(`[Telegram] Could not find the requested lesson for ${request.studentKey}.`);
      return false;
    }

    try {
      await this.deliverLesson(
        request.studentKey,
        state.grade,
        lessonIndex,
        lesson
      );
      this.lessonSkipQueue.complete(request.id, 'sent');
      this.logger.info(`[Telegram] Delivered ${lesson.id} to ${request.studentKey} by admin request.`);
      return true;
    } catch (error) {
      this.lessonSkipQueue.complete(request.id, 'failed', error.message);
      this.logger.error(`[Telegram] Could not deliver a lesson skip to ${request.studentKey}: ${error.message}`);
      return false;
    }
  }

  getNextLesson(studentKey) {
    const state = this.progress[studentKey];
    if (state) {
      const grade = state.grade || this.defaultGrade;
      const lessons = this.lessonManager.lessonsConfig[grade]?.lessons || [];
      const currentLessonId = state.currentLessonId ||
        (Number.isInteger(state.currentLessonIndex)
          ? lessons[state.currentLessonIndex]?.id
          : null);
      if (currentLessonId) {
        return this.lessonManager.getNextSequentialLesson(grade, currentLessonId);
      }
    }
    const lesson = this.lessonManager.getWelcomeSampleLesson(this.defaultGrade);
    if (!lesson) return { status: 'awaiting_content' };
    const lessonIndex = this.lessonManager.lessonsConfig[this.defaultGrade]?.lessons
      ?.findIndex(candidate => candidate.id === lesson.id) ?? -1;
    return lessonIndex >= 0
      ? { status: 'ready', lessonIndex }
      : { status: 'awaiting_content' };
  }

  async startOrResumeLesson(chatId, studentKey, messageId, reportProgress) {
    this.lessonManager.refreshLessonsConfig?.();
    const state = this.progress[studentKey];
    if (state && ['awaiting_task', 'awaiting_reattempt'].includes(state.status)) {
      const grade = state.grade || this.defaultGrade;
      const { lesson, lessonIndex } = getSequentialLessonForProgress(
        this.lessonManager.lessonsConfig,
        grade,
        state
      );
      if (isReadyLesson(lesson)) {
        reportProgress?.(`Sending Grammar lesson ${lessonIndex + 1}: ${lesson.title || lesson.id}`);
        const taskVersion = getLessonTaskVersion(lesson);
        if (state.taskVersion !== taskVersion) {
          state.taskVersion = taskVersion;
          state.correctQuestionNumbers = [];
          state.resolvedQuestionNumbers = [];
          state.retryQuestionNumbers = [];
          this.saveProgress();
        }
        await this.deliverLesson(
          studentKey,
          grade,
          lessonIndex,
          lesson,
          messageId
        );
      } else {
        throw new Error(`Active Telegram lesson is missing its video, task, or answer key for ${studentKey}.`);
      }
      return;
    }
    const next = this.getNextLesson(studentKey);
    if (state?.status === 'completed' && next.status !== 'ready') {
      await this.bot.sendMessage(
        chatId,
        'كملت كل الدروس المتوفرة حالياً يا بطل.',
        messageId
      );
      return;
    }

    if (next.status !== 'ready') {
      await this.bot.sendMessage(
        chatId,
        'الدرس الجاي لسه ما جاهز. حأرسله ليك أول ما يتجهز.',
        messageId
      );
      return;
    }
    const grade = state?.grade || this.defaultGrade;
    const lesson = this.lessonManager.lessonsConfig[grade]?.lessons?.[next.lessonIndex];
    if (!isReadyLesson(lesson)) {
      throw new Error(`Lesson ${next.lessonIndex + 1} is missing its video, task, or answer key.`);
    }
    reportProgress?.(`Sending Grammar lesson ${next.lessonIndex + 1}: ${lesson.title || lesson.id}`);
    await this.deliverLesson(studentKey, grade, next.lessonIndex, lesson, messageId);
  }

  recordLessonHistory(state, lessonId) {
    const history = Array.isArray(state.lessonHistory)
      ? state.lessonHistory.filter((id, index, entries) =>
          typeof id === 'string' && id.trim() && entries.indexOf(id) === index)
      : [];
    if (!history.includes(lessonId)) history.push(lessonId);
    state.lessonHistory = history;
  }

  recordLessonCompletion(state, lessonId) {
    const previousCounts = state.lessonCompletionCounts &&
      typeof state.lessonCompletionCounts === 'object' &&
      !Array.isArray(state.lessonCompletionCounts)
      ? state.lessonCompletionCounts
      : {};
    const previousCount = previousCounts[lessonId];
    state.lessonCompletionCounts = {
      ...previousCounts,
      [lessonId]: (Number.isSafeInteger(previousCount) ? previousCount : 0) + 1
    };
    state.lessonsCompleted = (state.lessonsCompleted || 0) + 1;
    const completionAt = new Date().toISOString();
    state.lastLessonCompletionAt = completionAt;
    const completionTimestamps = Array.isArray(state.lessonCompletionTimestamps)
      ? state.lessonCompletionTimestamps.filter(timestamp =>
          Number.isFinite(Date.parse(timestamp)))
      : [];
    completionTimestamps.push(completionAt);
    state.lessonCompletionTimestamps = completionTimestamps.slice(-365);
  }

  async sendLessonCompletionMilestones(chatId, studentKey, state) {
    if ([3, 10, 20, 50].includes(state.lessonsCompleted)) {
      try {
        await this.bot.sendMessage(chatId, getStudentMilestoneMessage(state.lessonsCompleted));
      } catch (error) {
        this.logger.error(
          `[Telegram] Could not send a lesson milestone to ${studentKey}: ${error.message}`
        );
      }
    }
    if (state.lessonsCompleted === TELEGRAM_PAYMENT_REMINDER_LESSONS) {
      await this.bot.sendMessage(
        chatId,
        `ما شاء الله، كملت 5 دروس بنجاح 😍 عشان تواصل معانا، ${STUDENT_PAYMENT_INFORMATION_MESSAGE}`
      );
    }
  }

  async navigateLesson(chatId, studentKey, direction, messageId) {
    this.lessonManager.refreshLessonsConfig?.();
    const state = this.progress[studentKey];
    if (state?.activeTelegramTrack &&
        state.activeTelegramTrack !== 'grammar' &&
        hasActiveTelegramTask(state)) {
      await this.bot.sendMessage(
        chatId,
        'كمّل تمرين المجموعة الحالية أول قبل التنقل في دروس القواعد.',
        messageId
      );
      return;
    }
    const grade = state.grade || this.defaultGrade;
    const lessons = this.lessonManager.lessonsConfig[grade]?.lessons || [];
    const currentLessonId = state.currentLessonId ||
      (Number.isInteger(state.currentLessonIndex)
        ? lessons[state.currentLessonIndex]?.id
        : null);
    const currentNumber = /^lesson_(\d+)$/.exec(currentLessonId || '');
    if (!currentNumber) {
      await this.bot.sendMessage(chatId, 'أرسل /lesson أول عشان تبدأ سجل دروسك.', messageId);
      return;
    }

    let lessonIndex;
    if (direction === 'previous') {
      const previous = this.lessonManager.getPreviousSequentialLesson(grade, currentLessonId);
      if (previous.status !== 'ready') {
        await this.bot.sendMessage(chatId, 'ما في حصة سابقة جاهزة قبل الحصة الحالية.', messageId);
        return;
      }
      lessonIndex = previous.lessonIndex;
    } else {
      const next = this.lessonManager.getNextSequentialLesson(grade, currentLessonId);
      if (next.status !== 'ready') {
        await this.bot.sendMessage(
          chatId,
          next.status === 'completed'
            ? 'ما في حصة جاية متوفرة حالياً. كملت كل الدروس الجاهزة.'
            : 'الحصة الجاية لسه ما جاهزة. حأرسلها ليك أول ما يجهز محتواها.',
          messageId
        );
        return;
      }
      lessonIndex = next.lessonIndex;
    }

    const lesson = lessons[lessonIndex];
    if (!isReadyLesson(lesson)) {
      await this.bot.sendMessage(chatId, 'الحصة المطلوبة ما جاهزة هسي. أرسل /lesson بعد ما يكتمل محتواها.', messageId);
      return;
    }

    this.recordLessonHistory(state, currentLessonId);
    this.saveProgress();
    try {
      await this.deliverLesson(studentKey, grade, lessonIndex, lesson, messageId);
    } catch (error) {
      this.logger.error(
        `[Telegram] Could not navigate to ${lesson.id} for ${studentKey}: ${error.message}`
      );
      await this.bot.sendMessage(chatId, 'ما قدرت أرسل الحصة المطلوبة هسي. جرّب تاني بعد شوية.', messageId);
    }
  }

  async deliverLesson(studentKey, grade, lessonIndex, lesson, replyToMessageId) {
    const isVideoOnly = lesson.hasExercise === false;
    const deliveryChatId = this.progress[studentKey]?.telegramPrivateChatId;
    if (!deliveryChatId) {
      throw new Error(`No private Telegram chat is available for ${studentKey}.`);
    }
    const videoPath = this.videoPathResolver(lesson.videoFile);
    const videoStats = fs.statSync(videoPath);
    if (!videoStats.isFile() || videoStats.size === 0) {
      throw new Error(`Telegram lesson video is missing or empty: ${videoPath}`);
    }
    if (videoStats.size > this.maxVideoBytes) {
      throw new Error(
        `Telegram lesson video exceeds the ${Math.ceil(this.maxVideoBytes / (1024 * 1024))} MB Bot API upload limit.`
      );
    }
    const video = fs.readFileSync(videoPath);
    await this.sendLessonVideo({
      chatId: deliveryChatId,
      video,
      lesson,
      studentKey,
      grade,
      lessonIndex,
      replyToMessageId
    });
    if (!isVideoOnly) {
      await this.bot.sendMessage(deliveryChatId, lesson.taskMessage, replyToMessageId);
    }

    const previous = this.progress[studentKey] || {};
    const hadPreviousLessonDelivery = Boolean(
      previous.deliveredAt ||
      previous.currentLessonId ||
      (Array.isArray(previous.lessonHistory) && previous.lessonHistory.length > 0) ||
      (Number.isSafeInteger(previous.currentLessonIndex) && previous.currentLessonIndex >= 0)
    );
    const lessonTaskProgress = previous.lessonTaskProgress &&
      typeof previous.lessonTaskProgress === 'object' &&
      !Array.isArray(previous.lessonTaskProgress)
      ? { ...previous.lessonTaskProgress }
      : {};
    if (previous.currentLessonId && typeof previous.taskVersion === 'string') {
      lessonTaskProgress[previous.currentLessonId] = {
        taskVersion: previous.taskVersion,
        status: previous.status,
        correctQuestionNumbers: Array.isArray(previous.correctQuestionNumbers)
          ? [...previous.correctQuestionNumbers]
          : [],
        resolvedQuestionNumbers: Array.isArray(previous.resolvedQuestionNumbers)
          ? [...previous.resolvedQuestionNumbers]
          : [],
        retryQuestionNumbers: Array.isArray(previous.retryQuestionNumbers)
          ? [...previous.retryQuestionNumbers]
          : []
      };
    }
    const lessonHistory = Array.isArray(previous.lessonHistory)
      ? [...previous.lessonHistory]
      : [];
    if (!lessonHistory.includes(lesson.id)) lessonHistory.push(lesson.id);
    const previousLesson = getSequentialLessonForProgress(
      this.lessonManager.lessonsConfig,
      previous.grade || grade,
      previous
    ).lesson;
    const previousAnswers = new Set([
      ...(Array.isArray(previous.correctQuestionNumbers)
        ? previous.correctQuestionNumbers
        : []),
      ...(Array.isArray(previous.resolvedQuestionNumbers)
        ? previous.resolvedQuestionNumbers
        : [])
    ]);
    const previousTaskCompleted = Array.isArray(previousLesson?.answerKey) &&
      previousLesson.answerKey.length > 0 &&
      previousLesson.answerKey.every((_, index) => previousAnswers.has(index + 1));
    if (previousTaskCompleted && previous.currentLessonId) {
      lessonTaskProgress[previous.currentLessonId] = {
        taskVersion: previous.taskVersion,
        status: 'awaiting_task',
        correctQuestionNumbers: [],
        resolvedQuestionNumbers: [],
        retryQuestionNumbers: []
      };
    }
    const sameActiveLesson = previous.currentLessonId === lesson.id &&
      previous.taskVersion === getLessonTaskVersion(lesson);
    const savedTaskProgress = lessonTaskProgress[lesson.id];
    const canRestoreTaskProgress = !sameActiveLesson &&
      savedTaskProgress?.taskVersion === getLessonTaskVersion(lesson);
    const taskProgress = isVideoOnly
      ? {}
      : sameActiveLesson
        ? previous
        : canRestoreTaskProgress
          ? savedTaskProgress
          : {};
    const deliveredAt = new Date().toISOString();
    const updatedProgress = {
      ...previous,
      grade,
      lessonHistory,
      lessonTaskProgress,
      activeTelegramTrack: 'grammar',
      currentLessonIndex: lessonIndex,
      currentLessonId: lesson.id,
      status: isVideoOnly
        ? 'completed'
        : taskProgress.status === 'awaiting_reattempt'
          ? 'awaiting_reattempt'
          : 'awaiting_task',
      deliveredAt,
      firstLessonStartedAt: getLessonPaymentStartAt(previous) || deliveredAt,
      joinedAt: previous.joinedAt || new Date().toISOString(),
      lessonsCompleted: previous.lessonsCompleted || 0,
      taskVersion: isVideoOnly ? null : getLessonTaskVersion(lesson),
      correctQuestionNumbers: isVideoOnly ? [] : taskProgress.correctQuestionNumbers || [],
      resolvedQuestionNumbers: isVideoOnly ? [] : taskProgress.resolvedQuestionNumbers || [],
      retryQuestionNumbers: isVideoOnly ? [] : taskProgress.retryQuestionNumbers || []
    };
    if (!isVideoOnly) {
      const exerciseScores = previous.exerciseScores &&
        typeof previous.exerciseScores === 'object' &&
        !Array.isArray(previous.exerciseScores)
        ? { ...previous.exerciseScores }
        : {};
      const taskVersion = getLessonTaskVersion(lesson);
      if (exerciseScores[lesson.id]?.taskVersion !== taskVersion ||
          exerciseScores[lesson.id]?.scoringPolicy !== EXERCISE_SCORING_POLICY) {
        const previouslyAttemptedQuestionNumbers = [
          ...(Array.isArray(taskProgress.correctQuestionNumbers)
            ? taskProgress.correctQuestionNumbers
            : []),
          ...(Array.isArray(taskProgress.resolvedQuestionNumbers)
            ? taskProgress.resolvedQuestionNumbers
            : []),
          ...(Array.isArray(taskProgress.retryQuestionNumbers)
            ? taskProgress.retryQuestionNumbers
            : [])
        ];
        exerciseScores[lesson.id] = {
          taskVersion,
          scoringPolicy: EXERCISE_SCORING_POLICY,
          totalQuestions: lesson.answerKey.length,
          attemptedQuestionNumbers: [...new Set(previouslyAttemptedQuestionNumbers)]
            .filter(number =>
              Number.isInteger(number) && number >= 1 && number <= lesson.answerKey.length)
            .sort((left, right) => left - right),
          correctQuestionNumbers: []
        };
      }
      updatedProgress.exerciseScores = exerciseScores;
    }
    if (isVideoOnly) this.recordLessonCompletion(updatedProgress, lesson.id);
    this.progress[studentKey] = updatedProgress;
    this.saveProgress();
    if (isVideoOnly) {
      await this.sendLessonCompletionMilestones(deliveryChatId, studentKey, updatedProgress);
    }
  }

  async sendLessonVideo({
    chatId,
    video,
    lesson,
    studentKey,
    grade,
    lessonIndex,
    replyToMessageId,
    existingActivity,
    collectionId = null
  }) {
    const activity = {
      ...(existingActivity || {}),
      id: existingActivity?.id || randomUUID(),
      platform: 'Telegram',
      mediaType: 'video',
      recipientJid: String(chatId),
      studentName: this.progress[studentKey]?.name || studentKey,
      description: lesson.title || lesson.id,
      lessonId: lesson.id,
      videoFile: lesson.videoFile,
      ...(collectionId ? { collectionId } : {}),
      studentKey,
      grade,
      lessonIndex,
      caption: lesson.caption || lesson.title || '',
      total: video.length,
      loaded: 0,
      percent: undefined,
      status: 'queued',
      retryError: undefined,
      updatedAt: new Date().toISOString()
    };
    writeAgentMediaActivity(activity, this.mediaActivityFile);
    try {
      activity.status = 'uploading';
      activity.loaded = 0;
      activity.percent = 0;
      activity.updatedAt = new Date().toISOString();
      writeAgentMediaActivity(activity, this.mediaActivityFile);
      let lastReportedPercent = 0;
      await this.bot.sendVideo(
        chatId,
        video,
        activity.caption,
        replyToMessageId,
        (loaded, total) => {
          const percent = total > 0
            ? Math.min(100, Math.floor((loaded / total) * 100))
            : 0;
          if (percent <= lastReportedPercent && loaded < total) return;
          lastReportedPercent = percent;
          activity.loaded = loaded;
          activity.total = total;
          activity.percent = percent;
          activity.updatedAt = new Date().toISOString();
          writeAgentMediaActivity(activity, this.mediaActivityFile);
        }
      );
      activity.status = 'sent';
      activity.loaded = video.length;
      activity.percent = 100;
      activity.updatedAt = new Date().toISOString();
      writeAgentMediaActivity(activity, this.mediaActivityFile);
      this.logger.info(`[Telegram] Delivered lesson video ${lesson.id} to ${studentKey}.`);
      return activity;
    } catch (error) {
      activity.status = 'failed';
      activity.retryError = error.message;
      activity.updatedAt = new Date().toISOString();
      writeAgentMediaActivity(activity, this.mediaActivityFile);
      throw error;
    }
  }

  async processPendingMediaRetries() {
    if (this.processingMediaRetries) return;
    this.processingMediaRetries = true;
    try {
      const requests = consumeAgentMediaRetryRequests(this.mediaRetryRequestsFile);
      for (const request of requests) {
        const activity = readAgentMediaActivities(this.mediaActivityFile)
          .find(item => item.id === request.activityId);
        if (!activity || activity.status !== 'retrying') continue;
        try {
          const privateChatId = this.progress[activity.studentKey]?.telegramPrivateChatId;
          if (!privateChatId || String(privateChatId) !== String(activity.recipientJid)) {
            throw new Error('The student must start a private chat before the lesson video can be retried.');
          }
          this.lessonManager.refreshLessonsConfig?.();
          const grade = this.lessonManager.lessonsConfig[activity.grade];
          const gradeLessons = activity.collectionId === 'treasure_island'
            ? grade?.collections?.treasure_island?.lessons
            : activity.collectionId === 'standalone'
              ? grade?.standaloneLessons
              : grade?.lessons;
          const lessonIndex = Array.isArray(gradeLessons)
            ? gradeLessons.findIndex(lesson => lesson?.id === activity.lessonId)
            : -1;
          const lesson = gradeLessons?.[lessonIndex];
          if (!isReadyLesson(lesson) || lesson.videoFile !== activity.videoFile) {
            throw new Error('The Telegram lesson video source is no longer available.');
          }
          const videoPath = this.videoPathResolver(lesson.videoFile);
          const videoStats = fs.statSync(videoPath);
          if (!videoStats.isFile() || videoStats.size === 0) {
            throw new Error(`Telegram lesson video is missing or empty: ${videoPath}`);
          }
          if (videoStats.size > this.maxVideoBytes) {
            throw new Error(
              `Telegram lesson video exceeds the ${Math.ceil(this.maxVideoBytes / (1024 * 1024))} MB Bot API upload limit.`
            );
          }
          await this.sendLessonVideo({
            chatId: activity.recipientJid,
            video: fs.readFileSync(videoPath),
            lesson,
            studentKey: activity.studentKey,
            grade: activity.grade,
            lessonIndex,
            existingActivity: activity,
            ...(activity.collectionId ? { collectionId: activity.collectionId } : {})
          });
        } catch (error) {
          this.logger.error(
            `[Telegram] Could not retry video delivery ${activity.id}: ${error.message}`
          );
          writeAgentMediaActivity({
            ...activity,
            status: 'failed',
            retryError: error.message,
            updatedAt: new Date().toISOString()
          }, this.mediaActivityFile);
        }
      }
    } finally {
      this.processingMediaRetries = false;
    }
  }

  async processDueLessonAnswerReminders(now = Date.now()) {
    if (this.processingAnswerReminders) return;
    this.processingAnswerReminders = true;
    try {
      const reminders = getDueLessonAnswerReminders(this.progress, now);
      for (const reminder of reminders) {
        try {
          await this.runStudentOperation(reminder.studentKey, async () => {
            const currentReminder = getDueLessonAnswerReminders(this.progress, now)
              .find(candidate => candidate.studentKey === reminder.studentKey);
            if (!currentReminder) return;
            const student = currentReminder.student;
            const today = getStudentLocalDate(now, this.motivationTimeZone);
            if (student.motivationMessageSentFor === today) {
              markLessonAnswerReminderSuppressed(currentReminder);
              this.saveProgress();
              this.logger.info(
                `[Telegram] Skipped a duplicate motivation reminder for ${currentReminder.studentKey}; one was already sent today.`
              );
              return;
            }
            const privateChatId = student.telegramPrivateChatId;
            if (!privateChatId) {
              if (student.privateReminderUnavailableForDeliveryAt !== currentReminder.deliveredAt) {
                student.privateReminderUnavailableForDeliveryAt = currentReminder.deliveredAt;
                this.saveProgress();
                this.logger.info(
                  `[Telegram] Holding the unanswered lesson reminder for ${currentReminder.studentKey} until they open the bot and send /start; reminders are private.`
                );
              }
              return;
            }
            await this.bot.sendMessage(privateChatId, LESSON_ANSWER_REMINDER_MESSAGE);
            markLessonAnswerReminderSent(currentReminder);
            student.motivationMessageSentFor = today;
            delete student.privateReminderUnavailableForDeliveryAt;
            this.saveProgress();
            this.logger.info(
              `[Telegram] Sent an eight-hour unanswered lesson reminder privately to ${currentReminder.studentKey}.`
            );
          });
        } catch (error) {
          this.logger.error(
            `[Telegram] Could not send an unanswered lesson reminder to ${reminder.studentKey}: ${error.message}`
          );
        }
      }
    } finally {
      this.processingAnswerReminders = false;
    }
  }

  async processDueStudentMotivationMessages(now = Date.now()) {
    const messages = getDueStudentMotivationMessages(
      this.progress,
      now,
      this.motivationTimeZone
    );
    for (const reminder of messages) {
      try {
        await this.runStudentOperation(reminder.studentKey, async () => {
          const student = this.progress[reminder.studentKey];
          if (!student?.telegramPrivateChatId) return;
          if (reminder.type === 'weekly_goal') {
            if (student.weeklyGoalMessageSentFor === reminder.weekStart) return;
            await this.bot.sendMessage(
              student.telegramPrivateChatId,
              formatWeeklyGoalMessage(reminder.completed, reminder.goal)
            );
            student.weeklyGoalMessageSentFor = reminder.weekStart;
          } else {
            if (student.dailyMotivationReminderSentFor === reminder.date ||
                student.weeklyGoalMessageSentFor === reminder.date) return;
            await this.bot.sendMessage(
              student.telegramPrivateChatId,
              DAILY_MOTIVATION_REMINDER_MESSAGE
            );
            student.dailyMotivationReminderSentFor = reminder.date;
            student.motivationMessageSentFor = reminder.date;
          }
          this.saveProgress();
        });
      } catch (error) {
        this.logger.error(
          `[Telegram] Could not send a motivation message to ${reminder.studentKey}: ${error.message}`
        );
      }
    }
  }

  getActiveTelegramTaskContext(state) {
    const track = state?.activeTelegramTrack || 'grammar';
    const grade = state?.grade || this.defaultGrade;
    if (track === 'grammar') {
      const { lesson } = getSequentialLessonForProgress(
        this.lessonManager.lessonsConfig,
        grade,
        state
      );
      return { track, taskProgress: state, lesson };
    }
    const taskProgress = state?.telegramLessonTracks?.[track];
    const lessons = getTelegramTrackLessons(
      this.lessonManager.lessonsConfig,
      grade,
      track
    );
    const lesson = lessons.find(item => item.id === taskProgress?.activeLessonId);
    return { track, taskProgress, lesson };
  }

  async gradeSubmission({
    chatId,
    studentKey,
    studentName,
    messageId,
    submission,
    manualReview = false,
    recordSubmission = true
  }) {
    this.lessonManager.refreshLessonsConfig?.();
    const state = this.progress[studentKey];
    const { track, taskProgress, lesson } = this.getActiveTelegramTaskContext(state);
    if (!state || !taskProgress) {
      throw new Error(`Active Telegram ${track} task progress is missing for ${studentKey}.`);
    }
    const activeLessonId = track === 'grammar'
      ? state.currentLessonId
      : taskProgress.activeLessonId;
    if (!lesson || lesson.id !== activeLessonId) {
      taskProgress.status = 'lesson_unavailable';
      this.saveProgress();
      this.logger.error(
        `[Telegram] Could not grade ${studentKey}; active ${track} lesson "${activeLessonId}" is no longer available.`
      );
      await this.bot.sendMessage(
        chatId,
        'التمرين المرتبط بإجابتك ما بقاش متوفر في المسار الحالي، فما راجعت إجابتك. أرسل /start واختار المسار المناسب عشان تواصل.',
        messageId
      );
      return false;
    }
    if (!isReadyLesson(lesson)) {
      throw new Error(`Active Telegram ${track} lesson is missing its task or answer key for ${studentKey}.`);
    }

    const previousTaskSubmission = state.lastTaskSubmission;
    if (recordSubmission) {
      state.lastTaskSubmission = {
        grade: state.grade,
        lessonId: lesson.id,
        track,
        text: submission.slice(0, 4096),
        submittedAt: new Date().toISOString(),
        checkingStartedAt: new Date().toISOString(),
        checkedAt: null
      };
      this.saveProgress();
    }
    const reviewPrefix = manualReview
      ? 'راجع الأستاذ إجابتك مرة تانية:\n'
      : '';
    const taskVersion = getLessonTaskVersion(lesson);
    if (taskProgress.taskVersion !== taskVersion) {
      taskProgress.taskVersion = taskVersion;
      taskProgress.correctQuestionNumbers = [];
      taskProgress.resolvedQuestionNumbers = [];
      taskProgress.retryQuestionNumbers = [];
      this.saveProgress();
      this.logger.info(
        `[Telegram] Reset saved answers for ${studentKey} because the active lesson task or answer key changed.`
      );
    }

    const previouslyCorrect = new Set(
      Array.isArray(taskProgress.correctQuestionNumbers)
        ? taskProgress.correctQuestionNumbers.filter(number =>
            Number.isInteger(number) && number >= 1 && number <= lesson.answerKey.length)
        : []
    );
    const previouslyResolved = new Set(
      Array.isArray(taskProgress.resolvedQuestionNumbers)
        ? taskProgress.resolvedQuestionNumbers.filter(number =>
            Number.isInteger(number) && number >= 1 && number <= lesson.answerKey.length)
        : []
    );
    const retryQuestionNumbers = new Set(
      Array.isArray(taskProgress.retryQuestionNumbers)
        ? taskProgress.retryQuestionNumbers.filter(number =>
            Number.isInteger(number) && number >= 1 && number <= lesson.answerKey.length)
        : []
    );
    const pendingQuestionNumbers = lesson.answerKey
      .map((_, index) => index + 1)
      .filter(number => !previouslyCorrect.has(number) && !previouslyResolved.has(number));
    let result;
    try {
      result = await this.evaluateTask(lesson, submission, studentName, {
        pendingQuestionNumbers
      });
    } catch (error) {
      this.logger.error(`[Telegram] Could not grade a task for ${studentKey}: ${error.message}`);
      await this.bot.sendMessage(chatId, `${reviewPrefix}${taskFailureMessage()}`, messageId);
      return false;
    }
    if (!result.isTaskSubmission) {
      if (recordSubmission) {
        if (previousTaskSubmission === undefined) {
          delete state.lastTaskSubmission;
        } else {
          state.lastTaskSubmission = previousTaskSubmission;
        }
        this.saveProgress();
      }
      return false;
    }

    const pending = new Set(pendingQuestionNumbers);
    const answeredQuestionNumbers = Array.isArray(result.answeredQuestionNumbers)
      ? [...new Set(result.answeredQuestionNumbers.filter(number => pending.has(number)))]
      : [];
    const correctQuestionNumbers = Array.isArray(result.correctQuestionNumbers)
      ? new Set(result.correctQuestionNumbers.filter(number =>
          answeredQuestionNumbers.includes(number)))
      : new Set();
    const uncertainQuestionNumbers = new Set(
      Array.isArray(result.uncertainQuestionNumbers)
        ? result.uncertainQuestionNumbers.filter(number =>
            answeredQuestionNumbers.includes(number) && !correctQuestionNumbers.has(number))
        : []
    );
    if (answeredQuestionNumbers.length === 0) {
      await this.bot.sendMessage(
        chatId,
        `${reviewPrefix}ما قدرت أحدد الإجابة من رسالتك. أرسل الإجابة بس؛ ما محتاج تعيد باقي الإجابات. ممكن تكتبها بدون رقم لو واضحة، أو أضف كلمة من السؤال لو في أكتر من سؤال باقي.`,
        messageId
      );
      return false;
    }

    if (track === 'grammar') {
      const exerciseScores = state.exerciseScores &&
        typeof state.exerciseScores === 'object' &&
        !Array.isArray(state.exerciseScores)
        ? state.exerciseScores
        : {};
      const existingScore = exerciseScores[lesson.id];
      if (existingScore?.taskVersion === taskVersion &&
          existingScore?.scoringPolicy === EXERCISE_SCORING_POLICY) {
        const attemptedNumbers = new Set(
          Array.isArray(existingScore.attemptedQuestionNumbers)
            ? existingScore.attemptedQuestionNumbers
            : []
        );
        const scoreCorrectQuestionNumbers = new Set(
          Array.isArray(existingScore.correctQuestionNumbers)
            ? existingScore.correctQuestionNumbers
            : []
        );
        for (const number of answeredQuestionNumbers) {
          if (uncertainQuestionNumbers.has(number) || attemptedNumbers.has(number)) continue;
          attemptedNumbers.add(number);
          if (correctQuestionNumbers.has(number)) {
            scoreCorrectQuestionNumbers.add(number);
          }
        }
        exerciseScores[lesson.id] = {
          taskVersion,
          scoringPolicy: EXERCISE_SCORING_POLICY,
          totalQuestions: lesson.answerKey.length,
          attemptedQuestionNumbers: [...attemptedNumbers].sort((left, right) => left - right),
          correctQuestionNumbers: [...scoreCorrectQuestionNumbers].sort((left, right) => left - right)
        };
        state.exerciseScores = exerciseScores;
      }
    }

    const incorrectQuestionNumbers = answeredQuestionNumbers
      .filter(number =>
        !correctQuestionNumbers.has(number) && !uncertainQuestionNumbers.has(number));
    const correctedAfterRetry = new Set(
      incorrectQuestionNumbers.filter(number => retryQuestionNumbers.has(number))
    );
    const newlyNeedsRetry = incorrectQuestionNumbers
      .filter(number => !retryQuestionNumbers.has(number));
    for (const number of correctQuestionNumbers) retryQuestionNumbers.delete(number);
    for (const number of newlyNeedsRetry) retryQuestionNumbers.add(number);
    for (const number of correctedAfterRetry) {
      retryQuestionNumbers.delete(number);
      previouslyResolved.add(number);
    }

    taskProgress.correctQuestionNumbers = [...new Set([
      ...previouslyCorrect,
      ...correctQuestionNumbers
    ])].sort((left, right) => left - right);
    taskProgress.resolvedQuestionNumbers = [...previouslyResolved].sort((left, right) => left - right);
    taskProgress.retryQuestionNumbers = [...retryQuestionNumbers].sort((left, right) => left - right);

    const remainingQuestionNumbers = lesson.answerKey
      .map((_, index) => index + 1)
      .filter(number =>
        !taskProgress.correctQuestionNumbers.includes(number) &&
        !taskProgress.resolvedQuestionNumbers.includes(number));
    const getTaskHint = (number, explanation) => {
      const parsedAnswer = parseAnswerKey(lesson.answerKey[number - 1]);
      const savedArabicExplanation = /[\u0600-\u06FF]/.test(parsedAnswer.explanation)
        ? parsedAnswer.explanation
        : '';
      return getAnswerFreeHint(
        [parsedAnswer.expectedAnswer, ...parsedAnswer.acceptedAnswers],
        savedArabicExplanation || explanation,
      );
    };
    const correctionFeedback = correctedAfterRetry.size > 0
      ? [...correctedAfterRetry].map(number => {
          const feedback = result.incorrectAnswers?.find(item =>
            item.questionNumber === number)?.explanation;
          return `السؤال ${number}: لسه محتاج تصحيح بعد المحاولة التانية. ${getTaskHint(number, feedback)}`;
        }).join(' ')
      : '';
    const spellingCorrectionFeedback = incorrectQuestionNumbers.length === 0 &&
      Array.isArray(result.correctedAnswers)
      ? result.correctedAnswers
        .filter(correction =>
          Number.isInteger(correction.questionNumber) &&
          pending.has(correction.questionNumber) &&
          typeof correction.correctSpelling === 'string' &&
          correction.correctSpelling.trim())
        .map(correction =>
          `السؤال ${correction.questionNumber}: إجابتك صحيحة؛ الكتابة الصحيحة «${correction.correctSpelling.trim()}».`)
        .join(' ')
      : '';
    if (remainingQuestionNumbers.length > 0 && correctedAfterRetry.size === 0) {
      taskProgress.status = 'awaiting_reattempt';
      this.markTelegramSubmissionChecked(state, track, lesson, submission);
      this.saveProgress();
      const needsCorrection = newlyNeedsRetry;
      const incorrectFeedback = needsCorrection.length > 0
        ? ` الإجابة المحتاجة تصحيح: ${needsCorrection.map(number => {
            const answer = result.incorrectAnswers?.find(item =>
              item.questionNumber === number)?.studentAnswer;
            const excerpt = typeof answer === 'string'
              ? answer.replace(/\s+/g, ' ').trim().slice(0, 160)
              : '';
            return `السؤال ${number}${excerpt ? `: «${excerpt}${answer.length > 160 ? '…' : ''}»` : ''}`;
          }).join('، ')}. ${needsCorrection.map(number => {
            const explanation = result.incorrectAnswers?.find(item =>
              item.questionNumber === number)?.explanation;
            return `السؤال ${number}: محتاج مراجعة. ${getTaskHint(number, explanation)}`;
          }).join(' ')}`
        : '';
      const uncertaintyFeedback = uncertainQuestionNumbers.size
        ? ` ما قدرت أتأكد من إجابة السؤال ${[...uncertainQuestionNumbers].join('، ')}، وما اعتبرتها غلط. وضّحها أو أرسلها تاني عشان أراجعها.`
        : '';
      const list = remainingQuestionNumbers.join('، ');
      const completedQuestionCount = new Set([
        ...taskProgress.correctQuestionNumbers,
        ...taskProgress.resolvedQuestionNumbers
      ]).size;
      await this.bot.sendMessage(
        chatId,
        `${reviewPrefix}${correctionFeedback}${correctionFeedback ? ' ' : ''}${spellingCorrectionFeedback}${spellingCorrectionFeedback ? ' ' : ''}تقدمك ${completedQuestionCount} من ${lesson.answerKey.length} أسئلة. حفظت الإجابات الصحيحة.${incorrectFeedback}${uncertaintyFeedback} الأسئلة المحتاجة تصحيح أو إجابة: ${list}. أرسل إجابات الأسئلة دي بس؛ ما محتاج تعيد الإجابات الصحيحة. ممكن ترسل التصحيح بدون رقم لو واضح من الإجابة.`,
        messageId
      );
      return true;
    }

    const retryResolution = correctedAfterRetry.size > 0
      ? `${correctionFeedback} بنواصل للحصة الجاية هسي. `
      : '';
    const allCorrectMessage = correctedAfterRetry.size > 0
      ? retryResolution.trim()
      : 'ممتاز! كل الإجابات صحيحة،\n\nيلا دا مستوى ناس الـ93 وفوق والله!\n\nخلينا نستمر كدا وحننبهر بالنتيجة.\n\nبجيك هسي الفيديو البعدو.';
    await this.bot.sendMessage(
      chatId,
      `${reviewPrefix}${spellingCorrectionFeedback
        ? `${allCorrectMessage}\n\n${spellingCorrectionFeedback}`
        : allCorrectMessage}`,
      messageId
    );
    if (!manualReview &&
        taskProgress.correctQuestionNumbers.length === lesson.answerKey.length &&
        taskProgress.resolvedQuestionNumbers.length === 0 &&
        this.groupId) {
      try {
        await this.bot.sendMessage(
          String(this.groupId),
          getLessonCelebrationMessage(
            state.name || studentName,
            lesson.title || lesson.id,
            state.telegramUsername
          )
        );
      } catch (error) {
        this.logger.error(
          `[Telegram] Could not announce a lesson achievement for ${studentKey}: ${error.message}`
        );
      }
    }
    this.recordLessonCompletion(state, lesson.id);
    if (track !== 'grammar') {
      this.recordLessonCompletion(taskProgress, lesson.id);
    }
    if (track !== 'grammar') {
      taskProgress.status = 'completed';
      taskProgress.completedLessonIds = Array.isArray(taskProgress.completedLessonIds)
        ? [...new Set([...taskProgress.completedLessonIds, lesson.id])]
        : [lesson.id];
      taskProgress.activeLessonId = null;
      state.activeTelegramTrack = null;
      this.markTelegramSubmissionChecked(state, track, lesson, submission);
      this.saveProgress();
      if (!manualReview) {
        await this.sendLessonCompletionMilestones(chatId, studentKey, taskProgress);
      }
      const trackLessons = this.getTelegramTrackLessons(studentKey, track);
      const completedLessonIds = new Set(taskProgress.completedLessonIds);
      const nextLessonIndex = trackLessons.findIndex(candidate =>
        !completedLessonIds.has(candidate.id));
      if (nextLessonIndex >= 0) {
        try {
          await this.deliverTelegramTrackLesson(
            studentKey,
            track,
            trackLessons[nextLessonIndex],
            nextLessonIndex
          );
        } catch (error) {
          this.logger.error(
            `[Telegram] Could not deliver the next ${track} lesson to ${studentKey}: ${error.message}`
          );
          await this.bot.sendMessage(
            chatId,
            `أكملت الدرس بنجاح، لكن ما قدرت أرسل الدرس الجاي هسي. أرسل /${track} للمحاولة تاني.`
          );
        }
      } else {
        await this.bot.sendMessage(
          chatId,
          track === 'literature'
            ? 'أكملت كل فصول Treasure Island المتوفرة. برافو عليك!'
            : 'أكملت كل دروس Spine المتوفرة. برافو عليك!'
        );
      }
      return true;
    }

    state.status = 'awaiting_content';
    this.markTelegramSubmissionChecked(state, track, lesson, submission);
    this.saveProgress();
    if (!manualReview) await this.sendLessonCompletionMilestones(chatId, studentKey, state);
    const next = this.lessonManager.getNextSequentialLesson(state.grade, state.currentLessonId);
    if (next.status === 'ready') {
      const nextLesson = this.lessonManager.lessonsConfig[state.grade]?.lessons?.[next.lessonIndex];
      if (!isReadyLesson(nextLesson)) {
        throw new Error(`Next Telegram lesson ${next.lessonIndex + 1} has incomplete lesson configuration.`);
      }
      await this.deliverLesson(studentKey, state.grade, next.lessonIndex, nextLesson, messageId);
    } else if (next.status === 'completed') {
      state.status = 'completed';
      this.saveProgress();
    }
    return true;
  }

  markTelegramSubmissionChecked(state, track, lesson, submission) {
    const savedSubmission = state.lastTaskSubmission;
    if (savedSubmission?.lessonId === lesson.id &&
        savedSubmission.grade === state.grade &&
        (savedSubmission.track || track) === track &&
        savedSubmission.text === submission) {
      savedSubmission.checkedAt = new Date().toISOString();
    }
  }
}

export function loadTelegramUpdateOffset(offsetFile = DEFAULT_OFFSET_FILE) {
  const value = readJsonFile(offsetFile, { offset: 0 });
  if (!Number.isSafeInteger(value?.offset) || value.offset < 0) {
    throw new Error(`Invalid Telegram update offset in ${offsetFile}.`);
  }
  return value.offset;
}

export function saveTelegramUpdateOffset(offset, offsetFile = DEFAULT_OFFSET_FILE) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Telegram update offset must be a non-negative safe integer.');
  }
  saveJsonAtomically(offsetFile, { offset });
}

export async function startTelegramPolling({
  api,
  agent,
  offsetFile = DEFAULT_OFFSET_FILE,
  updateQueue = new TelegramUpdateQueue(),
  signal,
  logger = console,
  retryDelayMs = POLL_RETRY_DELAY_MS,
  onStatus = () => {}
}) {
  if (typeof onStatus !== 'function') {
    throw new TypeError('Telegram polling status callback must be a function.');
  }
  let offset = loadTelegramUpdateOffset(offsetFile);
  onStatus('connecting');
  logger.info('[Telegram] Polling for group messages. Leave this process running; press Ctrl+C to stop it.');
  try {
    const recovered = agent.recoverPendingLessonSkips?.() || 0;
    if (recovered) logger.info(`[Telegram] Recovered ${recovered} interrupted lesson skip request(s).`);
  } catch (error) {
    logger.error(`[Telegram] Could not recover pending Telegram work: ${error.message}`);
    throw error;
  }
  const lessonSkipTimer = setInterval(() => {
    agent.processPendingLessonSkips?.().catch(error =>
      logger.error(`[Telegram] Lesson skip queue processing failed: ${error.message}`));
  }, 1000);
  agent.processPendingLessonSkips?.().catch(error =>
    logger.error(`[Telegram] Lesson skip queue processing failed: ${error.message}`));
  const answerReminderTimer = setInterval(() => {
    agent.processDueLessonAnswerReminders?.().catch(error =>
      logger.error(`[Telegram] Lesson answer reminder processing failed: ${error.message}`));
  }, LESSON_ANSWER_REMINDER_CHECK_INTERVAL_MS);
  agent.processDueLessonAnswerReminders?.().catch(error =>
    logger.error(`[Telegram] Lesson answer reminder processing failed: ${error.message}`));
  const motivationTimer = setInterval(() => {
    agent.processDueStudentMotivationMessages?.().catch(error =>
      logger.error(`[Telegram] Student motivation processing failed: ${error.message}`));
  }, STUDENT_MOTIVATION_CHECK_INTERVAL_MS);
  agent.processDueStudentMotivationMessages?.().catch(error =>
    logger.error(`[Telegram] Student motivation processing failed: ${error.message}`));
  const mediaRetryTimer = setInterval(() => {
    agent.processPendingMediaRetries?.().catch(error =>
      logger.error(`[Telegram] Media retry processing failed: ${error.message}`));
  }, 1000);
  agent.processPendingMediaRetries?.().catch(error =>
    logger.error(`[Telegram] Media retry processing failed: ${error.message}`));
  let updateWorkerError = null;
  const updateWorkers = Array.from({ length: TELEGRAM_UPDATE_CONCURRENCY }, () => (async () => {
    try {
      while (!signal?.aborted && !updateWorkerError) {
        const entry = updateQueue.takeNext();
        if (!entry) {
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        try {
          if (updateQueue.isTrackSelection(entry)) {
            await new Promise(resolve =>
              setTimeout(resolve, TELEGRAM_TRACK_SELECTION_SETTLE_MS));
            updateQueue.coalesceActiveTrackSelection(entry);
          }
          await agent.handleUpdate(
            entry.update,
            detail => updateQueue.updateActiveDetails(entry, detail)
          );
        } catch (error) {
          logger.error(`[Telegram] Could not process update ${entry.update.update_id}: ${error.message}`);
        } finally {
          updateQueue.finish(entry);
        }
      }
    } catch (error) {
      updateWorkerError = error;
      logger.error(`[Telegram] Update queue worker failed: ${error.message}`);
    }
  })());
  let pollRequestInProgress = false;
  let latestPollWasEmpty = false;
  let idleRecoveryRunning = false;
  let idleSince = null;
  const idleRecoveryTimer = setInterval(() => {
    if (idleRecoveryRunning || !latestPollWasEmpty || !updateQueue.isIdle?.()) {
      idleSince = null;
      return;
    }
    if (idleSince === null) {
      idleSince = Date.now();
      return;
    }
    if (Date.now() - idleSince < 1000) return;
    idleRecoveryRunning = true;
    agent.processUncheckedTaskSubmissions?.({ limit: 1 })
      .catch(error =>
        logger.error(`[Telegram] Idle task recovery failed: ${error.message}`))
      .finally(() => {
        idleRecoveryRunning = false;
        idleSince = null;
      });
  }, 200);
  try {
    while (!signal?.aborted && !updateWorkerError) {
      let updates;
      pollRequestInProgress = true;
      try {
        updates = await api.getUpdates(offset);
      } catch (error) {
        if (signal?.aborted) break;
        pollRequestInProgress = false;
        latestPollWasEmpty = false;
        onStatus('retrying');
        logger.error(`[Telegram] Polling failed: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      pollRequestInProgress = false;

      if (!Array.isArray(updates)) {
        throw new Error('Telegram getUpdates returned an invalid update list.');
      }
      onStatus('connected');
      logger.info(`[Telegram] Poll request completed; Telegram returned ${updates.length} update(s).`);
      latestPollWasEmpty = updates.length === 0;
      for (const update of updates) {
        updateQueue.enqueue(update);
        offset = update.update_id + 1;
        saveTelegramUpdateOffset(offset, offsetFile);
      }
    }
    if (updateWorkerError) throw updateWorkerError;
  } finally {
    clearInterval(lessonSkipTimer);
    clearInterval(answerReminderTimer);
    clearInterval(motivationTimer);
    clearInterval(mediaRetryTimer);
    clearInterval(idleRecoveryTimer);
    await Promise.all(updateWorkers);
    onStatus('disconnected');
  }
  logger.info(
    `[Telegram] Polling loop exited; shutdown signal received: ${signal?.aborted ? 'yes' : 'no'}.`
  );
}

async function runTelegramAgent() {
  installAgentLogCapture(TELEGRAM_AGENT_LOG_FILE);
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in .env before starting the Telegram agent.');

  const api = new TelegramBotApi(token);
  let connectionState = 'connecting';
  let lastConnectedAt;
  let botUsername = '';
  const reportStatus = nextState => {
    const wasConnected = connectionState === 'connected';
    connectionState = nextState;
    if (nextState === 'connected' && !wasConnected) {
      lastConnectedAt = new Date().toISOString();
    }
    try {
      writeTelegramAgentStatus(nextState, {
        botUsername,
        lastConnectedAt
      });
    } catch (error) {
      console.error('[Telegram Status] Could not update Telegram connection status:', error.message);
    }
  };
  reportStatus(connectionState);
  const heartbeatTimer = setInterval(() => reportStatus(connectionState), 10_000);

  let pollingStarted = false;
  try {
    const webhook = await api.getWebhookInfo();
    if (webhook?.url) {
      throw new Error('This bot has a webhook configured. Remove it before using long polling for Telegram.');
    }
    const bot = await api.getMe();
    botUsername = bot.username || '';
    console.log(`[Telegram] Connected as @${bot.username || bot.id}.`);
    reportStatus(connectionState);

    const agent = new TelegramLessonAgent({
      bot: api,
      groupId: process.env.TELEGRAM_GROUP_ID,
      classGroups: process.env.TELEGRAM_CLASS_GROUPS
        ? JSON.parse(process.env.TELEGRAM_CLASS_GROUPS)
        : {},
      progressFile: DEFAULT_PROGRESS_FILE
    });
    if (agent.groupGrades.size === 0) {
      console.log('[Telegram] Listening for a group ID; set TELEGRAM_GROUP_ID or TELEGRAM_CLASS_GROUPS in .env after it is detected.');
    }

    const controller = new AbortController();
    const stop = signal => {
      console.log(`[Telegram] Received ${signal}; shutting down polling.`);
      controller.abort();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    pollingStarted = true;
    await startTelegramPolling({
      api,
      agent,
      signal: controller.signal,
      onStatus: reportStatus
    });
  } finally {
    clearInterval(heartbeatTimer);
    reportStatus('disconnected');
    if (pollingStarted) console.log('[Telegram] Agent stopped.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runTelegramAgent().catch(error => {
    console.error('[Telegram] Startup failed:', error.message);
    try {
      writeTelegramAgentStatus('disconnected');
    } catch (statusError) {
      console.error('[Telegram Status] Could not report startup failure:', statusError.message);
    }
    process.exitCode = 1;
  });
}
