import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createScheduledLessonStore,
  formatScheduledDateTime,
  getNextDailyLessonTime,
  isLessonScheduleRequest,
  isRecurringLessonScheduleRequest,
  looksLikeScheduleDateTime,
  parseScheduledDateTime
} from './scheduled_lessons.js';

const now = new Date('2026-10-19T08:00:00.000Z');

test('daily lesson continuation is scheduled 24 hours after successful marking', () => {
  assert.equal(
    getNextDailyLessonTime(new Date('2026-10-19T08:00:00.000Z')),
    '2026-10-20T08:00:00.000Z'
  );
  assert.throws(() => getNextDailyLessonTime('not a date'), /reference time is invalid/);
});

test('detects English and Sudanese Arabic lesson scheduling requests', () => {
  assert.equal(isLessonScheduleRequest('Please send the lesson tomorrow at 5pm'), true);
  assert.equal(isLessonScheduleRequest('ارسل لي الحصة بكرة الساعة ٤ مساء'), true);
  assert.equal(isLessonScheduleRequest('Send the lesson now'), false);
  assert.equal(isRecurringLessonScheduleRequest('Send me the lesson every day at 5pm'), true);
  assert.equal(isRecurringLessonScheduleRequest('ارسل الحصة كل يوم الساعة ٥'), true);
  assert.equal(looksLikeScheduleDateTime('4:30 pm'), true);
  assert.equal(looksLikeScheduleDateTime('Can you explain this exercise?'), false);
});

test('parses explicit Sudan-local time and requires clarification when incomplete or ambiguous', () => {
  assert.deepEqual(parseScheduledDateTime('tomorrow at 5pm', now), {
    status: 'valid',
    scheduledAt: '2026-10-20T15:00:00.000Z'
  });
  assert.deepEqual(parseScheduledDateTime('بكرة الساعة ٤ مساء', now), {
    status: 'valid',
    scheduledAt: '2026-10-20T14:00:00.000Z'
  });
  assert.deepEqual(parseScheduledDateTime('tomorrow at 4:30 pm', now), {
    status: 'valid',
    scheduledAt: '2026-10-20T14:30:00.000Z'
  });
  assert.deepEqual(parseScheduledDateTime('Thursday at 6:30 pm', now), {
    status: 'valid',
    scheduledAt: '2026-10-22T16:30:00.000Z'
  });
  assert.deepEqual(parseScheduledDateTime('tomorrow at 5', now), {
    status: 'ambiguous',
    reason: 'am_pm',
    missing: []
  });
  assert.deepEqual(parseScheduledDateTime('at 5', now), {
    status: 'ambiguous',
    reason: 'am_pm',
    missing: ['date']
  });
  assert.deepEqual(parseScheduledDateTime('tomorrow', now), {
    status: 'incomplete',
    missing: ['time']
  });
  assert.deepEqual(parseScheduledDateTime('at 5pm', now), {
    status: 'incomplete',
    missing: ['date']
  });
  assert.equal(parseScheduledDateTime('today at 7am', now).status, 'past');
  assert.match(formatScheduledDateTime('2026-10-20T15:00:00.000Z', 'en-GB'), /20 October 2026/);
});

test('scheduled lesson store persists confirmations, supports management, and recovers interrupted sends safely', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-lessons-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'scheduled_lessons.json');
  let currentTime = Date.parse('2026-10-19T08:00:00.000Z');
  const store = createScheduledLessonStore({ filePath, now: () => currentTime });
  store.setPending('1001@s.whatsapp.net', {
    step: 'confirm',
    scheduledAt: '2026-10-20T15:00:00.000Z',
    createdAt: new Date(currentTime).toISOString()
  });
  assert.equal(store.getPending('1001@s.whatsapp.net').step, 'confirm');
  store.setPending('1003@s.whatsapp.net', {
    step: 'confirm',
    scheduledAt: '2026-10-20T15:00:00.000Z',
    createdAt: new Date(currentTime - 25 * 60 * 60_000).toISOString()
  });
  assert.equal(store.getPending('1003@s.whatsapp.net'), null);

  const scheduled = store.create({
    jid: '1001@s.whatsapp.net',
    phoneJid: '1001@s.whatsapp.net',
    studentName: 'Ali',
    gradeKey: 'grade_3_secondary',
    lessonIndex: 0,
    lessonId: 'lesson_1',
    lessonTitle: 'Lesson One',
    scheduledAt: '2026-10-20T15:00:00.000Z'
  });
  assert.equal(store.getPending('1001@s.whatsapp.net'), null);
  assert.equal(store.list()[0].id, scheduled.id);
  assert.equal(store.update(scheduled.id, current => ({
    ...current,
    scheduledAt: '2026-10-21T15:00:00.000Z'
  })).scheduledAt, '2026-10-21T15:00:00.000Z');
  assert.equal(store.cancel(scheduled.id).status, 'cancelled');

  const due = store.create({
    jid: '1002@s.whatsapp.net',
    phoneJid: '1002@s.whatsapp.net',
    studentName: 'Sara',
    gradeKey: 'grade_3_secondary',
    lessonIndex: 0,
    lessonId: 'lesson_1',
    lessonTitle: 'Lesson One',
    scheduledAt: '2026-10-20T15:00:00.000Z'
  });
  currentTime = Date.parse('2026-10-20T15:00:00.000Z');
  assert.equal(store.claimDue().id, due.id);
  assert.equal(store.claimDue(), null);
  store.recoverInterrupted();
  assert.equal(store.list().find(item => item.id === due.id).status, 'failed');
  assert.match(store.list().find(item => item.id === due.id).error, /uncertain/);
});

test('scheduled lesson store can defer a claimed lesson without losing its queue entry', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-lessons-defer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'scheduled_lessons.json');
  let currentTime = Date.parse('2026-10-19T08:00:00.000Z');
  const store = createScheduledLessonStore({ filePath, now: () => currentTime });
  const schedule = store.create({
    jid: '1001@s.whatsapp.net',
    gradeKey: 'grade_3_secondary',
    lessonIndex: 1,
    lessonId: 'lesson_2',
    lessonTitle: 'Lesson Two',
    scheduledAt: '2026-10-19T09:00:00.000Z'
  });
  currentTime = Date.parse(schedule.scheduledAt);

  assert.equal(store.claimDue().id, schedule.id);
  const deferred = store.reschedule(
    schedule.id,
    '2026-10-20T09:00:00.000Z'
  );
  assert.equal(deferred.status, 'scheduled');
  assert.equal(deferred.scheduledAt, '2026-10-20T09:00:00.000Z');
});
