import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadTelegramUpdateOffset,
  saveTelegramUpdateOffset,
  startTelegramPolling,
  TelegramBotApi,
  TelegramLessonAgent
} from './telegram_agent.js';
import { LessonSkipQueue } from './lesson_skip_queue.js';
import { createStudentPaymentLedger } from './student_payment_ledger.js';
import {
  readTelegramAgentStatus,
  writeTelegramAgentStatus
} from './telegram_agent_status.js';

function makeTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-agent-test-'));
}

function createFixture(t, { scanReceipt } = {}) {
  const directory = makeTemporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lessons = [
    {
      id: 'lesson_1',
      title: 'Lesson 1',
      videoFile: 'lesson_1.mp4',
      caption: 'Watch lesson 1',
      taskMessage: 'Answer question 1.',
      answerKey: ['answer 1']
    },
    {
      id: 'lesson_2',
      title: 'Lesson 2',
      videoFile: 'lesson_2.mp4',
      caption: 'Watch lesson 2',
      taskMessage: 'Answer question 2.',
      answerKey: ['answer 2']
    }
  ];
  for (const lesson of lessons) {
    fs.writeFileSync(path.join(directory, lesson.videoFile), Buffer.from(lesson.id));
  }
  const lessonManager = {
    lessonsConfig: { grade_3_secondary: { lessons } },
    refreshLessonsConfig: () => false,
    getWelcomeSampleLesson: () => lessons[0],
    getNextSequentialLesson: (_grade, currentLessonId) => {
      const currentIndex = lessons.findIndex(lesson => lesson.id === currentLessonId);
      return currentIndex + 1 < lessons.length
        ? { status: 'ready', lessonIndex: currentIndex + 1 }
        : { status: 'completed' };
    }
  };
  const sent = [];
  const paymentLedger = createStudentPaymentLedger(path.join(directory, 'student_payment_ledger.json'));
  const bot = {
    sendMessage: async (chatId, text, replyToMessageId) => {
      sent.push({ type: 'text', chatId, text, replyToMessageId });
    },
    sendVideo: async (chatId, video, caption, replyToMessageId) => {
      sent.push({ type: 'video', chatId, video, caption, replyToMessageId });
    },
    getFile: async fileId => ({ file_path: `receipts/${fileId}.jpg` }),
    downloadFile: async () => Buffer.from('receipt-image')
  };
  const lessonSkipQueue = new LessonSkipQueue(path.join(directory, 'lesson_skip_requests.json'));
  const agent = new TelegramLessonAgent({
    bot,
    groupId: '-100123',
    lessonManager,
    evaluateTask: async (_lesson, submission) => ({
      isTaskSubmission: true,
      allCorrect: submission.toLowerCase() === 'correct answer',
      feedback: submission.toLowerCase() === 'correct answer'
        ? 'صحيح، ممتاز.'
        : 'في إجابة محتاجة تصحيح. حاول تاني.'
    }),
    videoPathResolver: videoFile => path.join(directory, videoFile),
    progressFile: path.join(directory, 'telegram_progress.json'),
    lessonSkipQueue,
    paymentLedger,
    ...(scanReceipt ? { scanReceipt } : {}),
    logger: { info() {}, error() {} }
  });
  return { agent, bot, directory, lessonManager, lessonSkipQueue, paymentLedger, sent };
}

function groupUpdate({
  updateId = 1,
  chatId = -100123,
  userId = 44,
  text,
  messageId = 7,
  chatType = 'supergroup',
  isBot = false
}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: chatType },
      from: { id: userId, first_name: `Student ${userId}`, is_bot: isBot },
      text
    }
  };
}

