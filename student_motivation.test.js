import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAILY_MOTIVATION_REMINDER_MESSAGE,
  formatWeeklyGoalMessage,
  getDueStudentMotivationMessages,
  getStudentGoalCommand,
  getStudentReminderCommand,
  getStudentWeekStartDate,
  getStudentWeeklyLessonCount
} from './student_motivation.js';

const UTC = 'UTC';
const asTimestamp = date => Date.parse(`${date}Z`);

test('student weekly goal commands accept a bounded goal and disable action', () => {
  assert.deepEqual(getStudentGoalCommand('/goal'), { action: 'show' });
  assert.deepEqual(getStudentGoalCommand('/goal 3'), { action: 'set', goal: 3 });
  assert.deepEqual(getStudentGoalCommand('/goal_off'), { action: 'off' });
  assert.deepEqual(getStudentGoalCommand('/goal 8'), { action: 'invalid' });
  assert.deepEqual(getStudentGoalCommand('/goal 3.5'), { action: 'invalid' });
});

test('student reminder commands accept valid 24-hour times and opt out', () => {
  assert.deepEqual(getStudentReminderCommand('/reminder'), { action: 'show' });
  assert.deepEqual(getStudentReminderCommand('/reminder 18:30'), {
    action: 'set',
    time: '18:30'
  });
  assert.deepEqual(getStudentReminderCommand('/reminder_off'), { action: 'off' });
  assert.deepEqual(getStudentReminderCommand('/reminder 24:00'), { action: 'invalid' });
  assert.deepEqual(getStudentReminderCommand('/reminder 9:30'), { action: 'invalid' });
});

test('weekly lesson totals use Monday through the current local date', () => {
  const student = {
    lessonCompletionTimestamps: [
      '2026-10-25T23:59:00Z',
      '2026-10-26T00:01:00Z',
      '2026-10-28T10:00:00Z',
      '2026-11-02T00:01:00Z',
      'invalid'
    ]
  };
  const now = asTimestamp('2026-10-28T12:00:00');
  assert.equal(getStudentWeekStartDate(now, UTC), '2026-10-26');
  assert.equal(getStudentWeeklyLessonCount(student, now, UTC), 2);
});

test('weekly goal message is sent once in its five-minute Monday window', () => {
  const student = {
    telegramPrivateChatId: '44',
    status: 'awaiting_task',
    weeklyLessonGoal: 3,
    lessonCompletionTimestamps: ['2026-10-25T17:00:00Z']
  };
  const progress = { student };
  const due = getDueStudentMotivationMessages(
    progress,
    asTimestamp('2026-10-26T18:03:00'),
    UTC
  );
  assert.equal(due.length, 1);
  assert.equal(due[0].type, 'weekly_goal');
  assert.equal(due[0].completed, 1);
  assert.equal(due[0].goal, 3);
  student.weeklyGoalMessageSentFor = due[0].weekStart;
  assert.deepEqual(
    getDueStudentMotivationMessages(progress, asTimestamp('2026-10-26T18:04:00'), UTC),
    []
  );
});

test('daily reminders only target opted-in students with pending lessons and no activity today', () => {
  const now = asTimestamp('2026-10-28T18:02:00');
  const progress = {
    active: {
      telegramPrivateChatId: '44',
      dailyMotivationReminderTime: '18:00',
      status: 'awaiting_reattempt',
      lastActivityAt: '2026-10-27T18:00:00Z'
    },
    activeToday: {
      telegramPrivateChatId: '45',
      dailyMotivationReminderTime: '18:00',
      status: 'awaiting_task',
      lastActivityAt: '2026-10-28T08:00:00Z'
    },
    gotOtherReminder: {
      telegramPrivateChatId: '48',
      dailyMotivationReminderTime: '18:00',
      motivationMessageSentFor: '2026-10-28',
      status: 'awaiting_task',
      lastActivityAt: '2026-10-27T18:00:00Z'
    },
    optedOut: {
      telegramPrivateChatId: '46',
      status: 'awaiting_task',
      lastActivityAt: '2026-10-27T18:00:00Z'
    },
    noPendingLesson: {
      telegramPrivateChatId: '47',
      dailyMotivationReminderTime: '18:00',
      status: 'completed',
      lastActivityAt: '2026-10-27T18:00:00Z'
    }
  };
  const due = getDueStudentMotivationMessages(progress, now, UTC);
  assert.deepEqual(due.map(reminder => reminder.studentKey), ['active']);
  assert.equal(due[0].type, 'daily_reminder');
  assert.match(DAILY_MOTIVATION_REMINDER_MESSAGE, /ما في مشكلة/);
});

test('weekly goal progress text encourages without shaming', () => {
  assert.match(formatWeeklyGoalMessage(3, 3), /حققت هدفك الأسبوعي/);
  const missed = formatWeeklyGoalMessage(1, 3);
  assert.match(missed, /الأسبوع الجديد فرصة/);
  assert.doesNotMatch(missed, /فشلت|تأخرت|قصّرت/);
});
