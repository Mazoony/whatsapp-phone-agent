export function isTelegramAnnouncementRecipient(student, groupId) {
  const hasLessonHistory = Boolean(student?.telegramLessonRequestedAt) ||
    Boolean(student?.currentLessonId) ||
    (Number.isInteger(student?.lessonsCompleted) && student.lessonsCompleted > 0);
  return student?.telegramAnnouncementsOptIn !== false &&
    (student?.telegramAnnouncementsOptIn === true || hasLessonHistory) &&
    Number.isSafeInteger(student.telegramUserId) &&
    Boolean(student.telegramPrivateChatId) &&
    String(student.telegramChatId) === String(groupId || '');
}

export function recordTelegramLessonAnnouncementOptIn(student, now = new Date().toISOString()) {
  if (student.telegramAnnouncementsOptIn === false) return;
  student.telegramAnnouncementsOptIn = true;
  student.telegramAnnouncementsOptInAt ||= now;
  student.telegramLessonRequestedAt ||= now;
}
