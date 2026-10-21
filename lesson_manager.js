import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { evaluateStudentTask } from './task_evaluator.js';
import { sendHumanizedMessage } from './humanization.js';
import { historyManager } from './history.js';
import { findLessonForMediaActivity } from './lesson_media_retry.js';
import { getPhoneJid } from './phonebook.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve('data');
const PROGRESS_FILE = path.join(DATA_DIR, 'student_progress.json');
const LESSONS_FILE = path.resolve('lessons.json');
const DAILY_LESSON_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function resolveLessonVideoPath(videoFile) {
  if (typeof videoFile !== 'string' || !videoFile.trim()) {
    throw new TypeError('A lesson video path is required.');
  }
  return path.resolve(APP_DIR, videoFile);
}

function readLessonVideo(lesson) {
  const videoAbsolutePath = resolveLessonVideoPath(lesson.videoFile);
  const stats = fs.statSync(videoAbsolutePath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`Lesson video is not a non-empty file: ${videoAbsolutePath}`);
  }
  return { videoAbsolutePath, video: fs.readFileSync(videoAbsolutePath) };
}

function normalizeLessonConsentMessage(message) {
  return message
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[?!.,،؛]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHistoricalLessonText(message) {
  return message.toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632))
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function inferSentLessonProgress(messages, lessons) {
  if (!Array.isArray(messages) || !Array.isArray(lessons)) return null;
  const sentMessages = messages
    .filter(message => message?.role === 'agent' && typeof message.text === 'string')
    .map(message => normalizeHistoricalLessonText(message.text))
    .filter(Boolean);
  let latestMatch = null;

  for (const [lessonIndex, lesson] of lessons.entries()) {
    const taskMessage = typeof lesson.taskMessage === 'string'
      ? normalizeHistoricalLessonText(lesson.taskMessage)
      : '';
    const title = typeof lesson.title === 'string'
      ? normalizeHistoricalLessonText(lesson.title)
      : '';
    const lessonId = typeof lesson.id === 'string'
      ? normalizeHistoricalLessonText(lesson.id)
      : '';
    const videoMarker = title ? `فيديو ${title}` : '';
    const markerWithoutEmoji = title ? `[فيديو ${title}]` : '';
    const taskIsUnique = taskMessage &&
      lessons.filter(candidate => typeof candidate.taskMessage === 'string' &&
        normalizeHistoricalLessonText(candidate.taskMessage) === taskMessage).length === 1;
    const taskWasSent = taskIsUnique && taskMessage.length >= 12 &&
      sentMessages.some(message => message === taskMessage ||
        (taskMessage.length >= 48 && message.includes(taskMessage)));
    const lessonIdMarker = lessonId ? `فيديو ${lessonId}` : '';
    const videoMarkers = [videoMarker, markerWithoutEmoji, lessonIdMarker].filter(Boolean);
    const videoWasSent = videoMarkers.length > 0 &&
      sentMessages.some(message => videoMarkers.some(marker => message.includes(marker)));
    if (taskWasSent || videoWasSent) {
      latestMatch = { lessonIndex, lessonId: lesson.id };
    }
  }

  return latestMatch;
}

export function isLessonPermissionQuestion(message) {
  if (typeof message !== 'string') return false;
  const normalized = normalizeLessonConsentMessage(message);
  return (
    /\b(?:may|can|could)\s+i\s+send\b.{0,60}\blessons?\b/i.test(message) ||
    /(?:جاهز|جاهزة|جاهزه|تحب|تحبي|ممكن|عايز|عايزة|عايزه|حابب|حابة|حابه|رايك شنو|موافق|موافقة|موافقه).{0,50}(?:ارسل|رسل|نرسل|ابدا|نبدا|درس|فيديو|حصة|حصه)/.test(normalized) ||
    /(?:ارسل|رسل|نرسل|ابدا|نبدا|نبدأ).{0,40}(?:درس|فيديو|حصة|حصه).{0,30}(?:موافق|موافقة|موافقه|جاهز|جاهزة|جاهزه|رايك)/.test(normalized)
  );
}

export function isLessonDeliveryDecline(message, previousAgentMessage = '') {
  if (typeof message !== 'string' || !isLessonPermissionQuestion(previousAgentMessage)) return false;
  const normalized = normalizeLessonConsentMessage(message);
  return /^(?:no|not yet|later|maybe later|لا|ما هسي|بعدين|لاحقا)(?:\b|\s|$)/i.test(normalized) ||
    /\b(?:not yet|not now|later)\b|بعدين|لاحقا/i.test(normalized);
}

export function hasLessonDeliveryConsent(message, previousAgentMessage = '') {
  if (typeof message !== 'string') return false;
  const normalized = normalizeLessonConsentMessage(message);
  if (isLessonDeliveryDecline(message, previousAgentMessage)) return false;

  const isAffirmative = /\b(?:yes|yeah|yep|sure|okay|ok|go ahead|send it|please do|i agree)\b|ايوة|ايوه|ايوا|ااي|اي|نعم|تمام|موافق|موافقة|موافقه|ماشي|مافي مشكلة|نبدا|يلا|ابدا|رسل|ارسل/i.test(normalized);

  // Direct explicit agreement to start lessons
  if (/^(?:اي|ااي|ايوة|ايوه|تمام|موافق|موافقة|موافقه|يلا)\s*(?:نبدا|ابدا|رسل|ارسل)(?:\s|$)/i.test(normalized) ||
      /(?:نبدا|ابدا)\s*(?:هسي|الان|طوالي)/i.test(normalized)) {
    return true;
  }

  if (!isLessonPermissionQuestion(previousAgentMessage)) return false;
  return isAffirmative;
}

