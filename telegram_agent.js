import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { config } from './config.js';
import { evaluateStudentTask } from './task_evaluator.js';
import { lessonManager, resolveLessonVideoPath } from './lesson_manager.js';
import {
  LessonSkipQueue,
  TELEGRAM_LESSON_SKIP_REQUESTS_FILE
} from './lesson_skip_queue.js';
import { scanPaymentReceipt } from './payment_scanner.js';
import {
  createStudentPaymentLedger,
  formatStudentPaymentStatus,
  STUDENT_PAYMENT_LEDGER_FILE
} from './student_payment_ledger.js';
import {
  TELEGRAM_AGENT_STATUS_FILE,
  writeTelegramAgentStatus
} from './telegram_agent_status.js';
import { isExplicitPaidClaim } from './contact_payment_labels.js';
import {
  getDueLessonAnswerReminders,
  LESSON_ANSWER_REMINDER_CHECK_INTERVAL_MS,
  LESSON_ANSWER_REMINDER_MESSAGE,
  markLessonAnswerReminderSent
} from './lesson_answer_reminders.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(APP_DIR, 'data');
const DEFAULT_PROGRESS_FILE = path.join(DATA_DIR, 'telegram_progress.json');
const DEFAULT_OFFSET_FILE = path.join(DATA_DIR, 'telegram_update_offset.json');
const TELEGRAM_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const TELEGRAM_MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const LONG_POLL_SECONDS = 25;
const NETWORK_TIMEOUT_MS = 35_000;
const POLL_RETRY_DELAY_MS = 5_000;

function saveJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
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

