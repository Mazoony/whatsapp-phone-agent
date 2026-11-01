export const STUDENT_MOTIVATION_TIME_ZONE = 'Africa/Khartoum';
export const STUDENT_WEEKLY_GOAL_MIN = 1;
export const STUDENT_WEEKLY_GOAL_MAX = 7;
export const STUDENT_MOTIVATION_CHECK_INTERVAL_MS = 60 * 1000;
const SCHEDULE_GRACE_MINUTES = 5;

function getLocalDateParts(timestamp, timeZone) {
  if (!Number.isFinite(timestamp) || timestamp < 0 ||
      typeof timeZone !== 'string' || !timeZone) {
    throw new TypeError('A valid timestamp and time zone are required.');
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

export function getStudentWeekStartDate(timestamp, timeZone = STUDENT_MOTIVATION_TIME_ZONE) {
  const { date } = getLocalDateParts(timestamp, timeZone);
  const [year, month, day] = date.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (utcDate.getUTCDay() + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);
  return utcDate.toISOString().slice(0, 10);
}

export function getStudentLocalDate(timestamp, timeZone = STUDENT_MOTIVATION_TIME_ZONE) {
  return getLocalDateParts(timestamp, timeZone).date;
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day + days));
  return utcDate.toISOString().slice(0, 10);
}

export function getStudentWeeklyLessonCount(
  student,
  timestamp,
  timeZone = STUDENT_MOTIVATION_TIME_ZONE,
  { weekStart = getStudentWeekStartDate(timestamp, timeZone),
    weekEnd = getLocalDateParts(timestamp, timeZone).date } = {}
) {
  if (!student || typeof student !== 'object' || Array.isArray(student)) {
    throw new TypeError('Student progress must be an object.');
  }
  return (Array.isArray(student.lessonCompletionTimestamps)
    ? student.lessonCompletionTimestamps
    : []).filter(completion => {
    const completionTimestamp = Date.parse(completion);
    if (!Number.isFinite(completionTimestamp) || completionTimestamp > timestamp) return false;
    const date = getLocalDateParts(completionTimestamp, timeZone).date;
    return date >= weekStart && date <= weekEnd;
  }).length;
}

export function getStudentGoalCommand(text) {
  const match = /^\/goal(?:@[a-z0-9_]+)?(?:\s+(\S+))?\s*$/i.exec(text.trim());
  if (!match) {
    if (/^\/goal_off(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim())) return { action: 'off' };
    return null;
  }
  if (match[1] === undefined) return { action: 'show' };
  if (!/^\d+$/.test(match[1])) return { action: 'invalid' };
  const goal = Number(match[1]);
  return goal >= STUDENT_WEEKLY_GOAL_MIN && goal <= STUDENT_WEEKLY_GOAL_MAX
    ? { action: 'set', goal }
    : { action: 'invalid' };
}

export function getStudentReminderCommand(text) {
  const normalized = text.trim();
  if (/^\/reminder_off(?:@[a-z0-9_]+)?(?:\s|$)/i.test(normalized)) {
    return { action: 'off' };
  }
  const match = /^\/reminder(?:@[a-z0-9_]+)?(?:\s+(\S+))?\s*$/i.exec(normalized);
  if (!match) return null;
  if (match[1] === undefined) return { action: 'show' };
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(match[1]);
  return time ? { action: 'set', time: `${time[1]}:${time[2]}` } : { action: 'invalid' };
}

function isWithinScheduleWindow(hour, minute, scheduledHour, scheduledMinute) {
  const elapsedMinutes = (hour * 60 + minute) - (scheduledHour * 60 + scheduledMinute);
  return elapsedMinutes >= 0 && elapsedMinutes <= SCHEDULE_GRACE_MINUTES;
}

function hasPendingLesson(student) {
  return ['awaiting_task', 'awaiting_reattempt'].includes(student.status);
}

export function getDueStudentMotivationMessages(
  progress,
  timestamp = Date.now(),
  timeZone = STUDENT_MOTIVATION_TIME_ZONE
) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new TypeError('Student progress must be an object.');
  }
  const localNow = getLocalDateParts(timestamp, timeZone);
  const weekStart = getStudentWeekStartDate(timestamp, timeZone);
  const previousWeekStart = addDays(weekStart, -7);
  const previousWeekEnd = addDays(weekStart, -1);
  const isWeeklyWindow = localNow.date === weekStart &&
    isWithinScheduleWindow(localNow.hour, localNow.minute, 18, 0);
  const due = [];

  for (const [studentKey, student] of Object.entries(progress)) {
    if (!student || typeof student !== 'object' || !student.telegramPrivateChatId) continue;

    if (Number.isInteger(student.weeklyLessonGoal) &&
        student.weeklyLessonGoal >= STUDENT_WEEKLY_GOAL_MIN &&
        student.weeklyLessonGoal <= STUDENT_WEEKLY_GOAL_MAX &&
        student.weeklyGoalMessageSentFor !== weekStart && isWeeklyWindow) {
      due.push({
        type: 'weekly_goal',
        studentKey,
        student,
        weekStart,
        completed: getStudentWeeklyLessonCount(student, timestamp, timeZone, {
          weekStart: previousWeekStart,
          weekEnd: previousWeekEnd
        }),
        goal: student.weeklyLessonGoal
      });
    }

    const reminder = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(student.dailyMotivationReminderTime || '');
    if (reminder &&
        student.dailyMotivationReminderSentFor !== localNow.date &&
        student.motivationMessageSentFor !== localNow.date &&
        hasPendingLesson(student) &&
        (!Number.isFinite(Date.parse(student.lastActivityAt || '')) ||
          getLocalDateParts(Date.parse(student.lastActivityAt), timeZone).date !== localNow.date) &&
        isWithinScheduleWindow(
          localNow.hour,
          localNow.minute,
          Number(reminder[1]),
          Number(reminder[2])
        )) {
      due.push({ type: 'daily_reminder', studentKey, student, date: localNow.date });
    }
  }

  return due;
}

export function formatWeeklyGoalMessage(completed, goal) {
  if (!Number.isInteger(completed) || completed < 0 ||
      !Number.isInteger(goal) || goal < STUDENT_WEEKLY_GOAL_MIN ||
      goal > STUDENT_WEEKLY_GOAL_MAX) {
    throw new TypeError('Valid weekly lesson progress and goal values are required.');
  }
  if (completed >= goal) {
    return `ملخص الأسبوع الفات 🌟\n\nكملت ${completed} ${completed === 1 ? 'حصة' : 'حصص'} وحققت هدفك الأسبوعي! برافو عليك، استمر بالوتيرة المناسبة ليك.\n\nهدفك الحالي ${goal} ${goal === 1 ? 'حصة' : 'حصص'} في الأسبوع. أرسل /goal لو داير تغيّره.`;
  }
  return `ملخص الأسبوع الفات 🌱\n\nكملت ${completed} من هدفك، ${goal} ${goal === 1 ? 'حصة' : 'حصص'} في الأسبوع الفات. الأسبوع الجديد فرصة نبدأ من وين وقفنا ونقرب لهدفنا من جديد. حتى عشرة دقايق بتفرق.\n\nأرسل /lesson لما تكون جاهز. أرسل /goal لو داير تغيّر هدفك.`;
}

export const DAILY_MOTIVATION_REMINDER_MESSAGE =
  'سلام 🌟 ده الزمن البحددته للحصة. حتى عشرة دقايق بتفرق؛ افتح الحصة الحالية وابدأ من وين وقفت. لو اليوم ما مناسب، ما في مشكلة—نواصل لما تكون جاهز.';