class LessonManager {
  constructor() {
    this.progress = {};
    this.lessonsConfig = {};
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(PROGRESS_FILE)) {
        this.progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      }
      if (fs.existsSync(LESSONS_FILE)) {
        this.lessonsConfig = JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf-8'));
        this.lessonsConfigMtime = fs.statSync(LESSONS_FILE).mtimeMs;
      }
    } catch (err) {
      console.error('[LessonManager] Init error:', err.message);
    }
  }

  saveProgress() {
    try {
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(this.progress, null, 2), 'utf-8');
    } catch (err) {
      console.error('[LessonManager] Save error:', err.message);
    }
  }

  saveLessonsConfig() {
    try {
      fs.writeFileSync(LESSONS_FILE, JSON.stringify(this.lessonsConfig, null, 2), 'utf-8');
      this.lessonsConfigMtime = fs.statSync(LESSONS_FILE).mtimeMs;
      return true;
    } catch (err) {
      console.error('[LessonManager] Save lessons error:', err.message);
      return false;
    }
  }

  refreshLessonsConfig() {
    if (!fs.existsSync(LESSONS_FILE)) return false;
    const modifiedAt = fs.statSync(LESSONS_FILE).mtimeMs;
    if (modifiedAt === this.lessonsConfigMtime) return false;
    const updatedConfig = JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf-8'));
    this.lessonsConfig = updatedConfig;
    this.lessonsConfigMtime = modifiedAt;
    return true;
  }

  /**
   * Adds or updates a lesson with its task and answer key
   */
  addOrUpdateLesson(gradeKey, lessonData) {
    if (!this.lessonsConfig[gradeKey]) {
      this.lessonsConfig[gradeKey] = {
        name: gradeKey,
        keywords: [gradeKey],
        lessons: []
      };
    }
    const lessons = this.lessonsConfig[gradeKey].lessons;
    const existingIndex = lessons.findIndex(l => l.id === lessonData.id);
    if (existingIndex >= 0) {
      lessons[existingIndex] = { ...lessons[existingIndex], ...lessonData };
    } else {
      lessons.push(lessonData);
    }
    this.saveLessonsConfig();
    return lessons[existingIndex >= 0 ? existingIndex : lessons.length - 1];
  }

  /**
   * Detects educational stage from incoming text
   * @param {string} text 
   * @returns {string | null} Grade key (e.g. 'grade_3_secondary') or null
   */
  detectGrade(text) {
    if (!text) return null;
    const normalize = value => value
      .toLowerCase()
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632))
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedText = normalize(text);

    // Fast check for unambiguous Sudanese secondary/certificate phrases
    if (/(?:^|\s)(?:ممتحن|ممتحنه|ممتحنين|امتحنت|بمتحن)(?:\s|$)/.test(normalizedText) ||
        /(?:شهاده|الشهاده)\s*(?:سودانيه|السودانيه|ثانويه|الثانويه)/.test(normalizedText)) {
      return 'grade_3_secondary';
    }

    const stripDefiniteArticle = str => str.split(/\s+/).map(w => w.replace(/^ال/, '')).join(' ');
    const strippedText = stripDefiniteArticle(normalizedText);

    for (const [gradeKey, data] of Object.entries(this.lessonsConfig)) {
      for (const keyword of data.keywords) {
        const normKeyword = normalize(keyword);
        if (normalizedText.includes(normKeyword)) {
          return gradeKey;
        }
        const strippedKeyword = stripDefiniteArticle(normKeyword);
        if (strippedKeyword && strippedText.includes(strippedKeyword)) {
          return gradeKey;
        }
      }
    }
    return null;
  }

  getStudent(jid, phoneJid = null) {
    if (!jid && !phoneJid) return null;
    if (jid && this.progress[jid]) return this.progress[jid];
    if (phoneJid && this.progress[phoneJid]) return this.progress[phoneJid];
    return null;
  }

  reconcileProgressFromHistory(jid, phoneJid, gradeKey) {
    const existing = this.getStudent(jid, phoneJid);
    if (existing && existing.status !== 'consulting') return existing;

    const lessons = this.lessonsConfig[gradeKey]?.lessons || [];
    const phoneJids = new Set([jid, phoneJid].filter(Boolean).map(value =>
      getPhoneJid(value, historyManager.contacts[value]?.phoneJid, historyManager.contacts[value]?.jid)
    ).filter(Boolean));
    const messages = Object.entries(historyManager.history).flatMap(([historyJid, history]) => {
      if (!Array.isArray(history)) return [];
      const linkedPhoneJid = getPhoneJid(
        historyJid,
        historyManager.contacts[historyJid]?.phoneJid,
        historyManager.contacts[historyJid]?.jid
      );
      return historyJid === jid || historyJid === phoneJid ||
        (linkedPhoneJid && phoneJids.has(linkedPhoneJid))
        ? history
        : [];
    });
    const inferred = inferSentLessonProgress(messages, lessons);
    if (!inferred) return existing;

    const lesson = lessons[inferred.lessonIndex];
    const nextLesson = this.getNextSequentialLesson(gradeKey, inferred.lessonId);
    const entry = {
      grade: gradeKey,
      currentLessonIndex: inferred.lessonIndex,
      currentLessonId: inferred.lessonId,
      status: nextLesson.status === 'completed' ? 'completed' : 'awaiting_content',
      historyReconciled: true,
      deliveredAt: null
    };
    this.progress[jid] = entry;
    if (phoneJid && phoneJid !== jid) this.progress[phoneJid] = entry;
    this.saveProgress();
    historyManager.setWelcomeSampleState('sent', jid, phoneJid);
    console.log(`[Lesson History] Reconciled ${jid} at ${lesson.id} (${lesson.title}) from saved outgoing lesson history.`);
    return entry;
  }

  setStudentGrade(jid, gradeKey, phoneJid = null) {
    const student = this.getStudent(jid, phoneJid);
    if (!student) {
      const entry = {
        grade: gradeKey,
        currentLessonIndex: 0,
        status: 'consulting'
      };
      if (jid) this.progress[jid] = entry;
      if (phoneJid && phoneJid !== jid) this.progress[phoneJid] = entry;
    } else {
      student.grade = gradeKey;
      if (jid && !this.progress[jid]) this.progress[jid] = student;
      if (phoneJid && !this.progress[phoneJid]) this.progress[phoneJid] = student;
    }
    this.saveProgress();
  }

  /**
   * Check if student has an active lesson they need to submit homework for
   */
  hasActiveLesson(jid, phoneJid = null) {
    const student = this.getStudent(jid, phoneJid);
    if (!student) return false;
    return [
      'awaiting_task',
      'awaiting_reattempt',
      'awaiting_next_lesson_schedule'
    ].includes(student.status);
  }

  getTreasureIslandLessons() {
    this.refreshLessonsConfig();
    const lessons = this.lessonsConfig.grade_3_secondary?.collections?.treasure_island?.lessons;
    if (!Array.isArray(lessons)) return [];
    return lessons.filter(lesson => {
      if (!lesson?.videoFile || typeof lesson.taskMessage !== 'string' ||
          !lesson.taskMessage.trim() || !Array.isArray(lesson.answerKey) ||
          lesson.answerKey.length === 0) return false;
      try {
        const stats = fs.statSync(resolveLessonVideoPath(lesson.videoFile));
        return stats.isFile() && stats.size > 0;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  isTreasureIslandRequest(text) {
    if (typeof text !== 'string') return false;
    const normalized = normalizeHistoricalLessonText(text);
    return /treasure\s+island|جزيرة\s+الكنز|\b(?:book|novel)\s+(?:lessons?|chapters?)\b/.test(normalized);
  }

  hasActiveTreasureIslandLesson(jid, phoneJid = null) {
    const state = this.getStudent(jid, phoneJid)?.treasureIsland;
    return ['awaiting_task', 'awaiting_reattempt'].includes(state?.status);
  }

  setTreasureIslandState(jid, phoneJid, updates) {
    const current = this.getStudent(jid, phoneJid) || {};
    const entry = {
      ...current,
      treasureIsland: { ...(current.treasureIsland || {}), ...updates }
    };
    if (jid) this.progress[jid] = entry;
    if (phoneJid && phoneJid !== jid) this.progress[phoneJid] = entry;
    this.saveProgress();
    return entry.treasureIsland;
  }

  recordTreasureIslandMessage(jid, text) {
    try {
      historyManager.addMessage(jid, 'agent', text);
    } catch (error) {
      console.error(`[LessonManager] Could not save Treasure Island chat history for ${jid}:`, error.message);
    }
  }

  async sendTreasureIslandText(sock, jid, text) {
    await sock.sendMessage(jid, { text });
    this.recordTreasureIslandMessage(jid, text);
  }

  async handleTreasureIslandMessage(sock, jid, text, pushName, phoneJid = null) {
    const student = this.getStudent(jid, phoneJid);
    if (this.isTreasureIslandRequest(text)) {
      if (this.hasActiveTreasureIslandLesson(jid, phoneJid) ||
          this.hasActiveLesson(jid, phoneJid)) {
        await this.sendTreasureIslandText(
          sock,
          jid,
          'Please finish your active lesson exercise first. You can choose a Treasure Island chapter after I check your answers.'
        );
        return true;
      }
      const lessons = this.getTreasureIslandLessons();
      if (lessons.length === 0) {
        await this.sendTreasureIslandText(
          sock, jid, 'Treasure Island lessons are not available yet. Please check back later.'
        );
        return true;
      }
      this.setTreasureIslandState(jid, phoneJid, { pendingLessonSelection: true });
      await this.sendTreasureIslandText(
        sock,
        jid,
        `Choose a Treasure Island lesson by replying with its number or title:\n\n${lessons
          .map((lesson, index) => `${index + 1}. ${lesson.title || lesson.id}`)
          .join('\n')}`
      );
      return true;
    }

    if (this.hasActiveTreasureIslandLesson(jid, phoneJid)) {
      const state = this.getStudent(jid, phoneJid)?.treasureIsland;
      const lessonAvailable = this.getTreasureIslandLessons()
        .some(lesson => lesson.id === state?.activeLessonId);
      if (!lessonAvailable) {
        this.setTreasureIslandState(jid, phoneJid, {
          activeLessonId: null,
          status: 'unavailable',
          pendingLessonSelection: false
        });
        await this.sendTreasureIslandText(
          sock,
          jid,
          'Your active Treasure Island chapter is no longer available. Ask me for the Treasure Island lesson list to choose another chapter.'
        );
        return true;
      }
      return this.handleTreasureIslandTaskSubmission(sock, jid, text, pushName, phoneJid);
    }

    if (!student?.treasureIsland?.pendingLessonSelection) return false;
    const lessons = this.getTreasureIslandLessons();
    if (lessons.length === 0) {
      this.setTreasureIslandState(jid, phoneJid, { pendingLessonSelection: false });
      await this.sendTreasureIslandText(
        sock, jid, 'There are no complete Treasure Island lessons available right now.'
      );
      return true;
    }

    const normalizedChoice = normalizeHistoricalLessonText(text);
    const numberMatch = /^(?:lesson\s*)?(\d+)$/.exec(normalizedChoice);
    const choiceNumber = numberMatch ? Number(numberMatch[1]) : null;
    const selected = choiceNumber
      ? lessons[choiceNumber - 1]
      : lessons.find(lesson =>
        normalizeHistoricalLessonText(lesson.title || lesson.id) === normalizedChoice);
    if (!selected) {
      await this.sendTreasureIslandText(
        sock,
        jid,
        'I could not match that choice. Reply with a number or the exact title from the Treasure Island list.'
      );
      return true;
    }

    this.setTreasureIslandState(jid, phoneJid, { pendingLessonSelection: false });
    await this.deliverTreasureIslandLesson(sock, jid, selected, phoneJid);
    return true;
  }

  async deliverTreasureIslandLesson(sock, jid, lesson, phoneJid = null) {
    if (!await this.canDeliverLessonToday(sock, jid, phoneJid)) return false;
    let video;
    let videoAbsolutePath;
    try {
      ({ video, videoAbsolutePath } = readLessonVideo(lesson));
    } catch (error) {
      console.error(`[LessonManager] Cannot deliver Treasure Island ${lesson.id} to ${jid}:`, error.message);
      await this.sendTreasureIslandText(
        sock, jid, `The video for "${lesson.title}" is currently unavailable, so I did not send the exercise.`
      );
      return false;
    }
    const collectionId = 'treasure_island';
    if (lesson.introMessage) {
      await sock.sendMessage(jid, { text: lesson.introMessage });
      this.recordTreasureIslandMessage(jid, lesson.introMessage);
    }
    try {
      await sock.sendMessage(jid, {
        video,
        caption: lesson.caption || lesson.title,
        mimetype: 'video/mp4'
      }, undefined, { retry: { gradeKey: 'grade_3_secondary', lessonId: lesson.id, collectionId } });
    } catch (error) {
      console.error(`[LessonManager] Treasure Island video upload failed for ${lesson.id} to ${jid}:`, error.message);
      await this.sendTreasureIslandText(
        sock,
        jid,
        `The video for "${lesson.title}" could not be sent, so I did not send the exercise. Please ask me to resend the video.`
      );
      return false;
    }
    this.recordTreasureIslandMessage(jid, `🎬 [فيديو: ${lesson.title}]\n${lesson.caption || ''}`);
    try {
      await this.sendTreasureIslandText(sock, jid, lesson.taskMessage);
    } catch (error) {
      console.error(`[LessonManager] Could not send Treasure Island exercise ${lesson.id} to ${jid}:`, error.message);
      await this.sendTreasureIslandText(
        sock,
        jid,
        `The video for "${lesson.title}" was sent, but I could not send its exercise. Please ask me to send Treasure Island again.`
      );
      return false;
    }
    const existing = this.getStudent(jid, phoneJid)?.treasureIsland || {};
    this.setTreasureIslandState(jid, phoneJid, {
      ...existing,
      activeLessonId: lesson.id,
      lastLessonId: lesson.id,
      status: 'awaiting_task',
      deliveredAt: new Date().toISOString(),
      pendingLessonSelection: false
    });
    console.log(`[LessonManager] Delivered Treasure Island ${lesson.title} video and exercise to ${jid} (${videoAbsolutePath}).`);
    return true;
  }

  async handleTreasureIslandTaskSubmission(sock, jid, text, pushName, phoneJid = null) {
    const state = this.getStudent(jid, phoneJid)?.treasureIsland;
    const lesson = this.getTreasureIslandLessons()
      .find(item => item.id === state?.activeLessonId);
    if (!lesson) return false;
    let result;
    try {
      result = await evaluateStudentTask(lesson, text, pushName);
    } catch (error) {
      console.error(`[LessonManager] Could not grade Treasure Island task from ${jid}:`, error.message);
      const gradingFailure = /[\u0600-\u06FF]/.test(text)
        ? 'ما قدرت أصحح إجابتك هسي بسبب مشكلة فنية. إجابتك ما اتسجلت كغلط؛ أرسلها تاني بعد شوية.'
        : 'I could not mark your answers because of a temporary technical issue. They were not marked wrong; please send them again later.';
      await sendHumanizedMessage(
        sock,
        jid,
        gradingFailure,
        config.typingWordsPerMinute
      );
      return true;
    }
    if (!result.isTaskSubmission) return false;
    await sendHumanizedMessage(sock, jid, result.feedback, config.typingWordsPerMinute);
    this.recordTreasureIslandMessage(jid, result.feedback);
    const updates = { status: result.allCorrect ? 'completed' : 'awaiting_reattempt' };
    if (result.allCorrect) {
      const completed = new Set(state.completedLessonIds || []);
      completed.add(lesson.id);
      updates.completedLessonIds = [...completed];
      updates.activeLessonId = null;
    }
    this.setTreasureIslandState(jid, phoneJid, updates);
    return true;
  }

  /**
   * Get the current lesson assigned to the student
   */
  getCurrentLesson(jid, phoneJid = null) {
    const student = this.getStudent(jid, phoneJid);
    if (!student || !this.lessonsConfig[student.grade]) return null;
    const lessons = this.lessonsConfig[student.grade].lessons || [];
    return lessons[student.currentLessonIndex] || null;
  }

  getWelcomeSampleLesson(gradeKey) {
    const lesson = this.lessonsConfig[gradeKey]?.lessons?.[0];
    if (!lesson?.videoFile || typeof lesson.taskMessage !== 'string' || !lesson.taskMessage.trim() ||
        !Array.isArray(lesson.answerKey) || lesson.answerKey.length === 0) {
      return null;
    }
    const videoPath = resolveLessonVideoPath(lesson.videoFile);
    let stats;
    try {
      stats = fs.statSync(videoPath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return stats.isFile() && stats.size > 0 ? lesson : null;
  }

  getLessonVideoNumbers(gradeKey) {
    const videoDirectory = path.join(APP_DIR, 'media', 'lessons', gradeKey);
    let files;
    try {
      files = fs.readdirSync(videoDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return files
      .filter(entry => entry.isFile())
      .map(entry => {
        const match = /^lesson_(\d+)\.mp4$/i.exec(entry.name);
        if (!match) return null;
        const stats = fs.statSync(path.join(videoDirectory, entry.name));
        return stats.size > 0 ? Number(match[1]) : null;
      })
      .filter(Number.isInteger)
      .sort((left, right) => left - right);
  }

  getNextSequentialLesson(gradeKey, currentLessonId) {
    const currentNumber = /^lesson_(\d+)$/.exec(currentLessonId || '');
    if (!currentNumber) {
      throw new Error(`Cannot determine lesson order from "${currentLessonId}".`);
    }
    const nextNumber = Number(currentNumber[1]) + 1;
    const lessons = this.lessonsConfig[gradeKey]?.lessons || [];
    const lessonIndex = lessons.findIndex(lesson => {
      if (lesson.id !== `lesson_${nextNumber}` ||
          typeof lesson.taskMessage !== 'string' || !lesson.taskMessage.trim() ||
          !Array.isArray(lesson.answerKey) || lesson.answerKey.length === 0 ||
          typeof lesson.videoFile !== 'string') {
        return false;
      }
      try {
        const stats = fs.statSync(resolveLessonVideoPath(lesson.videoFile));
        return stats.isFile() && stats.size > 0;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    });
    if (lessonIndex >= 0) return { status: 'ready', lessonIndex };

    const laterVideoExists = this.getLessonVideoNumbers(gradeKey)
      .some(number => number >= nextNumber);
    return { status: laterVideoExists ? 'awaiting_content' : 'completed' };
  }

  isLessonVideoRequest(text) {
    if (typeof text !== 'string') return false;
    const normalized = text
      .toLowerCase()
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[?!.,،؛]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const mentionsVideo = /\b(?:video|clip)s?\b|فيديو|مقطع|كليب/.test(normalized);
    const requestsVideo = /\b(send|resend|share|forward|show|again|didn'?t\s+get|not\s+received|where|missing)\b|ارسل|رسل|ابعث|ابعت|وريني|اديني|اعيد|عايز|داير|اريد|ممكن|تاني|مرة|مره|ما\s*(?:وصل|جاني|فتح|ظهر)|وين/.test(normalized);
    return mentionsVideo && requestsVideo;
  }

  isLessonTaskRequest(text) {
    if (typeof text !== 'string') return false;
    const normalized = text
      .toLowerCase()
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[?!.,،؛]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const mentionsTask = /\b(?:task|exercise|exercises|homework|questions?)\b/.test(normalized) ||
      /(?:تمرين|تمارين|واجب|الواجب|اسئلة|الاسئلة)/.test(normalized);
    const requestsAgain = /\b(?:send|resend|repeat|again|forward|share|didn'?t\s+get|did\s+not\s+get|not\s+received|missing|lost)\b/.test(normalized) ||
      /(?:ارسل|رسل|ابعث|ابعت|اعيد|تاني|مرة|مره|ما\s*(?:وصل|جاني|استلمت)|ما وصلني|فاتني|ضاعت)/.test(normalized);
    return mentionsTask && requestsAgain;
  }

  isLessonDeliveryRequest(text) {
    if (typeof text !== 'string') return false;
    const normalized = text
      .toLowerCase()
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[?!.,،؛]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return (
      /\b(?:send|share|start|begin|get|have|receive|watch)\b.{0,40}\b(?:the\s+)?(?:lessons?|videos?|classes?)\b/i.test(normalized) ||
      /\b(?:lessons?|videos?|classes?)\b.{0,30}\b(?:send|share|get|have|receive|watch|now)\b/i.test(normalized) ||
      /(?:ارسل|رسل|ابعث|ابعت|ممكن|داير|دايرة|دايره|عايز|عايزة|عايزه|عاوز|عاوزة|عاوزه|اريد|حابب|حابة|حابه|نفسي).{0,40}(?:درس|دروس|فيديو|حصة|حصه)/i.test(normalized) ||
      /(?:يلا|اي|ااي)\s*(?:نبدا|ابدا)/i.test(normalized) ||
      /(?:نبدا|ابدا)\s*(?:هسي|الان|طوالي)/i.test(normalized)
    );
  }

  async resendCurrentLessonVideo(sock, jid, phoneJid = null) {
    this.refreshLessonsConfig();
    const student = this.getStudent(jid, phoneJid);
    const treasureState = student?.treasureIsland;
    const treasureLessonId = ['awaiting_task', 'awaiting_reattempt'].includes(treasureState?.status)
      ? treasureState.activeLessonId
      : null;
    const treasureLesson = this.lessonsConfig.grade_3_secondary?.collections?.treasure_island?.lessons
      ?.find(item => item.id === treasureLessonId);
    if (treasureLesson) {
      let video;
      try {
        ({ video } = readLessonVideo(treasureLesson));
      } catch (error) {
        console.error(`[LessonManager] Cannot resend Treasure Island video for ${treasureLesson.id}:`, error.message);
        await this.sendTreasureIslandText(
          sock, jid, `The video for "${treasureLesson.title}" is currently unavailable.`
        );
        return true;
      }
      await sock.sendMessage(jid, {
        video,
        caption: treasureLesson.caption || treasureLesson.title,
        mimetype: 'video/mp4'
      }, undefined, {
        retry: { gradeKey: 'grade_3_secondary', lessonId: treasureLesson.id, collectionId: 'treasure_island' }
      });
      this.recordTreasureIslandMessage(jid, `🎬 [فيديو: ${treasureLesson.title}]\n${treasureLesson.caption || ''}`);
      return true;
    }

    let lesson = this.getCurrentLesson(jid, phoneJid);
    if (!lesson && treasureState?.lastLessonId) {
      lesson = this.lessonsConfig.grade_3_secondary?.collections?.treasure_island?.lessons
        ?.find(item => item.id === treasureState.lastLessonId) || null;
      if (lesson) {
        const { video } = readLessonVideo(lesson);
        await sock.sendMessage(jid, {
          video,
          caption: lesson.caption || lesson.title,
          mimetype: 'video/mp4'
        }, undefined, {
          retry: { gradeKey: 'grade_3_secondary', lessonId: lesson.id, collectionId: 'treasure_island' }
        });
        this.recordTreasureIslandMessage(jid, `🎬 [فيديو: ${lesson.title}]\n${lesson.caption || ''}`);
        return true;
      }
    }
    if (!lesson && student?.grade) {
      lesson = this.lessonsConfig[student.grade]?.lessons?.[0] || null;
    }
    if (!lesson) return false;

    let video;
    try {
      ({ video } = readLessonVideo(lesson));
    } catch (error) {
      console.error(`[LessonManager] Cannot resend video for ${lesson.id}:`, error.message);
      await sock.sendMessage(jid, {
        text: `ما قدرت أرسل فيديو "${lesson.title}" لأن ملف الفيديو غير متوفر أو فيه مشكلة.`
      });
      return true;
    }

    console.log(`[LessonManager] Resending ${lesson.title} video to ${jid}...`);
    const gradeKey = Object.entries(this.lessonsConfig).find(([key, grade]) =>
      key === student?.grade &&
      [grade.lessons, grade.standaloneLessons].some(collection => collection?.includes(lesson)))?.[0];
    await sock.sendMessage(jid, {
      video,
      caption: lesson.caption || lesson.title,
      mimetype: 'video/mp4'
    }, undefined, gradeKey
      ? { retry: { gradeKey, lessonId: lesson.id } }
      : {});
    try {
      historyManager.addMessage(jid, 'agent', `🎬 [فيديو: ${lesson.title}]\n${lesson.caption || ''}`);
    } catch (e) {}
    return true;
  }

  async resendCurrentLessonTask(sock, jid, phoneJid = null) {
    this.refreshLessonsConfig();
    const student = this.getStudent(jid, phoneJid);
    const treasureState = student?.treasureIsland;
    const treasureLessonId = treasureState?.activeLessonId || treasureState?.lastLessonId;
    const treasureLesson = this.lessonsConfig.grade_3_secondary?.collections?.treasure_island?.lessons
      ?.find(item => item.id === treasureLessonId);
    if (treasureLesson) {
      if (!treasureLesson.taskMessage?.trim()) {
        await this.sendTreasureIslandText(sock, jid, 'The exercise for this chapter is not configured.');
        return true;
      }
      await this.sendTreasureIslandText(sock, jid, treasureLesson.taskMessage);
      return true;
    }

    let lesson = this.getCurrentLesson(jid, phoneJid);
    if (!lesson && student?.grade && Number.isInteger(student.currentLessonIndex)) {
      lesson = this.lessonsConfig[student.grade]?.lessons?.[student.currentLessonIndex] || null;
    }
    if (!lesson && student?.grade && student.currentLessonId) {
      lesson = this.lessonsConfig[student.grade]?.lessons
        ?.find(item => item.id === student.currentLessonId) || null;
    }
    if (!lesson?.taskMessage?.trim()) {
      const message = /[\u0600-\u06FF]/.test(
        [...(historyManager.history[jid] || [])].reverse()
          .find(item => item.role === 'client')?.text || ''
      )
        ? 'ما لقيت تمرين حالي أرسله ليك. أرسل لي صفك أو اطلب فيديو الدرس أول.'
        : 'I could not find a current exercise to resend. Tell me your grade or ask for the lesson video first.';
      await sock.sendMessage(jid, { text: message });
      return false;
    }

    await sock.sendMessage(jid, { text: lesson.taskMessage });
    try {
      historyManager.addMessage(jid, 'agent', lesson.taskMessage);
    } catch (error) {
      console.error('[LessonManager] Could not record the resent lesson exercise:', error.message);
    }
    console.log(`[LessonManager] Resent ${lesson.id} task to ${jid}.`);
    return true;
  }

  async resendMediaActivity(sock, activity) {
    this.refreshLessonsConfig();
    const retry = findLessonForMediaActivity(activity, this.lessonsConfig);
    if (!retry) {
      throw new Error('The original lesson video could not be identified for this failed upload.');
    }
    const grade = this.lessonsConfig[retry.gradeKey];
    const lessonCollection = retry.collectionId
      ? grade.collections?.[retry.collectionId]?.lessons || []
      : [...(grade.lessons || []), ...(grade.standaloneLessons || [])];
    const lesson = lessonCollection
      .find(item => item.id === retry.lessonId && item.videoFile === retry.videoFile);
    if (!lesson) {
      throw new Error(`Lesson ${retry.lessonId} is no longer available.`);
    }
    const { video } = readLessonVideo(lesson);
    await sock.sendMessage(activity.recipientJid, {
      video,
      caption: lesson.caption || lesson.title,
      mimetype: 'video/mp4'
    }, undefined, {
      activityId: activity.id,
      retry: {
        gradeKey: retry.gradeKey,
        lessonId: retry.lessonId,
        ...(retry.collectionId ? { collectionId: retry.collectionId } : {})
      }
    });
    try {
      historyManager.addMessage(activity.recipientJid, 'agent', `🎬 [فيديو: ${lesson.title}]\n${lesson.caption || ''}`);
    } catch (error) {
      console.error('[LessonManager] Could not record resent video in chat history:', error.message);
    }
  }

  /**
   * Send the video lesson and respective task to the student via WhatsApp
   */
  async deliverLesson(
    sock,
    jid,
    gradeKey,
    lessonIndex = 0,
    phoneJid = null,
    { bypassDailyLimit = false, includeIntro = true } = {}
  ) {
    const gradeData = this.lessonsConfig[gradeKey];
    if (!gradeData || !gradeData.lessons || !gradeData.lessons[lessonIndex]) {
      return false;
    }

    const lesson = gradeData.lessons[lessonIndex];
    if (!bypassDailyLimit && !await this.canDeliverLessonToday(sock, jid, phoneJid)) return false;
    let video;
    let videoAbsolutePath;
    try {
      ({ video, videoAbsolutePath } = readLessonVideo(lesson));
    } catch (error) {
      console.error(`[LessonManager] Cannot deliver ${lesson.id} to ${jid}:`, error.message);
      await sock.sendMessage(jid, {
        text: `ما قدرت أرسل فيديو الحصة "${lesson.title}" فعلياً بسبب مشكلة في ملف الفيديو. ما حأرسل التمرين كأن الفيديو وصل.`
      });
      return false;
    }

    console.log(`[LessonManager] Delivering ${lesson.title} to ${jid}...`);

    // Lesson text is prewritten, so send it immediately instead of simulating
    // typing for long messages.
    if (includeIntro && lesson.introMessage) {
      await sock.sendMessage(jid, { text: lesson.introMessage });
      try { historyManager.addMessage(jid, 'agent', lesson.introMessage); } catch (e) {}
    }

    // Do not send the exercise or mark progress unless the video upload succeeds.
    try {
      console.log(`[LessonManager] Uploading video file: ${videoAbsolutePath} (${video.byteLength} bytes)`);
      await sock.sendMessage(jid, {
        video,
        caption: lesson.caption || lesson.title,
        mimetype: 'video/mp4'
      }, undefined, { retry: { gradeKey, lessonId: lesson.id } });
      try {
        historyManager.addMessage(jid, 'agent', `🎬 [فيديو: ${lesson.title}]\n${lesson.caption || ''}`);
      } catch (e) {}
      await new Promise(r => setTimeout(r, 2500));
    } catch (error) {
      console.error(`[LessonManager] Video upload failed for ${lesson.id} to ${jid}:`, error.message);
      await sock.sendMessage(jid, {
        text: `ما وصل فيديو الحصة "${lesson.title}" بسبب فشل الإرسال. ما حأرسل التمرين لحد ما يوصل الفيديو فعلياً.`
      });
      return false;
    }

    // Send the exercise immediately after the video upload succeeds.
    if (lesson.taskMessage) {
      await sock.sendMessage(jid, { text: lesson.taskMessage });
      try { historyManager.addMessage(jid, 'agent', lesson.taskMessage); } catch (e) {}
    }

    // 4. Update student progress state
    const progressEntry = {
      grade: gradeKey,
      currentLessonIndex: lessonIndex,
      currentLessonId: lesson.id,
      status: 'awaiting_task',
      deliveredAt: new Date().toISOString()
    };
    this.progress[jid] = progressEntry;
    if (phoneJid && phoneJid !== jid) {
      this.progress[phoneJid] = progressEntry;
    }
    this.saveProgress();

    return true;
  }

  getLatestLessonDeliveryAt(jid, phoneJid = null) {
    const student = this.getStudent(jid, phoneJid);
    const deliveryTimes = [
      student?.deliveredAt,
      student?.treasureIsland?.deliveredAt
    ].map(value => Date.parse(value || '')).filter(Number.isFinite);
    return deliveryTimes.length ? Math.max(...deliveryTimes) : null;
  }

  async canDeliverLessonToday(sock, jid, phoneJid = null) {
    const lastDeliveryAt = this.getLatestLessonDeliveryAt(jid, phoneJid);
    if (lastDeliveryAt !== null && Date.now() - lastDeliveryAt < DAILY_LESSON_INTERVAL_MS) {
      const lastClientMessage = [...(historyManager.history[jid] || [])]
        .reverse()
        .find(message => message.role === 'client')?.text || '';
      const response = /[\u0600-\u06FF]/.test(lastClientMessage)
        ? 'إنت استلمت حصة خلال آخر ٢٤ ساعة. الحصة الجاية حتوصلك بعد ما تكمل المدة اليومية.'
        : 'You already received a lesson in the last 24 hours. Your next lesson will arrive when the daily interval has passed.';
      await sock.sendMessage(jid, {
        text: response
      });
      return false;
    }
    return true;
  }

  /**
   * Evaluates student's task submission, provides feedback, and handles progression
   * @returns {Promise<boolean>} true if message was processed as a task submission, false otherwise
   */
  async handleTaskSubmission(sock, jid, text, pushName, phoneJid = null) {
    const currentLesson = this.getCurrentLesson(jid, phoneJid);
    if (!currentLesson) return false;
    const student = this.getStudent(jid, phoneJid);
    if (!['awaiting_task', 'awaiting_reattempt', 'awaiting_next_lesson_schedule'].includes(student?.status)) return false;

    console.log(`[LessonManager] Evaluating task submission from ${pushName} for ${currentLesson.id}...`);

    let evalResult;
    try {
      evalResult = await evaluateStudentTask(currentLesson, text, pushName);
    } catch (error) {
      console.error(`[LessonManager] Could not grade task submission from ${jid}:`, error.message);
      const gradingFailure = /[\u0600-\u06FF]/.test(text)
        ? 'ما قدرت أصحح إجابتك هسي بسبب مشكلة فنية. إجابتك ما اتسجلت كغلط؛ أرسلها تاني بعد شوية.'
        : 'I could not mark your answers because of a temporary technical issue. They were not marked wrong; please send them again later.';
      await sendHumanizedMessage(
        sock,
        jid,
        gradingFailure,
        config.typingWordsPerMinute
      );
      return true;
    }

    // If student was just asking a normal question or chatting, do not intercept
    if (!evalResult.isTaskSubmission) {
      return false;
    }

    console.log(`[Task Evaluated] Student: ${pushName} | Passed: ${evalResult.allCorrect}`);

    const currentLessonId = currentLesson.id ||
      this.lessonsConfig[student.grade]?.lessons?.[student.currentLessonIndex]?.id;
    const nextLesson = evalResult.allCorrect
      ? this.getNextSequentialLesson(student.grade, currentLessonId)
      : null;
    const feedback = nextLesson?.status === 'ready'
      ? (/[\u0600-\u06FF]/.test(text) ? 'صحيح.' : 'Correct.')
      : evalResult.feedback;

    await sendHumanizedMessage(sock, jid, feedback, config.typingWordsPerMinute);
    try { historyManager.addMessage(jid, 'agent', feedback); } catch (e) {}

    if (evalResult.allCorrect) {
      // Student PASSED this lesson! Advance to next lesson
      if (nextLesson.status === 'ready') {
        const nextIndex = nextLesson.lessonIndex;
        const nextLessonConfig = this.lessonsConfig[student.grade].lessons[nextIndex];
        student.status = 'awaiting_content';
        this.saveProgress();
        console.log(`[LessonManager] Advancing ${pushName} to ${nextLessonConfig.id} immediately...`);
        await this.deliverLesson(sock, jid, student.grade, nextIndex, phoneJid, {
          bypassDailyLimit: true,
          includeIntro: false
        });
      } else if (nextLesson.status === 'awaiting_content') {
        student.status = 'awaiting_content';
        this.saveProgress();
        console.log(`[LessonManager] ${pushName} completed ${currentLessonId}; the next numbered video exists but its exercise is not configured yet.`);
      } else {
        student.status = 'completed';
        this.saveProgress();
        console.log(`[LessonManager 🎓] Student ${pushName} completed all lessons for ${student.grade}!`);
      }
    } else {
      // Student has incorrect answers -> update status to awaiting reattempt
      student.status = 'awaiting_reattempt';
      this.saveProgress();
    }

    return true;
  }
}

export const lessonManager = new LessonManager();
