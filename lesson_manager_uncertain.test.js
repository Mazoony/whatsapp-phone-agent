import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import { historyManager } from './history.js';
import { lessonManager } from './lesson_manager.js';

test('WhatsApp asks for clarification on uncertain grading without advancing the lesson', async () => {
  const jid = 'uncertain-task-grading-test@s.whatsapp.net';
  const originalProgress = lessonManager.progress[jid];
  const originalSaveProgress = lessonManager.saveProgress;
  const originalAddMessage = historyManager.addMessage;
  const originalTypingWordsPerMinute = config.typingWordsPerMinute;
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  const sentMessages = [];
  lessonManager.progress[jid] = {
    grade: 'grade_3_secondary',
    currentLessonIndex: 0,
    currentLessonId: 'lesson_1',
    status: 'awaiting_task',
    deliveredAt: new Date().toISOString()
  };
  lessonManager.saveProgress = () => {};
  historyManager.addMessage = () => {};
  config.typingWordsPerMinute = 1_000_000;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: JSON.stringify({
          isTaskSubmission: true,
          allCorrect: false,
          answeredQuestionNumbers: [1],
          correctQuestionNumbers: [],
          uncertainQuestionNumbers: [1],
          incorrectAnswers: []
        })
      }
    })
  });

  try {
    const sock = {
      sendMessage: async (_jid, message) => sentMessages.push(message),
      sendPresenceUpdate: async () => {}
    };
    assert.equal(await lessonManager.handleTaskSubmission(
      sock,
      jid,
      'a possibly equivalent answer',
      'Student',
      null
    ), true);

    assert.equal(lessonManager.progress[jid].currentLessonId, 'lesson_1');
    assert.equal(lessonManager.progress[jid].status, 'awaiting_reattempt');
    assert.match(sentMessages[0].text, /ما اعتبرتها غلط/);
  } finally {
    if (originalProgress) lessonManager.progress[jid] = originalProgress;
    else delete lessonManager.progress[jid];
    lessonManager.saveProgress = originalSaveProgress;
    historyManager.addMessage = originalAddMessage;
    config.typingWordsPerMinute = originalTypingWordsPerMinute;
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});