test('Telegram /lesson sends the configured video and task and saves per-student progress', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson', messageId: 17 }));

  assert.deepEqual(sent.map(message => message.type), ['video', 'text']);
  assert.equal(sent[0].chatId, '-100123');
  assert.equal(sent[0].video.toString(), 'lesson_1');
  assert.equal(sent[0].replyToMessageId, 17);
  assert.equal(sent[1].text, 'Answer question 1.');
  assert.equal(sent[1].replyToMessageId, 17);
  const progress = agent.progress['telegram:-100123:44'];
  assert.equal(progress.grade, 'grade_3_secondary');
  assert.equal(progress.currentLessonIndex, 0);
  assert.equal(progress.currentLessonId, 'lesson_1');
  assert.equal(progress.status, 'awaiting_task');
  assert.ok(progress.joinedAt);
  assert.equal(progress.name, 'Student 44');
});

test('Telegram grading keeps students isolated and sends the next lesson after a correct answer', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ userId: 44, text: '/lesson', messageId: 10 }));
  await agent.handleUpdate(groupUpdate({ userId: 45, text: '/lesson', messageId: 11 }));
  await agent.handleUpdate(groupUpdate({
    userId: 44,
    text: 'correct answer',
    messageId: 20
  }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_2');
  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_task');
  assert.equal(agent.progress['telegram:-100123:45'].currentLessonId, 'lesson_1');
  assert.equal(agent.progress['telegram:-100123:45'].status, 'awaiting_task');
  assert.equal(agent.progress['telegram:-100123:44'].lessonsCompleted, 1);
  assert.equal(agent.progress['telegram:-100123:44'].submissionsReceived, 1);
  assert.ok(agent.progress['telegram:-100123:44'].joinedAt);
  assert.deepEqual(
    sent.slice(-3).map(message => message.type === 'video' ? 'video' : message.text),
    ['صحيح، ممتاز.', 'video', 'Answer question 2.']
  );
  assert.ok(sent.slice(-3).every(message => message.replyToMessageId === 20));
});

