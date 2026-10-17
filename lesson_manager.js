import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { evaluateStudentTask } from './task_evaluator.js';
import { sendHumanizedMessage } from './humanization.js';
import { historyManager } from './history.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve('data');
const PROGRESS_FILE = path.join(DATA_DIR, 'student_progress.json');
const LESSONS_FILE = path.resolve('lessons.json');

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
      return true;
    } catch (err) {
      console.error('[LessonManager] Save lessons error:', err.message);
      return false;
    }
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
    return student.status === 'awaiting_task' || student.status === 'awaiting_reattempt';
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
    const student = this.getStudent(jid, phoneJid);
    let lesson = this.getCurrentLesson(jid, phoneJid);
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
    await sock.sendMessage(jid, {
      video,
      caption: lesson.caption || lesson.title,
      mimetype: 'video/mp4'
    });
    try {
      historyManager.addMessage(jid, 'agent', `🎬 [فيديو: ${lesson.title}]\n${lesson.caption || ''}`);
    } catch (e) {}
    return true;
  }

  /**
   * Send the video lesson and respective task to the student via WhatsApp
   */
  async deliverLesson(sock, jid, gradeKey, lessonIndex = 0, phoneJid = null) {
    const gradeData = this.lessonsConfig[gradeKey];
    if (!gradeData || !gradeData.lessons || !gradeData.lessons[lessonIndex]) {
      return false;
    }

    const lesson = gradeData.lessons[lessonIndex];
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

    // 1. Send Intro message
    if (lesson.introMessage) {
      await sendHumanizedMessage(sock, jid, lesson.introMessage, config.typingWordsPerMinute);
      try { historyManager.addMessage(jid, 'agent', lesson.introMessage); } catch (e) {}
    }

    // Do not send the exercise or mark progress unless the video upload succeeds.
    try {
      console.log(`[LessonManager] Uploading video file: ${videoAbsolutePath} (${video.byteLength} bytes)`);
      await sock.sendMessage(jid, {
        video,
        caption: lesson.caption || lesson.title,
        mimetype: 'video/mp4'
      });
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

    // 3. Send the Task / Exercise message
    if (lesson.taskMessage) {
      await sendHumanizedMessage(sock, jid, lesson.taskMessage, config.typingWordsPerMinute);
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

  /**
   * Evaluates student's task submission, provides feedback, and handles progression
   * @returns {Promise<boolean>} true if message was processed as a task submission, false otherwise
   */
  async handleTaskSubmission(sock, jid, text, pushName, phoneJid = null) {
    const currentLesson = this.getCurrentLesson(jid, phoneJid);
    if (!currentLesson) return false;

    console.log(`[LessonManager] Evaluating task submission from ${pushName} for ${currentLesson.id}...`);

    const evalResult = await evaluateStudentTask(currentLesson, text, pushName);

    // If student was just asking a normal question or chatting, do not intercept
    if (!evalResult.isTaskSubmission) {
      return false;
    }

    console.log(`[Task Evaluated] Student: ${pushName} | Passed: ${evalResult.allCorrect}`);

    // Send the teacher's pedagogical feedback
    await sendHumanizedMessage(sock, jid, evalResult.feedback, config.typingWordsPerMinute);
    try { historyManager.addMessage(jid, 'agent', evalResult.feedback); } catch (e) {}

    const student = this.getStudent(jid, phoneJid);

    if (evalResult.allCorrect) {
      // Student PASSED this lesson! Advance to next lesson
      const currentLessonId = currentLesson.id ||
        this.lessonsConfig[student.grade]?.lessons?.[student.currentLessonIndex]?.id;
      const nextLesson = this.getNextSequentialLesson(student.grade, currentLessonId);

      if (nextLesson.status === 'ready') {
        const nextIndex = nextLesson.lessonIndex;
        const nextLessonConfig = this.lessonsConfig[student.grade].lessons[nextIndex];
        console.log(`[LessonManager] Advancing ${pushName} to ${nextLessonConfig.id}...`);
        // Wait 3 seconds then deliver next lesson
        setTimeout(() => {
          this.deliverLesson(sock, jid, student.grade, nextIndex, phoneJid).catch(error => {
            console.error(`[LessonManager] Failed to deliver ${nextLessonConfig.id} to ${jid}:`, error.message);
          });
        }, 3000);
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
