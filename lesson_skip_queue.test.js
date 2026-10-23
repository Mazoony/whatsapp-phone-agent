import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deliverWhatsAppLessonSkipRequest,
  LessonSkipQueue
} from './lesson_skip_queue.js';

test('lesson skip queue claims, recovers, deduplicates, and completes requests', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-skip-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queue = new LessonSkipQueue(path.join(directory, 'requests.json'));
  const details = {
    platform: 'Telegram',
    studentKey: 'telegram:-100123:44',
    currentLessonId: 'lesson_1',
    nextLessonId: 'lesson_2'
  };

  const created = queue.enqueue(details);
  assert.equal(created.request.status, 'queued');
  assert.equal(created.alreadyQueued, false);
  const claimed = queue.claimNext();
  assert.equal(claimed.id, created.request.id);
  assert.equal(claimed.status, 'processing');

  const duplicate = queue.enqueue(details);
  assert.equal(duplicate.alreadyQueued, true);
  assert.equal(duplicate.request.id, created.request.id);
  assert.equal(queue.recoverProcessing(), 1);
  assert.equal(queue.claimNext().status, 'processing');

  const completed = queue.complete(created.request.id, 'sent');
  assert.equal(completed.status, 'sent');
  assert.equal(completed.error, null);
  assert.equal(queue.claimNext(), null);
  assert.equal(queue.latestForStudent(details.studentKey).status, 'sent');
});

test('lesson skip queue rejects malformed queue state and incomplete requests', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-skip-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queueFile = path.join(directory, 'requests.json');
  const queue = new LessonSkipQueue(queueFile);

  assert.throws(() => queue.enqueue({ studentKey: 'student' }), /IDs are required/);
  fs.writeFileSync(queueFile, '{"not":"an array"}', 'utf8');
  assert.throws(() => queue.read(), /Invalid lesson skip request queue/);
});

test('WhatsApp lesson skips deliver the requested next lesson and reject stale progress', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-lesson-skip-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queue = new LessonSkipQueue(path.join(directory, 'requests.json'));
  const student = {
    grade: 'grade_3_secondary',
    currentLessonId: 'lesson_1',
    status: 'awaiting_reattempt'
  };
  const lessonManager = {
    lessonsConfig: {
      grade_3_secondary: {
        lessons: [{ id: 'lesson_1' }, { id: 'lesson_2', title: 'Lesson Two' }]
      }
    },
    refreshLessonsConfig() {},
    getStudent: () => student,
    getNextSequentialLesson: () => ({ status: 'ready', lessonIndex: 1 }),
    deliverLesson: async (...args) => {
      assert.equal(args[0], 'socket');
      assert.equal(args[1], '1001@s.whatsapp.net');
      assert.equal(args[2], 'grade_3_secondary');
      assert.equal(args[3], 1);
      assert.equal(args[4], '1001@s.whatsapp.net');
      assert.deepEqual(args[5], { bypassDailyLimit: true, includeIntro: false });
      student.currentLessonId = 'lesson_2';
      return true;
    }
  };
  const logger = { log() {}, error() {} };
  const request = queue.enqueue({
    studentKey: '1001@s.whatsapp.net',
    jid: '1001@s.whatsapp.net',
    phoneJid: '1001@s.whatsapp.net',
    gradeKey: 'grade_3_secondary',
    currentLessonId: 'lesson_1',
    nextLessonId: 'lesson_2'
  }).request;
  assert.equal(await deliverWhatsAppLessonSkipRequest({
    request: queue.claimNext(),
    sock: 'socket',
    lessonManager,
    queue,
    logger
  }), true);
  assert.equal(queue.latestForStudent('1001@s.whatsapp.net').status, 'sent');

  const staleRequest = queue.enqueue({
    studentKey: '1001@s.whatsapp.net',
    jid: '1001@s.whatsapp.net',
    phoneJid: '1001@s.whatsapp.net',
    gradeKey: 'grade_3_secondary',
    currentLessonId: 'lesson_1',
    nextLessonId: 'lesson_2'
  }).request;
  assert.equal(await deliverWhatsAppLessonSkipRequest({
    request: queue.claimNext(),
    sock: 'socket',
    lessonManager,
    queue,
    logger
  }), false);
  assert.equal(queue.read().find(item => item.id === staleRequest.id).status, 'failed');
});