test('admin lesson skip delivers the next Telegram lesson and updates progress after delivery', async t => {
  const { agent, lessonSkipQueue, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson', messageId: 10 }));
  const studentKey = 'telegram:-100123:44';
  const created = lessonSkipQueue.enqueue({
    platform: 'Telegram',
    studentKey,
    chatId: '-100123',
    userId: '44',
    gradeKey: 'grade_3_secondary',
    currentLessonId: 'lesson_1',
    nextLessonId: 'lesson_2'
  });

  await agent.processPendingLessonSkips();

  assert.equal(agent.progress[studentKey].currentLessonId, 'lesson_2');
  assert.equal(agent.progress[studentKey].currentLessonIndex, 1);
  assert.equal(agent.progress[studentKey].status, 'awaiting_task');
  assert.deepEqual(sent.slice(-2).map(message =>
    message.type === 'video' ? 'video' : message.text), ['video', 'Answer question 2.']);
  assert.equal(lessonSkipQueue.latestForStudent(studentKey).status, 'sent');
  assert.equal(lessonSkipQueue.read().find(item => item.id === created.request.id).status, 'sent');
});

test('admin lesson skip rejects a stale Telegram lesson request without sending it', async t => {
  const { agent, lessonSkipQueue, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const studentKey = 'telegram:-100123:44';
  const request = lessonSkipQueue.enqueue({
    platform: 'Telegram',
    studentKey,
    chatId: '-100123',
    userId: '44',
    gradeKey: 'grade_3_secondary',
    currentLessonId: 'lesson_0',
    nextLessonId: 'lesson_1'
  }).request;

  await agent.processPendingLessonSkips();

  assert.equal(lessonSkipQueue.read().find(item => item.id === request.id).status, 'failed');
  assert.equal(sent.filter(message => message.type === 'video').length, 1);
  assert.equal(agent.progress[studentKey].currentLessonId, 'lesson_1');
});

test('Telegram task answers are not graded against the next lesson during an admin skip', async t => {
  const { agent, bot, lessonSkipQueue, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const studentKey = 'telegram:-100123:44';
  lessonSkipQueue.enqueue({
    platform: 'Telegram',
    studentKey,
    chatId: '-100123',
    userId: '44',
    gradeKey: 'grade_3_secondary',
    currentLessonId: 'lesson_1',
    nextLessonId: 'lesson_2'
  });

  let releaseVideo;
  let markSecondVideoStarted;
  const secondVideoStarted = new Promise(resolve => {
    markSecondVideoStarted = resolve;
  });
  const waitForVideo = new Promise(resolve => {
    releaseVideo = resolve;
  });
  const sendVideo = bot.sendVideo.bind(bot);
  let videoCount = 0;
  bot.sendVideo = async (...args) => {
    videoCount += 1;
    if (videoCount === 1) {
      markSecondVideoStarted();
      await waitForVideo;
    }
    return sendVideo(...args);
  };

  const skipProcessing = agent.processPendingLessonSkips();
  await secondVideoStarted;
  const submissionProcessing = agent.handleUpdate(groupUpdate({
    text: 'correct answer',
    messageId: 22
  }));
  releaseVideo();
  await Promise.all([skipProcessing, submissionProcessing]);

  assert.equal(agent.progress[studentKey].currentLessonId, 'lesson_2');
  assert.equal(agent.progress[studentKey].lessonsCompleted, 0);
  assert.ok(sent.at(-1).text.includes('الحصة اتغيرت'));
});

test('incorrect Telegram task answers require a reattempt without advancing', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  await agent.handleUpdate(groupUpdate({ text: 'wrong answer', messageId: 25 }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_1');
  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_reattempt');
  assert.equal(sent.at(-1).text, 'في إجابة محتاجة تصحيح. حاول تاني.');
  assert.equal(sent.filter(message => message.type === 'video').length, 1);
});

test('students marked complete can receive lessons added to the curriculum later', async t => {
  const { agent, directory, lessonManager, sent } = createFixture(t);
  const lesson3 = {
    id: 'lesson_3',
    title: 'Lesson 3',
    videoFile: 'lesson_3.mp4',
    caption: 'Watch lesson 3',
    taskMessage: 'Answer question 3.',
    answerKey: ['answer 3']
  };
  fs.writeFileSync(path.join(directory, lesson3.videoFile), Buffer.from('lesson_3'));
  lessonManager.lessonsConfig.grade_3_secondary.lessons.push(lesson3);
  agent.progress['telegram:-100123:44'] = {
    grade: 'grade_3_secondary',
    currentLessonIndex: 1,
    currentLessonId: 'lesson_2',
    status: 'completed',
    deliveredAt: new Date().toISOString()
  };
  agent.saveProgress();

  await agent.handleUpdate(groupUpdate({ text: '/lesson', messageId: 30 }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_3');
  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_task');
  assert.deepEqual(
    sent.map(message => message.type === 'video' ? 'video' : message.text),
    ['video', 'Answer question 3.']
  );
});

test('completed students are told they are done when no lessons remain configured', async t => {
  const { agent, sent } = createFixture(t);
  agent.progress['telegram:-100123:44'] = {
    grade: 'grade_3_secondary',
    currentLessonIndex: 1,
    currentLessonId: 'lesson_2',
    status: 'completed'
  };

  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'كملت كل الدروس المتوفرة حالياً يا بطل.');
});

test('Telegram grading failures do not mark answers wrong', async t => {
  const { agent, sent } = createFixture(t);
  agent.evaluateTask = async () => {
    throw new Error('grader unavailable');
  };
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  await agent.handleUpdate(groupUpdate({ text: 'submitted answer', messageId: 26 }));

  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_task');
  assert.match(sent.at(-1).text, /ما اتسجلت كغلط/);
});

test('Telegram refuses oversized lesson videos before sending the task', async t => {
  const { agent, sent } = createFixture(t);
  agent.maxVideoBytes = 2;
  await assert.rejects(
    agent.handleUpdate(groupUpdate({ text: '/lesson' })),
    /exceeds the 1 MB Bot API upload limit/
  );
  assert.equal(sent.length, 0);
  const progress = agent.progress['telegram:-100123:44'];
  assert.equal(progress.status, 'awaiting_content');
  assert.ok(progress.joinedAt);
  assert.equal(progress.currentLessonId, undefined);
});

test('Telegram agent ignores unrelated messages, bots, and other groups', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: 'hello' }));
  await agent.handleUpdate(groupUpdate({ text: '/lesson', chatId: -100456 }));
  await agent.handleUpdate(groupUpdate({ text: '/lesson', isBot: true }));
  await agent.handleUpdate(groupUpdate({ text: '/lesson', chatType: 'private' }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /ما لقيت حسابك في مجموعة الدروس/);
});

test('Telegram payment claims remain pending until an administrator reviews them', async t => {
  const { agent, paymentLedger, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  await agent.handleUpdate(groupUpdate({ text: '/paid' }));

  const payment = paymentLedger.getCurrent(
    'telegram:-100123:44',
    agent.progress['telegram:-100123:44'].enrolledAt
  );
  assert.equal(payment.status, 'pending_review');
  assert.match(sent.at(-1).text, /ما حيتسجل كمدفوع إلا بعد ما نتأكد منه/);
});

test('Telegram payment status is sent privately and group replies do not disclose it', async t => {
  const { agent, paymentLedger, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const state = agent.progress['telegram:-100123:44'];
  paymentLedger.setStatus('telegram:-100123:44', {
    enrolledAt: state.enrolledAt,
    status: 'paid'
  });

  await agent.handleUpdate({
    message: {
      message_id: 12,
      chat: { id: 44, type: 'private' },
      from: { id: 44, first_name: 'Student 44' },
      text: '/start'
    }
  });
  assert.match(sent.at(-1).text, /تم تأكيد دفعك/);

  await agent.handleUpdate({
    message: {
      message_id: 13,
      chat: { id: 44, type: 'private' },
      from: { id: 44, first_name: 'Student 44' },
      text: '/payment'
    }
  });
  assert.match(sent.at(-1).text, /تم تأكيد دفعك/);

  await agent.handleUpdate(groupUpdate({ text: '/payment' }));
  assert.equal(sent.at(-2).chatId, '44');
  assert.match(sent.at(-2).text, /تم تأكيد دفعك/);
  assert.equal(sent.at(-1).chatId, '-100123');
  assert.doesNotMatch(sent.at(-1).text, /confirmed|paid|unpaid/i);

  await agent.handleUpdate({
    message: {
      message_id: 14,
      chat: { id: 44, type: 'private' },
      from: { id: 44, first_name: 'Student 44' },
      text: '/paid'
    }
  });
  assert.match(sent.at(-1).text, /متأكد من قبل/);
});

test('Telegram receipt scans are recorded as pending review', async t => {
  const { agent, paymentLedger, sent } = createFixture(t, {
    scanReceipt: async () => ({
      isPayment: true,
      details: {
        amount: 17000,
        currency: 'SDG',
        bank: 'Bankak',
        transactionId: 'TX-1'
      }
    })
  });
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  await agent.handleUpdate({
    message: {
      message_id: 15,
      chat: { id: 44, type: 'private' },
      from: { id: 44, first_name: 'Student 44' },
      photo: [{ file_id: 'receipt-1', file_size: 128 }]
    }
  });

  const payment = paymentLedger.getCurrent(
    'telegram:-100123:44',
    agent.progress['telegram:-100123:44'].enrolledAt
  );
  assert.equal(payment.status, 'pending_review');
  assert.equal(payment.amount, 17000);
  assert.equal(payment.details.transactionId, 'TX-1');
  assert.match(sent.at(-1).text, /ما حيتسجل الدفع كمدفوع إلا بعد ما نتأكد منه/);
});

test('Telegram sends a due unanswered lesson reminder once and records it', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const student = agent.progress['telegram:-100123:44'];
  student.deliveredAt = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
  agent.saveProgress();
  await agent.handleUpdate({
    message: {
      message_id: 50,
      chat: { id: 44, type: 'private' },
      from: { id: 44, first_name: 'Student 44' },
      text: '/start'
    }
  });

  await agent.processDueLessonAnswerReminders();
  await agent.processDueLessonAnswerReminders();

  const reminders = sent.filter(message => /تمرين الحصة لسه منتظر إجابتك/.test(message.text));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].chatId, '44');
  assert.equal(student.answerReminderSentForDeliveryAt, student.deliveredAt);
  assert.ok(student.answerReminderSentAt);
  const persisted = JSON.parse(fs.readFileSync(agent.progressFile, 'utf8'));
  assert.equal(
    persisted['telegram:-100123:44'].answerReminderSentForDeliveryAt,
    student.deliveredAt
  );
});

test('Telegram holds reminders privately until the student starts a private chat', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const student = agent.progress['telegram:-100123:44'];
  student.deliveredAt = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
  agent.saveProgress();

  await agent.processDueLessonAnswerReminders();

  assert.equal(sent.filter(message => /تمرين الحصة لسه منتظر إجابتك/.test(message.text)).length, 0);
  assert.equal(student.answerReminderSentForDeliveryAt, undefined);
  assert.equal(student.privateReminderUnavailableForDeliveryAt, student.deliveredAt);

  await agent.handleUpdate({
    message: {
      message_id: 51,
      chat: { id: 44, type: 'private' },
      from: { id: 44, first_name: 'Student 44' },
      text: '/start'
    }
  });
  await agent.processDueLessonAnswerReminders();

  const reminder = sent.find(message => /تمرين الحصة لسه منتظر إجابتك/.test(message.text));
  assert.ok(reminder);
  assert.equal(reminder.chatId, '44');
  assert.equal(student.answerReminderSentForDeliveryAt, student.deliveredAt);
  assert.equal(student.privateReminderUnavailableForDeliveryAt, undefined);
});

