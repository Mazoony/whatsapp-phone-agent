export const LESSON_ANSWER_REMINDER_DELAY_MS = 8 * 60 * 60 * 1000;
export const LESSON_ANSWER_REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

export const LESSON_ANSWER_REMINDER_MESSAGE =
  'تذكير يا بطل: تمرين الحصة لسه منتظر إجابتك. أرسل إجاباتك متين ما تكون جاهز.';

export function getDueLessonAnswerReminders(
  progress,
  now = Date.now(),
  {
    delayMs = LESSON_ANSWER_REMINDER_DELAY_MS,
    getIdentity = studentKey => studentKey
  } = {}
) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new TypeError('Lesson progress must be an object.');
  }
  if (!Number.isFinite(now) || now < 0 ||
      !Number.isFinite(delayMs) || delayMs < 0 ||
      typeof getIdentity !== 'function') {
    throw new TypeError('A valid reminder time, delay, and student identity function are required.');
  }

  const latestByStudent = new Map();
  for (const [studentKey, student] of Object.entries(progress)) {
    if (!student || typeof student !== 'object' || typeof student.currentLessonId !== 'string') continue;
    const deliveredAtMs = Date.parse(student.deliveredAt || '');
    if (!Number.isFinite(deliveredAtMs)) continue;
    const identity = String(getIdentity(studentKey, student));
    const existing = latestByStudent.get(identity);
    if (!existing || deliveredAtMs > existing.deliveredAtMs) {
      latestByStudent.set(identity, {
        identity,
        lessonId: student.currentLessonId,
        deliveredAt: student.deliveredAt,
        deliveredAtMs,
        entries: [{ studentKey, student }]
      });
    } else if (deliveredAtMs === existing.deliveredAtMs &&
        student.currentLessonId === existing.lessonId) {
      existing.entries.push({ studentKey, student });
    }
  }

  return [...latestByStudent.values()]
    .filter(reminder =>
      now - reminder.deliveredAtMs > delayMs &&
      reminder.entries.every(({ student }) => student.status === 'awaiting_task') &&
      reminder.entries.every(({ student }) =>
        student.answerReminderSentForDeliveryAt !== reminder.deliveredAt))
    .map(({ deliveredAtMs, ...reminder }) => ({
      ...reminder,
      ...reminder.entries[0]
    }));
}

export function markLessonAnswerReminderSent(reminder, sentAt = new Date().toISOString()) {
  if (!reminder || !Array.isArray(reminder.entries) ||
      !Number.isFinite(Date.parse(sentAt))) {
    throw new TypeError('A valid due lesson reminder and sent time are required.');
  }
  for (const { student } of reminder.entries) {
    student.answerReminderSentForDeliveryAt = reminder.deliveredAt;
    student.answerReminderSentAt = new Date(sentAt).toISOString();
  }
}