function isLessonCommand(text) {
  return /^\/lesson(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function isPaymentClaimCommand(text) {
  return /^\/paid(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function isPaymentStatusCommand(text) {
  return /^\/(?:payment|paystatus)(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function isGroupChat(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

function isReadyLesson(lesson) {
  return Boolean(
    lesson &&
    typeof lesson.videoFile === 'string' &&
    typeof lesson.taskMessage === 'string' &&
    lesson.taskMessage.trim() &&
    Array.isArray(lesson.answerKey) &&
    lesson.answerKey.length
  );
}

function taskFailureMessage() {
  return 'ما قدرت أصحح إجابتك هسي بسبب مشكلة فنية. ما اتسجلت كغلط؛ أرسلها تاني بعد شوية.';
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
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
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
    } catch {
      throw new Error(`Telegram ${method} request failed before a response was received.`);
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

  sendMessage(chatId, text, replyToMessageId) {
    return this.request('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {})
    });
  }

  sendVideo(chatId, video, caption, replyToMessageId) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('video', new Blob([video], { type: 'video/mp4' }), 'lesson.mp4');
    form.append('caption', caption || '');
    if (replyToMessageId) {
      form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
    }
    return this.request('sendVideo', form, { upload: true });
  }
}

export class TelegramLessonAgent {
  constructor({
    bot,
    groupId,
    lessonManager: lessonManagerInstance = lessonManager,
    evaluateTask = evaluateStudentTask,
    videoPathResolver = resolveLessonVideoPath,
    progressFile = DEFAULT_PROGRESS_FILE,
    defaultGrade = config.defaultStudentGrade,
    maxVideoBytes = TELEGRAM_MAX_VIDEO_BYTES,
    lessonSkipQueue = new LessonSkipQueue(TELEGRAM_LESSON_SKIP_REQUESTS_FILE),
    paymentLedger = createStudentPaymentLedger(STUDENT_PAYMENT_LEDGER_FILE),
    scanReceipt = scanPaymentReceipt,
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
    this.maxVideoBytes = maxVideoBytes;
    this.lessonSkipQueue = lessonSkipQueue;
    this.paymentLedger = paymentLedger;
    this.scanReceipt = scanReceipt;
    this.logger = logger;
    this.processingLessonSkips = false;
    this.processingAnswerReminders = false;
    this.progress = readJsonFile(progressFile, {});
    if (!this.progress || typeof this.progress !== 'object' || Array.isArray(this.progress)) {
      throw new Error(`Invalid Telegram lesson progress in ${progressFile}.`);
    }
    this.discoveredGroupIds = new Set();
    this.ignoredGroupIds = new Set();
    this.studentOperations = new Map();
  }

  async handleUpdate(update) {
    const message = update?.message;
    if (!message) return;
    if (message.chat?.type === 'private') {
      await this.handlePrivateUpdate(message);
      return;
    }
    if (!isGroupChat(message.chat)) return;

    const chatId = String(message.chat.id);
    if (!this.groupId) {
      if (!this.discoveredGroupIds.has(chatId)) {
        this.discoveredGroupIds.add(chatId);
        this.logger.info(
          `[Telegram] Group detected: ${chatId}. Set TELEGRAM_GROUP_ID to this value and restart to enable lesson replies.`
        );
      }
      return;
    }
    if (chatId !== this.groupId) {
      if (!this.ignoredGroupIds.has(chatId)) {
        this.ignoredGroupIds.add(chatId);
        this.logger.info(
          `[Telegram] Ignoring messages from group ${chatId}; it does not match TELEGRAM_GROUP_ID.`
        );
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
    if (!text) {
      if (Array.isArray(message.photo) && message.photo.length) {
        await this.bot.sendMessage(
          chatId,
          'عشان خصوصيتك، أرسل إيصال الدفع في الخاص. افتح المحادثة الخاصة معاي واضغط Start، وبعدها أرسل صورة الإيصال.'
        );
        return;
      }
      this.logger.info('[Telegram] Media-only messages are not graded; submit task answers as text.');
      return;
    }

    if (isPaymentStatusCommand(text)) {
      const state = this.progress[studentKey];
      if (state?.telegramPrivateChatId) {
        const payment = this.paymentLedger.getCurrent(
          studentKey,
          state.enrolledAt || state.joinedAt || state.deliveredAt
        );
        await this.bot.sendMessage(
          state.telegramPrivateChatId,
          formatStudentPaymentStatus(payment)
        );
        await this.bot.sendMessage(chatId, 'أرسلت ليك حالة الدفع في الخاص.');
      } else {
        await this.bot.sendMessage(
          chatId,
          'عشان خصوصيتك، افتح المحادثة الخاصة معاي واضغط Start، وبعدها أرسل /payment عشان تعرف حالة الدفع.'
        );
      }
      return;
    }

    if (isPaymentClaimCommand(text) || isExplicitPaidClaim(text)) {
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, chatId, message.from);
        const state = this.progress[studentKey];
        const payment = this.paymentLedger.recordClaim(studentKey, {
          enrolledAt: state.enrolledAt || state.joinedAt || state.deliveredAt,
          source: 'telegram-claim'
        });
        await this.bot.sendMessage(
          chatId,
          payment.status === 'paid'
            ? 'دفعك للفترة الحالية متأكد من قبل. حفظت البلاغ الجديد للرجوع ليه.'
            : 'وصل بلاغ الدفع للمراجعة، وما حيتسجل كمدفوع إلا بعد ما نتأكد منه. أرسل /payment في الخاص عشان تعرف حالة الدفع.'
        );
        this.logger.info(`[Telegram] Recorded a payment claim for ${studentKey} as ${payment.status}.`);
      });
      return;
    }

    if (isLessonCommand(text)) {
      this.logger.info(`[Telegram] Starting or resuming a lesson for ${studentName}.`);
      await this.runStudentOperation(studentKey, async () => {
        this.recordStudentActivity(studentKey, chatId, message.from);
        await this.startOrResumeLesson(chatId, studentKey, message.message_id);
      });
      return;
    }
    if (!this.progress[studentKey] ||
        !['awaiting_task', 'awaiting_reattempt'].includes(this.progress[studentKey].status)) {
        this.logger.info(`[Telegram] Ignoring text from ${studentName}; they have no active lesson task. Send /lesson to start.`);
        return;
    }
    if (text.startsWith('/')) {
        this.logger.info(`[Telegram] Ignoring unsupported command from ${studentName}.`);
        return;
    }

    const submittedLessonId = this.progress[studentKey].currentLessonId;
    await this.runStudentOperation(studentKey, async () => {
      const currentState = this.progress[studentKey];
      if (!currentState || currentState.currentLessonId !== submittedLessonId) {
        await this.bot.sendMessage(
          chatId,
          'الحصة اتغيرت قبل ما أراجع إجابتك. جاوب على تمرين آخر حصة وصلتك.',
          message.message_id
        );
        return;
      }
      this.recordStudentActivity(studentKey, chatId, message.from, { submission: true });
      await this.gradeSubmission({
        chatId,
        studentKey,
        studentName,
        messageId: message.message_id,
        submission: text
      });
    });
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
    this.progress[studentKey] = {
      ...state,
      grade: state.grade || this.defaultGrade,
      telegramChatId: String(chatId),
      telegramUserId: user.id,
      telegramUsername: user.username || '',
      name: getStudentName(user),
      joinedAt,
      enrolledAt: state.enrolledAt || joinedAt,
      lastActivityAt: new Date(now).toISOString(),
      submissionsReceived: (state.submissionsReceived || 0) + Number(submission),
      activityTimestamps
    };
    this.saveProgress();
  }

  findTelegramStudent(userId) {
    return Object.entries(this.progress).find(([, state]) =>
      String(state.telegramUserId) === String(userId) &&
      (!this.groupId || String(state.telegramChatId) === this.groupId)
    ) || null;
  }

  async handlePrivateUpdate(message) {
    const userId = message.from?.id;
    if (!Number.isSafeInteger(userId) || message.from.is_bot) return;
    const found = this.findTelegramStudent(userId);
    if (!found) {
      await this.bot.sendMessage(
        String(message.chat.id),
        'ما لقيت حسابك في مجموعة الدروس لسه. أدخل مجموعة الدروس وأرسل /lesson، وبعدها ارجع هنا عشان تعرف حالة الدفع أو تبلغ عن دفع.'
      );
      return;
    }

    const [studentKey, state] = found;
    state.telegramPrivateChatId = String(message.chat.id);
    this.saveProgress();
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (isPaymentStatusCommand(text) || /^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text)) {
      const payment = this.paymentLedger.getCurrent(
        studentKey,
        state.enrolledAt || state.joinedAt || state.deliveredAt
      );
      await this.bot.sendMessage(
        String(message.chat.id),
        isPaymentStatusCommand(text)
          ? formatStudentPaymentStatus(payment)
          : `أهلين بيك. ${formatStudentPaymentStatus(payment)} أرسل /payment عشان تعرف الحالة، أو /paid عشان تبلغ عن الدفع.`
      );
      return;
    }

    if (isPaymentClaimCommand(text) || isExplicitPaidClaim(text)) {
      const payment = this.paymentLedger.recordClaim(studentKey, {
        enrolledAt: state.enrolledAt || state.joinedAt || state.deliveredAt,
        source: 'telegram-claim'
      });
      await this.bot.sendMessage(
        String(message.chat.id),
        payment.status === 'paid'
          ? 'دفعك للفترة الحالية متأكد من قبل. حفظت البلاغ الجديد للرجوع ليه.'
          : 'وصل بلاغ الدفع للمراجعة، وما حيتسجل كمدفوع إلا بعد ما نتأكد منه.'
      );
      return;
    }

    if (Array.isArray(message.photo) && message.photo.length) {
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
        const payment = this.paymentLedger.recordClaim(studentKey, {
          enrolledAt: state.enrolledAt || state.joinedAt || state.deliveredAt,
          source: 'telegram-receipt',
          details: scan.details
        });
        await this.bot.sendMessage(
          String(message.chat.id),
          'وصل الإيصال للمراجعة، وما حيتسجل الدفع كمدفوع إلا بعد ما نتأكد منه.'
        );
      } catch (error) {
        this.logger.error(`[Telegram] Could not review a private receipt for ${studentKey}: ${error.message}`);
        await this.bot.sendMessage(
          String(message.chat.id),
          'ما قدرت أراجع الإيصال هسي، وما اتسجل الدفع كمدفوع. جرّب تاني بعد شوية أو أرسل /paid عشان نراجع البلاغ يدوياً.'
        );
      }
      return;
    }

    await this.bot.sendMessage(
      String(message.chat.id),
      'أرسل /payment عشان تعرف حالة الدفع، أو /paid عشان تبلغ عن الدفع، أو أرسل صورة الإيصال للمراجعة.'
    );
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
    if (!state ||
        request.studentKey !== `telegram:${request.chatId}:${request.userId}` ||
        String(state.telegramChatId) !== request.chatId ||
        String(state.telegramUserId) !== request.userId ||
        state.currentLessonId !== request.currentLessonId ||
        state.grade !== request.gradeKey ||
        !['awaiting_task', 'awaiting_reattempt', 'awaiting_content', 'completed'].includes(state.status)) {
      this.lessonSkipQueue.complete(
        request.id,
        'failed',
        'Student progress changed before the lesson skip could be delivered.'
      );
      this.logger.info(`[Telegram] Discarded stale lesson skip request ${request.id}.`);
      return false;
    }

    const next = this.lessonManager.getNextSequentialLesson(state.grade, state.currentLessonId);
    const lesson = next.status === 'ready'
      ? this.lessonManager.lessonsConfig[state.grade]?.lessons?.[next.lessonIndex]
      : null;
    if (!lesson || lesson.id !== request.nextLessonId || !isReadyLesson(lesson)) {
      this.lessonSkipQueue.complete(
        request.id,
        'failed',
        'The configured next lesson changed or is no longer ready.'
      );
      this.logger.info(`[Telegram] Could not find the requested next lesson for ${request.studentKey}.`);
      return false;
    }

    try {
      await this.deliverLesson(
        request.chatId,
        request.studentKey,
        state.grade,
        next.lessonIndex,
        lesson
      );
      this.lessonSkipQueue.complete(request.id, 'sent');
      this.logger.info(`[Telegram] Delivered ${lesson.id} to ${request.studentKey} after an admin skip.`);
      return true;
    } catch (error) {
      this.lessonSkipQueue.complete(request.id, 'failed', error.message);
      this.logger.error(`[Telegram] Could not deliver a lesson skip to ${request.studentKey}: ${error.message}`);
      return false;
    }
  }

  getNextLesson(studentKey) {
    const state = this.progress[studentKey];
    if (state?.currentLessonId) {
      return this.lessonManager.getNextSequentialLesson(state.grade, state.currentLessonId);
    }
    const lesson = this.lessonManager.getWelcomeSampleLesson(this.defaultGrade);
    if (!lesson) return { status: 'awaiting_content' };
    const lessonIndex = this.lessonManager.lessonsConfig[this.defaultGrade]?.lessons
      ?.findIndex(candidate => candidate.id === lesson.id) ?? -1;
    return lessonIndex >= 0
      ? { status: 'ready', lessonIndex }
      : { status: 'awaiting_content' };
  }

  async startOrResumeLesson(chatId, studentKey, messageId) {
    const state = this.progress[studentKey];
    if (state && ['awaiting_task', 'awaiting_reattempt'].includes(state.status)) {
      const lesson = this.lessonManager.lessonsConfig[state.grade]?.lessons?.[state.currentLessonIndex];
      if (lesson?.taskMessage) {
        await this.bot.sendMessage(chatId, lesson.taskMessage, messageId);
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
    const lesson = this.lessonManager.lessonsConfig[this.defaultGrade]?.lessons?.[next.lessonIndex];
    if (!isReadyLesson(lesson)) {
      throw new Error(`Lesson ${next.lessonIndex + 1} is missing its video, task, or answer key.`);
    }
    await this.deliverLesson(chatId, studentKey, this.defaultGrade, next.lessonIndex, lesson, messageId);
  }

  async deliverLesson(chatId, studentKey, grade, lessonIndex, lesson, replyToMessageId) {
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
    await this.bot.sendVideo(
      chatId,
      video,
      lesson.caption || lesson.title || '',
      replyToMessageId
    );
    await this.bot.sendMessage(chatId, lesson.taskMessage, replyToMessageId);

    const previous = this.progress[studentKey] || {};
    this.progress[studentKey] = {
      ...previous,
      grade,
      currentLessonIndex: lessonIndex,
      currentLessonId: lesson.id,
      status: 'awaiting_task',
      deliveredAt: new Date().toISOString(),
      joinedAt: previous.joinedAt || new Date().toISOString(),
      lessonsCompleted: previous.lessonsCompleted || 0
    };
    this.saveProgress();
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

  async gradeSubmission({ chatId, studentKey, studentName, messageId, submission }) {
    const state = this.progress[studentKey];
    const lesson = this.lessonManager.lessonsConfig[state.grade]?.lessons?.[state.currentLessonIndex];
    if (!isReadyLesson(lesson)) {
      throw new Error(`Active Telegram lesson is missing its task or answer key for ${studentKey}.`);
    }

    let result;
    try {
      result = await this.evaluateTask(lesson, submission, studentName);
    } catch (error) {
      this.logger.error(`[Telegram] Could not grade a task for ${studentKey}: ${error.message}`);
      await this.bot.sendMessage(chatId, taskFailureMessage(), messageId);
      return;
    }
    if (!result.isTaskSubmission) return;

    await this.bot.sendMessage(chatId, result.feedback, messageId);
    if (!result.allCorrect) {
      state.status = 'awaiting_reattempt';
      this.saveProgress();
      return;
    }

    state.lessonsCompleted = (state.lessonsCompleted || 0) + 1;
    state.status = 'awaiting_content';
    this.saveProgress();
    const next = this.lessonManager.getNextSequentialLesson(state.grade, state.currentLessonId);
    if (next.status === 'ready') {
      const nextLesson = this.lessonManager.lessonsConfig[state.grade]?.lessons?.[next.lessonIndex];
      if (!isReadyLesson(nextLesson)) {
        throw new Error(`Next Telegram lesson ${next.lessonIndex + 1} has incomplete lesson configuration.`);
      }
      await this.deliverLesson(chatId, studentKey, state.grade, next.lessonIndex, nextLesson, messageId);
    } else if (next.status === 'completed') {
      state.status = 'completed';
      this.saveProgress();
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
    logger.error(`[Telegram] Could not recover queued lesson skips: ${error.message}`);
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
  try {
    while (!signal?.aborted) {
      let updates;
      try {
        updates = await api.getUpdates(offset);
      } catch (error) {
        if (signal?.aborted) break;
        onStatus('retrying');
        logger.error(`[Telegram] Polling failed: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }

      if (!Array.isArray(updates)) {
        throw new Error('Telegram getUpdates returned an invalid update list.');
      }
      onStatus('connected');
      logger.info(`[Telegram] Poll request completed; Telegram returned ${updates.length} update(s).`);
      for (const update of updates) {
        try {
          await agent.handleUpdate(update);
        } catch (error) {
          logger.error(`[Telegram] Could not process update ${update.update_id}: ${error.message}`);
        }
        offset = update.update_id + 1;
        saveTelegramUpdateOffset(offset, offsetFile);
      }
    }
  } finally {
    clearInterval(lessonSkipTimer);
    clearInterval(answerReminderTimer);
    onStatus('disconnected');
  }
  logger.info(
    `[Telegram] Polling loop exited; shutdown signal received: ${signal?.aborted ? 'yes' : 'no'}.`
  );
}

async function runTelegramAgent() {
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
      progressFile: DEFAULT_PROGRESS_FILE
    });
    if (!agent.groupId) {
      console.log('[Telegram] Listening for a group ID; set TELEGRAM_GROUP_ID in .env after it is detected.');
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