test('Telegram does not remind students who submitted or received a newer lesson', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const student = agent.progress['telegram:-100123:44'];
  student.deliveredAt = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
  student.status = 'awaiting_reattempt';
  await agent.processDueLessonAnswerReminders();
  assert.equal(sent.length, 2);

  student.status = 'awaiting_task';
  student.currentLessonId = 'lesson_2';
  student.deliveredAt = new Date().toISOString();
  await agent.processDueLessonAnswerReminders();
  assert.equal(sent.length, 2);
});

test('Telegram logs matching group messages when a student has no active lesson', async t => {
  const { agent, sent } = createFixture(t);
  const messages = [];
  agent.logger.info = message => messages.push(message);
  await agent.handleUpdate(groupUpdate({ text: 'hello', userId: 44 }));

  assert.equal(sent.length, 0);
  assert.ok(messages.some(message => /Received text in the configured group/.test(message)));
  assert.ok(messages.some(message => /Send \/lesson to start/.test(message)));
});

test('Telegram logs when messages arrive from a group ID that does not match configuration', async t => {
  const { agent, sent } = createFixture(t);
  const messages = [];
  agent.logger.info = message => messages.push(message);
  await agent.handleUpdate(groupUpdate({ text: '/lesson', chatId: -100456 }));
  await agent.handleUpdate(groupUpdate({ text: 'answer', chatId: -100456 }));

  assert.equal(sent.length, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /does not match TELEGRAM_GROUP_ID/);
});

