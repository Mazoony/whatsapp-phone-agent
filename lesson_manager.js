import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { evaluateStudentTask } from './task_evaluator.js';
import { sendHumanizedMessage } from './humanization.js';

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

function normalizeLessonConsentMessage(message) {
  return message
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[?!.,،؛]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLessonPermissionQuestion(message) {
  return typeof message === 'string' &&
    /\b(?:may|can|could)\s+i\s+send\b.{0,60}\blessons?\b/i.test(message);
}

export function isLessonDeliveryDecline(message, previousAgentMessage = '') {
  if (typeof message !== 'string' || !isLessonPermissionQuestion(previousAgentMessage)) return false;
  const normalized = normalizeLessonConsentMessage(message);
  return /^(?:no|not yet|later|maybe later|لا|ما هسي|بعدين|لاحقا)(?:\b|\s|$)/i.test(normalized) ||
    /\b(?:not yet|not now|later)\b|بعدين|لاحقا/i.test(normalized);
}

export function hasLessonDeliveryConsent(message, previousAgentMessage = '') {
  if (typeof message !== 'string' || !isLessonPermissionQuestion(previousAgentMessage)) return false;
  const normalized = normalizeLessonConsentMessage(message);
  if (isLessonDeliveryDecline(message, previousAgentMessage)) return false;

  return /\b(?:yes|yeah|yep|sure|okay|ok|go ahead|send it|please do|i agree)\b|ايوة|ايوه|ايوا|نعم|تمام|موافق|ماشي|مافي مشكلة/i.test(normalized);
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
      .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632))
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedText = normalize(text);

    for (const [gradeKey, data] of Object.entries(this.lessonsConfig)) {
      for (const keyword of data.keywords) {
        if (normalizedText.includes(normalize(keyword))) {
          return gradeKey;
        }
      }
    }
    return null;
  }

  getStudent(jid) {
    return this.progress[jid] || null;
  }

  setStudentGrade(jid, gradeKey) {
    if (!this.progress[jid]) {
      this.progress[jid] = {
        grade: gradeKey,
        currentLessonIndex: 0,
        status: 'consulting'
      };
    } else {
      this.progress[jid].grade = gradeKey;
    }
    this.saveProgress();
  }

  /**
   * Check if student has an active lesson they need to submit homework for
   */
  hasActiveLesson(jid) {
    const student = this.getStudent(jid);
    if (!student) return false;
    return student.status === 'awaiting_task' || student.status === 'awaiting_reattempt';
  }

  /**
   * Get the current lesson assigned to the student
   */
  getCurrentLesson(jid) {
    const student = this.getStudent(jid);
    if (!student || !this.lessonsConfig[student.grade]) return null;
    const lessons = this.lessonsConfig[student.grade].lessons || [];
    return lessons[student.currentLessonIndex] || null;
  }

  isLessonVideoRequest(text) {
    if (typeof text !== 'string') return false;
    const normalized = text
      .toLowerCase()
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[?!.,،؛]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const mentionsVideo = /\bvideo\b|\bclip\b|فيديو|مقطع|كليب/.test(normalized);
    const requestsVideo = /\b(send|resend|share|forward|show|again)\b|ارسل|رسل|ابعث|ابعت|وريني|اديني|اعيد|عايز|داير|اريد|ممكن|تاني|مرة/.test(normalized);
    return mentionsVideo && requestsVideo;
  }

  isLessonDeliveryRequest(text) {
    if (typeof text !== 'string') return false;
    const normalized = text
      .toLowerCase()
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[?!.,،؛]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return (
      /\b(?:send|share|start|begin)\b.{0,40}\b(?:the\s+)?(?:lesson|lessons|class|video)\b/i.test(normalized) ||
      /\b(?:lesson|lessons|class|video)\b.{0,30}\b(?:send|share|now)\b/i.test(normalized) ||
      /(?:ارسل|رسل|ابعث|ابعت|داير|عايز|عاوز|اريد).{0,30}(?:درس|دروس|فيديو|حصة)/i.test(normalized)
    );
  }

  async resendCurrentLessonVideo(sock, jid) {
    const lesson = this.getCurrentLesson(jid);
    if (!lesson) return false;

    const videoAbsolutePath = typeof lesson.videoFile === 'string' && lesson.videoFile.trim()
      ? resolveLessonVideoPath(lesson.videoFile)
      : null;
    if (!videoAbsolutePath || !fs.existsSync(videoAbsolutePath)) {
      console.error(`[LessonManager] Cannot resend video for ${lesson.id}; file is missing: ${lesson.videoFile || '(not configured)'}`);
      await sock.sendMessage(jid, {
        text: `ما قدرت أرسل فيديو "${lesson.title}" لأن ملف الفيديو غير موجود عندي.`
      });
      return true;
    }

    console.log(`[LessonManager] Resending ${lesson.title} video to ${jid}...`);
    const video = fs.readFileSync(videoAbsolutePath);
    await sock.sendMessage(jid, {
      video,
      caption: lesson.caption || lesson.title,
      mimetype: 'video/mp4'
    });
    return true;
  }

  /**
   * Send the video lesson and respective task to the student via WhatsApp
   */
  async deliverLesson(sock, jid, gradeKey, lessonIndex = 0) {
    const gradeData = this.lessonsConfig[gradeKey];
    if (!gradeData || !gradeData.lessons || !gradeData.lessons[lessonIndex]) {
      return false;
    }

    const lesson = gradeData.lessons[lessonIndex];
    const videoAbsolutePath = resolveLessonVideoPath(lesson.videoFile);

    console.log(`[LessonManager] Delivering ${lesson.title} to ${jid}...`);

    // 1. Send Intro message
    if (lesson.introMessage) {
      await sendHumanizedMessage(sock, jid, lesson.introMessage, config.typingWordsPerMinute);
    }

    // 2. Send the Video itself if the file exists
    if (fs.existsSync(videoAbsolutePath)) {
      console.log(`[LessonManager] Uploading video file: ${videoAbsolutePath}`);
      const video = fs.readFileSync(videoAbsolutePath);
      await sock.sendMessage(jid, {
        video,
        caption: lesson.caption || lesson.title,
        mimetype: 'video/mp4'
      });
      await new Promise(r => setTimeout(r, 2500));
    } else {
      console.warn(`[LessonManager ⚠️] Video file not found at: ${videoAbsolutePath}`);
      console.warn(`[LessonManager] Please place the video file in: ${lesson.videoFile}`);
      await sendHumanizedMessage(
        sock,
        jid,
        `*(ملاحظة من مستر مازن: فيديو "${lesson.title}" قيد الرفع للمحادثة)*`,
        config.typingWordsPerMinute
      );
    }

    // 3. Send the Task / Exercise message
    if (lesson.taskMessage) {
      await sendHumanizedMessage(sock, jid, lesson.taskMessage, config.typingWordsPerMinute);
    }

    // 4. Update student progress state
    this.progress[jid] = {
      grade: gradeKey,
      currentLessonIndex: lessonIndex,
      currentLessonId: lesson.id,
      status: 'awaiting_task',
      deliveredAt: new Date().toISOString()
    };
    this.saveProgress();

    return true;
  }

  /**
   * Evaluates student's task submission, provides feedback, and handles progression
   * @returns {Promise<boolean>} true if message was processed as a task submission, false otherwise
   */
  async handleTaskSubmission(sock, jid, text, pushName) {
    const currentLesson = this.getCurrentLesson(jid);
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

    const student = this.progress[jid];

    if (evalResult.allCorrect) {
      // Student PASSED this lesson! Advance to next lesson
      const nextIndex = student.currentLessonIndex + 1;
      const gradeData = this.lessonsConfig[student.grade];

      if (gradeData && gradeData.lessons && gradeData.lessons[nextIndex]) {
        console.log(`[LessonManager] Advancing ${pushName} to Lesson Index ${nextIndex}...`);
        // Wait 3 seconds then deliver next lesson
        setTimeout(() => {
          this.deliverLesson(sock, jid, student.grade, nextIndex).catch(error => {
            console.error(`[LessonManager] Failed to deliver ${gradeData.lessons[nextIndex].id} to ${jid}:`, error.message);
          });
        }, 3000);
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
