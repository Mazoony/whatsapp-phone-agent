import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDueLessonAnswerReminders,
  LESSON_ANSWER_REMINDER_DELAY_MS,
  LESSON_ANSWER_REMINDER_MESSAGE,
  markLessonAnswerReminderSent
} from './lesson_answer_reminders.js';

test('lesson answer reminders are due only after eight hours for unanswered active lessons', () => {
  const deliveredAt = '2026-10-20T00:00:00.000Z';
  const deliveredAtMs = Date.parse(deliveredAt);
  const progress = {
    awaiting: {
      status: 'awaiting_task',
      currentLessonId: 'lesson_1',
      deliveredAt
    },
    reattempt: {
      status: 'awaiting_reattempt',
      currentLessonId: 'lesson_2',
      deliveredAt
    },
    completed: {
      status: 'completed',
      currentLessonId: 'lesson_3',
      deliveredAt
    },
    invalidDelivery: {
      status: 'awaiting_task',
      currentLessonId: 'lesson_4',
      deliveredAt: 'invalid'
    }
  };

  assert.equal(getDueLessonAnswerReminders(
    progress,
    deliveredAtMs + LESSON_ANSWER_REMINDER_DELAY_MS
  ).length, 0);
  assert.equal(getDueLessonAnswerReminders(
    progress,
    deliveredAtMs + LESSON_ANSWER_REMINDER_DELAY_MS + 1
  ).length, 1);
  assert.equal(getDueLessonAnswerReminders(
    progress,
    deliveredAtMs + LESSON_ANSWER_REMINDER_DELAY_MS + 1
  )[0].studentKey, 'awaiting');
});

test('lesson reminder is sent only once and handles duplicate WhatsApp JID records', () => {
  const deliveredAt = '2026-10-20T00:00:00.000Z';
  const now = Date.parse(deliveredAt) + LESSON_ANSWER_REMINDER_DELAY_MS + 1;
  const first = { status: 'awaiting_task', currentLessonId: 'lesson_1', deliveredAt };
  const alias = { status: 'awaiting_task', currentLessonId: 'lesson_1', deliveredAt };
  const progress = {
    '249123456789@s.whatsapp.net': first,
    '249123456789@lid': alias
  };
  const identity = studentKey => studentKey.startsWith('249123456789')
    ? '249123456789@s.whatsapp.net'
    : studentKey;
  const [reminder] = getDueLessonAnswerReminders(progress, now, { getIdentity: identity });

  assert.equal(reminder.entries.length, 2);
  markLessonAnswerReminderSent(reminder, new Date(now).toISOString());
  assert.equal(first.answerReminderSentForDeliveryAt, deliveredAt);
  assert.equal(alias.answerReminderSentForDeliveryAt, deliveredAt);
  assert.equal(getDueLessonAnswerReminders(progress, now, { getIdentity: identity }).length, 0);
});

test('a newer lesson delivery or a submission invalidates an older reminder', () => {
  const oldDelivery = '2026-10-19T00:00:00.000Z';
  const newDelivery = '2026-10-20T00:00:00.000Z';
  const now = Date.parse(newDelivery) + LESSON_ANSWER_REMINDER_DELAY_MS + 1;
  const progress = {
    old: { status: 'awaiting_task', currentLessonId: 'lesson_1', deliveredAt: oldDelivery },
    latest: { status: 'awaiting_task', currentLessonId: 'lesson_2', deliveredAt: newDelivery }
  };

  const [reminder] = getDueLessonAnswerReminders(progress, now, {
    getIdentity: () => 'same-student'
  });
  assert.equal(reminder.studentKey, 'latest');
  progress.latest.status = 'awaiting_reattempt';
  assert.equal(getDueLessonAnswerReminders(progress, now, {
    getIdentity: () => 'same-student'
  }).length, 0);
});

test('a stale WhatsApp alias cannot trigger a reminder after another alias accepted an answer', () => {
  const deliveredAt = '2026-10-20T00:00:00.000Z';
  const progress = {
    '249123456789@s.whatsapp.net': {
      status: 'awaiting_task',
      currentLessonId: 'lesson_1',
      deliveredAt
    },
    '249123456789@lid': {
      status: 'awaiting_reattempt',
      currentLessonId: 'lesson_1',
      deliveredAt
    }
  };
  assert.equal(getDueLessonAnswerReminders(
    progress,
    Date.parse(deliveredAt) + LESSON_ANSWER_REMINDER_DELAY_MS + 1,
    { getIdentity: () => '249123456789@s.whatsapp.net' }
  ).length, 0);
});

test('reminder includes brief English and Arabic text', () => {
  assert.match(LESSON_ANSWER_REMINDER_MESSAGE, /تمرين الحصة لسه منتظر إجابتك/);
  assert.doesNotMatch(LESSON_ANSWER_REMINDER_MESSAGE, /Reminder:/);
});