test('Telegram group discovery logs its ID without responding until configured', async t => {
  const directory = makeTemporaryDirectory();
  const logged = [];
  const bot = { sendMessage: async () => assert.fail('Discovery must not send a message'), sendVideo: async () => {} };
  const agent = new TelegramLessonAgent({
    bot,
    groupId: '',
    progressFile: path.join(directory, 'progress.json'),
    logger: { info: message => logged.push(message), error() {} }
  });

  try {
    await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
    await agent.handleUpdate(groupUpdate({ text: 'answer', chatId: -100123 }));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /-100123/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Telegram Bot API sends JSON requests and multipart lesson videos', async () => {
  const requests = [];
  const api = new TelegramBotApi('123:secret', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  await api.getUpdates(9);
  await api.sendVideo('-100123', Buffer.from('video'), 'Lesson 1', 7);
  assert.equal(requests[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    offset: 9,
    timeout: 25,
    allowed_updates: ['message']
  });
  assert.match(requests[1].options.body.get('video').type, /video\/mp4/);
  assert.equal(requests[1].options.body.get('chat_id'), '-100123');
  assert.equal(requests[1].options.body.get('caption'), 'Lesson 1');
  assert.equal(
    requests[1].options.body.get('reply_parameters'),
    JSON.stringify({ message_id: 7 })
  );
  assert.match(requests[0].url, /\/getUpdates$/);
});

test('Telegram polling persists the next offset after processing updates', async t => {
  const directory = makeTemporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const offsetFile = path.join(directory, 'offset.json');
  const controller = new AbortController();
  const received = [];
  const logs = [];
  let pollCount = 0;
  await startTelegramPolling({
    api: {
      getUpdates: async () => {
        pollCount += 1;
        if (pollCount === 1) return [{ update_id: 21 }, { update_id: 22 }];
        controller.abort();
        return [];
      }
    },
    agent: { handleUpdate: async update => received.push(update.update_id) },
    offsetFile,
    signal: controller.signal,
    logger: { info: message => logs.push(message), error() {} }
  });

  assert.deepEqual(received, [21, 22]);
  assert.ok(logs.some(message => /Telegram returned 2 update/.test(message)));
  assert.ok(logs.some(message => /shutdown signal received: yes/.test(message)));
  assert.equal(loadTelegramUpdateOffset(offsetFile), 23);
  assert.throws(() => saveTelegramUpdateOffset(-1, offsetFile), /non-negative safe integer/);
});

test('Telegram agent status persists connection, heartbeat, and last-connected time', t => {
  const directory = makeTemporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statusFile = path.join(directory, 'telegram_agent_status.json');

  const connected = writeTelegramAgentStatus('connected', {
    filePath: statusFile,
    botUsername: 'lesson_bot',
    lastConnectedAt: '2026-10-22T00:00:00.000Z'
  });
  assert.equal(connected.connectionState, 'connected');
  assert.equal(connected.botUsername, 'lesson_bot');
  assert.equal(readTelegramAgentStatus(statusFile).lastConnectedAt, '2026-10-22T00:00:00.000Z');

  const disconnected = writeTelegramAgentStatus('disconnected', { filePath: statusFile });
  assert.equal(disconnected.connectionState, 'disconnected');
  assert.equal(disconnected.lastConnectedAt, connected.lastConnectedAt);
  assert.ok(Date.parse(disconnected.updatedAt) >= Date.parse(connected.updatedAt));
});

test('Telegram status writer replaces a corrupted status file and reports recovery', t => {
  const directory = makeTemporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statusFile = path.join(directory, 'telegram_agent_status.json');
  const warnings = [];
  fs.writeFileSync(statusFile, Buffer.alloc(182));

  const status = writeTelegramAgentStatus('connecting', {
    filePath: statusFile,
    botUsername: 'lesson_bot',
    logger: { warn: message => warnings.push(message) }
  });

  assert.equal(status.connectionState, 'connecting');
  assert.equal(readTelegramAgentStatus(statusFile).botUsername, 'lesson_bot');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid JSON; replacing it/);
});

test('Telegram polling reports connecting, retrying, connected, and disconnected states', async t => {
  const directory = makeTemporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const states = [];
  let pollCount = 0;

  await startTelegramPolling({
    api: {
      getUpdates: async () => {
        pollCount += 1;
        if (pollCount === 1) throw new Error('temporary failure');
        controller.abort();
        return [];
      }
    },
    agent: { handleUpdate: async () => {} },
    offsetFile: path.join(directory, 'offset.json'),
    signal: controller.signal,
    retryDelayMs: 0,
    onStatus: state => states.push(state),
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(states, ['connecting', 'retrying', 'connected', 'disconnected']);
});
