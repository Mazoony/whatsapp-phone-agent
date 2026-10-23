import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(APP_DIR, 'data');
export const WHATSAPP_LESSON_SKIP_REQUESTS_FILE = path.join(DATA_DIR, 'whatsapp_lesson_skip_requests.json');
export const TELEGRAM_LESSON_SKIP_REQUESTS_FILE = path.join(DATA_DIR, 'telegram_lesson_skip_requests.json');
const MAX_COMPLETED_REQUESTS = 100;

export class LessonSkipQueue {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('A lesson skip request queue path is required.');
    }
    this.filePath = filePath;
  }

  withLock(operation) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 5000;
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    let lockFd = null;
    while (lockFd === null) {
      try {
        lockFd = fs.openSync(lockPath, 'wx');
        fs.writeSync(lockFd, String(process.pid));
      } catch (error) {
        if (lockFd !== null) {
          fs.closeSync(lockFd);
          lockFd = null;
          try {
            fs.rmSync(lockPath, { force: true });
          } catch (cleanupError) {
            console.error('[Lesson Skip] Could not clean a partial queue lock:', cleanupError.message);
          }
        }
        if (error.code !== 'EEXIST') throw error;
        let lockPid = null;
        try {
          const value = fs.readFileSync(lockPath, 'utf8').trim();
          if (/^\d+$/.test(value)) lockPid = Number(value);
        } catch (readError) {
          if (readError.code !== 'ENOENT') throw readError;
        }
        if (lockPid !== null) {
          try {
            process.kill(lockPid, 0);
          } catch (processError) {
            if (processError.code === 'ESRCH') {
              fs.rmSync(lockPath, { force: true });
              continue;
            }
            if (processError.code !== 'EPERM') throw processError;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the lesson skip queue lock in ${this.filePath}.`);
        }
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }
    try {
      return operation();
    } finally {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
    }
  }

  read() {
    if (!fs.existsSync(this.filePath)) return [];
    const requests = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!Array.isArray(requests) || requests.some(request =>
      !request || typeof request !== 'object' ||
      typeof request.id !== 'string' ||
      typeof request.studentKey !== 'string' ||
      !['queued', 'processing', 'sent', 'failed'].includes(request.status))) {
      throw new Error(`Invalid lesson skip request queue in ${this.filePath}.`);
    }
    return requests;
  }

  write(requests) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(requests, null, 2), 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Lesson Skip] Could not clean a temporary queue file:', cleanupError.message);
      }
      throw error;
    }
  }

  enqueue(details) {
    if (!details || typeof details.studentKey !== 'string' ||
        typeof details.currentLessonId !== 'string' ||
        typeof details.nextLessonId !== 'string') {
      throw new Error('A student and current/next lesson IDs are required for a lesson skip.');
    }
    return this.withLock(() => {
      const requests = this.read();
      const existing = requests.find(request =>
        request.studentKey === details.studentKey &&
        request.currentLessonId === details.currentLessonId &&
        ['queued', 'processing'].includes(request.status));
      if (existing) return { request: existing, alreadyQueued: true };

      const request = {
        ...details,
        id: randomUUID(),
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null
      };
      requests.push(request);
      const active = requests.filter(item => ['queued', 'processing'].includes(item.status));
      const completed = requests.filter(item => !['queued', 'processing'].includes(item.status))
        .slice(-MAX_COMPLETED_REQUESTS);
      this.write([...completed, ...active]);
      return { request, alreadyQueued: false };
    });
  }

  claimNext(predicate = () => true) {
    if (typeof predicate !== 'function') {
      throw new TypeError('A lesson skip request selector must be a function.');
    }
    return this.withLock(() => {
      const requests = this.read();
      const request = requests.find(item => item.status === 'queued' && predicate(item));
      if (!request) return null;
      request.status = 'processing';
      request.updatedAt = new Date().toISOString();
      this.write(requests);
      return { ...request };
    });
  }

  complete(id, status, error = null) {
    if (!['sent', 'failed'].includes(status)) {
      throw new Error('A lesson skip request can only be completed as sent or failed.');
    }
    return this.withLock(() => {
      const requests = this.read();
      const request = requests.find(item => item.id === id);
      if (!request) throw new Error(`Lesson skip request ${id} was not found.`);
      request.status = status;
      request.updatedAt = new Date().toISOString();
      request.error = error ? String(error).slice(0, 500) : null;
      this.write(requests);
      return { ...request };
    });
  }

  recoverProcessing() {
    return this.withLock(() => {
      const requests = this.read();
      let recovered = 0;
      for (const request of requests) {
        if (request.status !== 'processing') continue;
        request.status = 'queued';
        request.updatedAt = new Date().toISOString();
        request.error = null;
        recovered += 1;
      }
      if (recovered) this.write(requests);
      return recovered;
    });
  }

  latestForStudent(studentKey) {
    return this.read().filter(request => request.studentKey === studentKey).at(-1) || null;
  }
}

export async function deliverWhatsAppLessonSkipRequest({
  request,
  sock,
  lessonManager,
  queue,
  logger = console
}) {
  try {
    lessonManager.refreshLessonsConfig();
    const student = lessonManager.getStudent(request.jid, request.phoneJid);
    if (!student ||
        student.currentLessonId !== request.currentLessonId ||
        student.grade !== request.gradeKey ||
        !['awaiting_task', 'awaiting_reattempt', 'awaiting_content', 'completed'].includes(student.status)) {
      queue.complete(
        request.id,
        'failed',
        'Student progress changed before the lesson skip could be delivered.'
      );
      logger.log(`[Lesson Skip] Discarded stale WhatsApp request ${request.id}.`);
      return false;
    }

    const next = lessonManager.getNextSequentialLesson(student.grade, student.currentLessonId);
    const nextLesson = next.status === 'ready'
      ? lessonManager.lessonsConfig[student.grade]?.lessons?.[next.lessonIndex]
      : null;
    if (!nextLesson || nextLesson.id !== request.nextLessonId) {
      queue.complete(
        request.id,
        'failed',
        'The configured next lesson changed or is no longer ready.'
      );
      logger.log(`[Lesson Skip] Could not find the requested next WhatsApp lesson for ${request.jid}.`);
      return false;
    }

    const delivered = await lessonManager.deliverLesson(
      sock,
      request.jid,
      student.grade,
      next.lessonIndex,
      request.phoneJid,
      { bypassDailyLimit: true, includeIntro: false }
    );
    if (!delivered) throw new Error('Lesson delivery did not complete successfully.');
    queue.complete(request.id, 'sent');
    logger.log(`[Lesson Skip] Delivered ${nextLesson.id} to ${request.jid}.`);
    return true;
  } catch (error) {
    queue.complete(request.id, 'failed', error.message);
    logger.error(`[Lesson Skip] Could not deliver a WhatsApp lesson skip to ${request.jid}:`, error.message);
    return false;
  }
}
