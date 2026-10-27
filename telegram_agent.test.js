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
import { readAgentMediaActivities, writeAgentMediaActivity } from './agent_media_activity.js';
import { enqueueAgentMediaRetry } from './agent_media_retry.js';
import {
  readTelegramUpdateQueue,
  TelegramUpdateQueue,
  setTelegramUpdateQueuePaused
} from './telegram_update_queue.js';
import {
  readTelegramAgentStatus,
  writeTelegramAgentStatus
} from './telegram_agent_status.js';

function makeTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-agent-test-'));
}

function createFixture(t, { scanReceipt, privateChatError, refreshLessonsConfig } = {}) {
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
    refreshLessonsConfig: () => refreshLessonsConfig?.(lessonManager) ?? false,
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
  const mediaActivityFile = path.join(directory, 'telegram_agent_media_activity.json');
  const mediaRetryRequestsFile = path.join(directory, 'telegram_agent_media_retry_requests.json');
  let currentPrivateChatError = privateChatError;
  const bot = {
    sendMessage: async (chatId, text, replyToMessageId) => {
      if (currentPrivateChatError && String(chatId) === '44') throw currentPrivateChatError;
      sent.push({ type: 'text', chatId, text, replyToMessageId });
    },
    sendVideo: async (chatId, video, caption, replyToMessageId) => {
      if (currentPrivateChatError && String(chatId) === '44') throw currentPrivateChatError;
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
    evaluateTask: async (_lesson, submission, _studentName, { pendingQuestionNumbers } = {}) => {
      const correct = submission.toLowerCase() === 'correct answer';
      const answeredQuestionNumbers = pendingQuestionNumbers?.slice(0, 1) || [1];
      return {
        isTaskSubmission: true,
        allCorrect: correct,
        answeredQuestionNumbers,
        correctQuestionNumbers: correct ? answeredQuestionNumbers : [],
        incorrectAnswers: correct
          ? []
          : answeredQuestionNumbers.map(questionNumber => ({
              questionNumber,
              studentAnswer: submission,
              explanation: 'بعد الفاعل المفرد بنضيف s للفعل في المضارع البسيط.'
            }))
      };
    },
    videoPathResolver: videoFile => path.join(directory, videoFile),
    progressFile: path.join(directory, 'telegram_progress.json'),
    lessonSkipQueue,
    mediaActivityFile,
    mediaRetryRequestsFile,
    paymentLedger,
    ...(scanReceipt ? { scanReceipt } : {}),
    logger: { info() {}, error() {} }
  });
  return {
    agent,
    bot,
    directory,
    lessonManager,
    lessonSkipQueue,
    mediaActivityFile,
    mediaRetryRequestsFile,
    paymentLedger,
    sent,
    setPrivateChatError: error => {
      currentPrivateChatError = error;
    }
  };
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

function privateUpdate({ userId = 44, text, messageId = 7, chatId = userId } = {}) {
  return {
    message: {
      message_id: messageId,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, first_name: `Student ${userId}` },
      text
    }
  };
}

test('Telegram /lesson sends the lesson privately and confirms in the group', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson', messageId: 17 }));

  assert.deepEqual(sent.map(message => message.type), ['video', 'text', 'text']);
  assert.equal(sent[0].chatId, '44');
  assert.equal(sent[0].video.toString(), 'lesson_1');
  assert.equal(sent[0].replyToMessageId, undefined);
  assert.equal(sent[1].chatId, '44');
  assert.equal(sent[1].text, 'Answer question 1.');
  assert.equal(sent[1].replyToMessageId, undefined);
  assert.equal(sent[2].chatId, '-100123');
  assert.match(sent[2].text, /رديت عليك في الخاص.*كل التوفيق يا رب/);
  assert.equal(sent[2].replyToMessageId, 17);
  const progress = agent.progress['telegram:-100123:44'];
  assert.equal(progress.grade, 'grade_3_secondary');
  assert.equal(progress.telegramChatId, '-100123');
  assert.equal(progress.telegramPrivateChatId, '44');
  assert.equal(progress.currentLessonIndex, 0);
  assert.equal(progress.currentLessonId, 'lesson_1');
  assert.equal(progress.status, 'awaiting_task');
  assert.ok(progress.joinedAt);
  assert.equal(progress.name, 'Student 44');
});

test('Telegram announcement subscriptions require private opt-in and support immediate opt-out', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const student = agent.progress['telegram:-100123:44'];
  assert.equal(student.telegramAnnouncementsOptIn, undefined);

  await agent.handleUpdate(privateUpdate({ text: '/announcements_on' }));
  assert.equal(student.telegramAnnouncementsOptIn, true);
  assert.ok(student.telegramAnnouncementsOptInAt);
  assert.match(sent.at(-1).text, /تقدر توقفها في أي وقت/);

  await agent.handleUpdate(privateUpdate({ text: '/announcements_off' }));
  assert.equal(student.telegramAnnouncementsOptIn, false);
  assert.equal(student.telegramAnnouncementsOptInAt, null);
  assert.match(sent.at(-1).text, /تم إيقاف رسائل الإعلانات الخاصة/);
});

test('Telegram tracks failed lesson video delivery and retries it from the media queue', async t => {
  const { agent, mediaActivityFile, mediaRetryRequestsFile, sent, setPrivateChatError } = createFixture(t, {
    privateChatError: new Error('temporary Telegram send failure')
  });
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const failedActivity = readAgentMediaActivities(mediaActivityFile)[0];
  assert.equal(failedActivity.platform, 'Telegram');
  assert.equal(failedActivity.status, 'failed');
  assert.equal(failedActivity.lessonId, 'lesson_1');

  setPrivateChatError(null);
  enqueueAgentMediaRetry(failedActivity.id, mediaRetryRequestsFile);
  writeAgentMediaActivity({ ...failedActivity, status: 'retrying' }, mediaActivityFile);
  await agent.processPendingMediaRetries();

  assert.equal(readAgentMediaActivities(mediaActivityFile)[0].status, 'sent');
  assert.equal(sent.filter(message => message.type === 'video').length, 1);
});

test('Telegram records group member names and join dates from service messages', async t => {
  const { agent, sent } = createFixture(t);
  const joinedAtSeconds = 1_797_000_000;
  await agent.handleUpdate({
    update_id: 90,
    message: {
      message_id: 91,
      date: joinedAtSeconds,
      chat: { id: -100123, type: 'supergroup' },
      new_chat_members: [
        {
          id: 44,
          first_name: 'Maha',
          last_name: 'Ahmed',
          username: 'maha_ahmed'
        },
        { id: 99, first_name: 'Bot account', is_bot: true }
      ]
    }
  });

  const student = agent.progress['telegram:-100123:44'];
  assert.equal(student.name, 'Maha Ahmed');
  assert.equal(student.telegramUsername, 'maha_ahmed');
  assert.equal(student.telegramUserId, 44);
  assert.equal(student.telegramChatId, '-100123');
  assert.equal(student.groupJoinedAt, new Date(joinedAtSeconds * 1000).toISOString());
  assert.equal(student.status, 'awaiting_content');
  assert.equal(agent.progress['telegram:-100123:99'], undefined);
  assert.equal(sent.length, 0);
});

test('Telegram introduces the lessons and payment details to unregistered private contacts', async t => {
  const { agent, sent } = createFixture(t);

  await agent.handleUpdate(privateUpdate({ userId: 77, text: '/start' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '77');
  assert.match(sent[0].text, /أدخل مجموعة الدروس وأرسل \/lesson/);
  assert.match(sent[0].text, /17 ألف جنيه سوداني/);
  assert.match(sent[0].text, /رقم الحساب: 2865022/);
  assert.match(sent[0].text, /مازن محمد أحمد الصديق صالح/);
  assert.match(sent[0].text, /أرسل إشعار الدفع هنا/);
});

test('Telegram asks students to start the private chat before sending lessons there', async t => {
  const { agent, sent, setPrivateChatError } = createFixture(t, {
    privateChatError: new Error("Telegram sendVideo failed: Forbidden: bot can't initiate conversation with a user")
  });
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '-100123');
  assert.match(sent[0].text, /افتح المحادثة الخاصة معاي واضغط Start/);
  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, undefined);
  assert.equal(agent.progress['telegram:-100123:44'].telegramPrivateChatId, undefined);

  setPrivateChatError(null);
  await agent.handleUpdate(privateUpdate({ text: '/start' }));
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));

  assert.deepEqual(sent.slice(-3).map(message => message.type), ['video', 'text', 'text']);
  assert.deepEqual(sent.slice(-3).map(message => message.chatId), ['44', '44', '-100123']);
  assert.match(sent.at(-1).text, /رديت عليك في الخاص.*كل التوفيق يا رب/);
});

test('Telegram /lesson in private resends the active video and task privately', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  sent.length = 0;

  await agent.handleUpdate(privateUpdate({ text: '/lesson', messageId: 18 }));

  assert.deepEqual(sent.map(message => message.type), ['video', 'text']);
  assert.equal(sent[0].chatId, '44');
  assert.equal(sent[0].video.toString(), 'lesson_1');
  assert.equal(sent[0].replyToMessageId, 18);
  assert.equal(sent[1].chatId, '44');
  assert.equal(sent[1].text, 'Answer question 1.');
  assert.equal(sent[1].replyToMessageId, 18);
});

test('Telegram /number privately sends that lesson and makes it active', async t => {
  const { agent, directory, lessonManager, sent } = createFixture(t);
  const lesson6 = {
    id: 'lesson_6',
    title: 'Lesson 6',
    videoFile: 'lesson_6.mp4',
    caption: 'Watch lesson 6',
    taskMessage: 'Answer all ten questions.',
    answerKey: Array.from({ length: 10 }, (_, index) => `answer ${index + 1}`)
  };
  fs.writeFileSync(path.join(directory, lesson6.videoFile), Buffer.from(lesson6.id));
  lessonManager.lessonsConfig.grade_3_secondary.lessons.push(lesson6);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  sent.length = 0;

  await agent.handleUpdate(privateUpdate({ text: '/6', messageId: 19 }));

  assert.deepEqual(sent.map(message => message.type), ['video', 'text']);
  assert.ok(sent.every(message => message.chatId === '44'));
  assert.equal(sent[0].video.toString(), 'lesson_6');
  assert.equal(sent[1].text, 'Answer all ten questions.');
  const progress = agent.progress['telegram:-100123:44'];
  assert.equal(progress.currentLessonId, 'lesson_6');
  assert.equal(progress.currentLessonIndex, 2);
  assert.equal(progress.status, 'awaiting_task');
  assert.deepEqual(progress.correctQuestionNumbers, []);
});

test('Telegram grading keeps students isolated and sends the next lesson after a correct answer', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ userId: 44, text: '/lesson', messageId: 10 }));
  await agent.handleUpdate(groupUpdate({ userId: 45, text: '/lesson', messageId: 11 }));
  await agent.handleUpdate(privateUpdate({
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
    [
      'ممتاز! كل الإجابات صحيحة،\n\nيلا دا مستوى ناس الـ93 وفوق والله!\n\nخلينا نستمر كدا وحننبهر بالنتيجة.\n\nبجيك هسي الفيديو البعدو.',
      'video',
      'Answer question 2.'
    ]
  );
  assert.ok(sent.slice(-3).every(message => message.chatId === '44'));
  assert.equal(sent.slice(-3)[0].replyToMessageId, 20);
});

test('Telegram uses admin lesson edits when delivering the next lesson without restarting', async t => {
  let shouldApplyEdit = false;
  const { agent, sent } = createFixture(t, {
    refreshLessonsConfig: lessonManager => {
      if (!shouldApplyEdit) return false;
      shouldApplyEdit = false;
      lessonManager.lessonsConfig.grade_3_secondary.lessons[1].taskMessage =
        'Updated task from the admin dashboard.';
      return true;
    }
  });
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  shouldApplyEdit = true;

  await agent.handleUpdate(privateUpdate({ text: 'correct answer' }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_2');
  assert.equal(sent.at(-1).text, 'Updated task from the admin dashboard.');
});

test('Telegram clears previously accepted answers when an active lesson task changes', async t => {
  const { agent, lessonManager, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const student = agent.progress['telegram:-100123:44'];
  student.correctQuestionNumbers = [1];
  lessonManager.lessonsConfig.grade_3_secondary.lessons[0] = {
    ...lessonManager.lessonsConfig.grade_3_secondary.lessons[0],
    taskMessage: 'Updated two-question task.',
    answerKey: ['updated answer one', 'updated answer two']
  };
  let gradedQuestions;
  agent.evaluateTask = async (_lesson, _submission, _studentName, { pendingQuestionNumbers }) => {
    gradedQuestions = pendingQuestionNumbers;
    return {
      isTaskSubmission: true,
      allCorrect: true,
      answeredQuestionNumbers: pendingQuestionNumbers,
      correctQuestionNumbers: pendingQuestionNumbers
    };
  };

  await agent.handleUpdate(privateUpdate({ text: 'both updated answers' }));

  assert.deepEqual(gradedQuestions, [1, 2]);
  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_2');
  assert.match(sent.at(-3).text, /كل الإجابات صحيحة/);
});

test('Telegram keeps lesson answers and grading feedback out of the group', async t => {
  const { agent, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const groupMessagesBeforeAnswer = sent.filter(message => message.chatId === '-100123').length;
  await agent.handleUpdate(groupUpdate({ text: 'correct answer', messageId: 21 }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_1');
  assert.equal(sent.filter(message => message.chatId === '-100123').length, groupMessagesBeforeAnswer);
  assert.equal(sent.at(-1).chatId, '44');
  assert.equal(sent.at(-1).text, 'رسل لي الأجوبة في المحادثة الخاصة معاي.');
  await agent.handleUpdate(privateUpdate({ text: 'correct answer', messageId: 22 }));
  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_2');
  assert.ok(sent.slice(-3).every(message => message.chatId === '44'));
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
  assert.ok(sent.slice(-2).every(message => message.chatId === '44'));
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
  const submissionProcessing = agent.handleUpdate(privateUpdate({
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
  await agent.handleUpdate(privateUpdate({ text: 'wrong answer', messageId: 25 }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_1');
  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_reattempt');
  assert.match(sent.at(-1).text, /الإجابة المحتاجة تصحيح: السؤال 1: «wrong answer»/);
  assert.match(sent.at(-1).text, /الأسئلة المحتاجة تصحيح أو إجابة: 1/);
  assert.match(sent.at(-1).text, /ما محتاج تعيد الإجابات الصحيحة/);
  assert.match(sent.at(-1).text, /بدون رقم/);
  assert.equal(sent.filter(message => message.type === 'video').length, 1);
});

test('Telegram retains correct answers and accepts only the corrected question', async t => {
  const { agent, sent } = createFixture(t);
  const lesson = agent.lessonManager.lessonsConfig.grade_3_secondary.lessons[0];
  lesson.answerKey = ['answer one', 'answer two', 'answer three'];
  lesson.taskMessage = '1. Question one\n2. Question two\n3. Question three';
  agent.evaluateTask = async (_lesson, submission, _studentName, { pendingQuestionNumbers }) => {
    const answers = new Map();
    const lines = submission.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const numberedAnswers = lines
      .map(line => /^\s*(\d+)\s*[.)-]\s*(.+)$/.exec(line))
      .filter(Boolean);
    if (numberedAnswers.length) {
      for (const [, number, answer] of numberedAnswers) {
        answers.set(Number(number), answer.trim().toLowerCase());
      }
    } else if (lines.length === 1) {
      const answer = lines[0].toLowerCase();
      const matches = pendingQuestionNumbers.filter(number =>
        answer === `answer ${['one', 'two', 'three'][number - 1]}`);
      if (matches.length === 1) answers.set(matches[0], answer);
      else if (pendingQuestionNumbers.length === 1) answers.set(pendingQuestionNumbers[0], answer);
    } else {
      lines.slice(0, pendingQuestionNumbers.length).forEach((answer, index) => {
        answers.set(pendingQuestionNumbers[index], answer.toLowerCase());
      });
    }
    const answeredQuestionNumbers = [...answers.keys()]
      .filter(number => pendingQuestionNumbers.includes(number));
    const correctQuestionNumbers = answeredQuestionNumbers.filter(number =>
      answers.get(number) === `answer ${['one', 'two', 'three'][number - 1]}`);
    return {
      isTaskSubmission: true,
      allCorrect: pendingQuestionNumbers.every(number =>
        correctQuestionNumbers.includes(number)),
      answeredQuestionNumbers,
      correctQuestionNumbers,
      incorrectAnswers: answeredQuestionNumbers
        .filter(number => !correctQuestionNumbers.includes(number))
        .map(questionNumber => ({
          questionNumber,
          studentAnswer: answers.get(questionNumber)
        }))
    };
  };

  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  await agent.handleUpdate(privateUpdate({
    text: 'answer one\nwrong answer\nwrong answer'
  }));

  assert.deepEqual(agent.progress['telegram:-100123:44'].correctQuestionNumbers, [1]);
  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_1');
  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_reattempt');
  assert.match(sent.at(-1).text, /السؤال 2: «wrong answer»، السؤال 3: «wrong answer»/);
  assert.match(sent.at(-1).text, /الأسئلة المحتاجة تصحيح أو إجابة: 2، 3/);

  await agent.handleUpdate(privateUpdate({ text: 'answer two' }));

  assert.deepEqual(agent.progress['telegram:-100123:44'].correctQuestionNumbers, [1, 2]);
  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_1');
  assert.doesNotMatch(sent.at(-1).text, /إجاباتك الخاطئة في الأسئلة/);
  assert.match(sent.at(-1).text, /الأسئلة المحتاجة تصحيح أو إجابة: 3/);

  await agent.handleUpdate(privateUpdate({ text: 'answer three' }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_2');
  assert.deepEqual(agent.progress['telegram:-100123:44'].correctQuestionNumbers, []);
  assert.deepEqual(
    sent.slice(-3).map(message => message.type === 'video' ? 'video' : message.text),
    [
      'ممتاز! كل الإجابات صحيحة،\n\nيلا دا مستوى ناس الـ93 وفوق والله!\n\nخلينا نستمر كدا وحننبهر بالنتيجة.\n\nبجيك هسي الفيديو البعدو.',
      'video',
      'Answer question 2.'
    ]
  );
  assert.ok(sent.slice(-3).every(message => message.chatId === '44'));
});

test('Telegram explains an answer after one failed correction and sends the next lesson', async t => {
  const { agent, sent } = createFixture(t);
  const lesson = agent.lessonManager.lessonsConfig.grade_3_secondary.lessons[0];
  lesson.answerKey = ['goes — بعد he بنضيف s للفعل في المضارع البسيط.'];
  lesson.taskMessage = 'Complete: He ____ to school. (go)';
  agent.evaluateTask = async (_lesson, submission, _studentName, { pendingQuestionNumbers }) => {
    const correct = submission.toLowerCase() === 'goes';
    const questionNumber = pendingQuestionNumbers[0];
    return {
      isTaskSubmission: true,
      allCorrect: correct,
      answeredQuestionNumbers: [questionNumber],
      correctQuestionNumbers: correct ? [questionNumber] : [],
      incorrectAnswers: correct ? [] : [{
        questionNumber,
        studentAnswer: submission,
        explanation: 'بعد he بنضيف s للفعل في المضارع البسيط.'
      }]
    };
  };

  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  await agent.handleUpdate(privateUpdate({ text: 'go' }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_1');
  assert.deepEqual(agent.progress['telegram:-100123:44'].retryQuestionNumbers, [1]);
  assert.match(sent.at(-1).text, /السؤال 1: «go»/);
  assert.match(sent.at(-1).text, /ما محتاج تعيد الإجابات الصحيحة/);
  assert.equal(sent.filter(message => message.type === 'video').length, 1);

  await agent.handleUpdate(privateUpdate({ text: 'go' }));

  assert.equal(agent.progress['telegram:-100123:44'].currentLessonId, 'lesson_2');
  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_task');
  assert.equal(agent.progress['telegram:-100123:44'].lessonsCompleted, 1);
  assert.deepEqual(agent.progress['telegram:-100123:44'].resolvedQuestionNumbers, []);
  assert.deepEqual(agent.progress['telegram:-100123:44'].retryQuestionNumbers, []);
  assert.match(sent.at(-3).text, /الإجابة الصحيحة «goes»/);
  assert.match(sent.at(-3).text, /بعد he بنضيف s للفعل في المضارع البسيط/);
  assert.equal(sent.at(-2).type, 'video');
  assert.equal(sent.at(-1).text, 'Answer question 2.');
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
  assert.deepEqual(sent.map(message => message.chatId), ['44', '44', '-100123']);
  assert.deepEqual(
    sent.map(message => message.type === 'video' ? 'video' : message.text),
    ['video', 'Answer question 3.', 'تمام، رديت عليك في الخاص. راجع المحادثة هناك، كل التوفيق يا رب.']
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

  assert.equal(sent.length, 2);
  assert.equal(sent[0].chatId, '44');
  assert.equal(sent[0].text, 'كملت كل الدروس المتوفرة حالياً يا بطل.');
  assert.equal(sent[1].chatId, '-100123');
  assert.match(sent[1].text, /رديت عليك في الخاص.*كل التوفيق يا رب/);
});

test('Telegram grading failures do not mark answers wrong', async t => {
  const { agent, sent } = createFixture(t);
  agent.evaluateTask = async () => {
    throw new Error('grader unavailable');
  };
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  await agent.handleUpdate(privateUpdate({ text: 'submitted answer', messageId: 26 }));

  assert.equal(agent.progress['telegram:-100123:44'].status, 'awaiting_task');
  assert.match(sent.at(-1).text, /ما اتسجلت كغلط/);
});

test('Telegram reports when an oversized lesson video cannot be sent privately', async t => {
  const { agent, sent } = createFixture(t);
  agent.maxVideoBytes = 2;
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /مشكلة فنية في إرسال الدرس/);
  assert.equal(sent[0].chatId, '44');
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
  assert.match(sent[0].text, /ما لقيت حسابك مسجل في مجموعة الدروس/);
});

test('Telegram payment claims remain pending until an administrator reviews them', async t => {
  const { agent, paymentLedger, sent } = createFixture(t);
  await agent.handleUpdate(groupUpdate({ text: '/lesson' }));
  const groupMessagesBeforeClaim = sent.filter(message => message.chatId === '-100123').length;
  await agent.handleUpdate(groupUpdate({ text: '/paid' }));

  const payment = paymentLedger.getCurrent(
    'telegram:-100123:44',
    agent.progress['telegram:-100123:44'].enrolledAt
  );
  assert.equal(payment.status, 'pending_review');
  assert.equal(sent.filter(message => message.chatId === '-100123').length, groupMessagesBeforeClaim);
  assert.equal(sent.at(-1).chatId, '44');
  assert.match(sent.at(-1).text, /وصل إشعار الدفع للمراجعة، حنراجعه وبأكد ليك\. موفق يا رب!/);
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

  const groupMessagesBeforeStatus = sent.filter(message => message.chatId === '-100123').length;
  await agent.handleUpdate(groupUpdate({ text: '/payment' }));
  assert.equal(sent.at(-1).chatId, '44');
  assert.match(sent.at(-1).text, /تم تأكيد دفعك/);
  assert.equal(sent.filter(message => message.chatId === '-100123').length, groupMessagesBeforeStatus);

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
  assert.equal(sent.at(-1).text, 'وصل إشعار الدفع للمراجعة، حنراجعه وبأكد ليك. موفق يا رب!');
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
  delete student.telegramPrivateChatId;
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
  assert.equal(sent.length, 3);

  student.status = 'awaiting_task';
  student.currentLessonId = 'lesson_2';
  student.deliveredAt = new Date().toISOString();
  await agent.processDueLessonAnswerReminders();
  assert.equal(sent.length, 3);
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
  const queueFile = path.join(directory, 'telegram_update_queue.json');
  const controlFile = path.join(directory, 'telegram_agent_control.json');
  const updateQueue = new TelegramUpdateQueue({ queueFile, controlFile });
  const controller = new AbortController();
  const received = [];
  const logs = [];
  let pollCount = 0;
  await startTelegramPolling({
    api: {
      getUpdates: async () => {
        pollCount += 1;
        if (pollCount === 1) return [{ update_id: 21 }, { update_id: 22 }];
        for (let attempt = 0; attempt < 100 && received.length < 2; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        controller.abort();
        return [];
      }
    },
    agent: { handleUpdate: async update => received.push(update.update_id) },
    offsetFile,
    updateQueue,
    signal: controller.signal,
    logger: { info: message => logs.push(message), error() {} }
  });

  assert.deepEqual(received, [21, 22]);
  assert.ok(logs.some(message => /Telegram returned 2 update/.test(message)));
  assert.ok(logs.some(message => /shutdown signal received: yes/.test(message)));
  assert.equal(loadTelegramUpdateOffset(offsetFile), 23);
  assert.throws(() => saveTelegramUpdateOffset(-1, offsetFile), /non-negative safe integer/);
});

test('Telegram update queue persists order, pause state, and safe dashboard details', t => {
  const directory = makeTemporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queueFile = path.join(directory, 'telegram_update_queue.json');
  const controlFile = path.join(directory, 'telegram_agent_control.json');
  const queue = new TelegramUpdateQueue({ queueFile, controlFile });
  queue.enqueue({
    update_id: 51,
    message: {
      text: 'student private answer should not appear',
      chat: { id: -100123, type: 'supergroup', title: 'Lessons' },
      from: { id: 44, first_name: 'Ali' }
    }
  });
  setTelegramUpdateQueuePaused(true, controlFile);

  const snapshot = readTelegramUpdateQueue(queueFile, controlFile);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.waiting.length, 1);
  assert.equal(snapshot.waiting[0].name, 'Ali');
  assert.equal(snapshot.waiting[0].chat, 'Lessons');
  assert.equal(snapshot.waiting[0].messageType, 'Text');
  assert.equal(JSON.stringify(snapshot).includes('student private answer'), false);
  assert.equal(queue.takeNext(), null);

  setTelegramUpdateQueuePaused(false, controlFile);
  const entry = queue.takeNext();
  assert.equal(entry.update.update_id, 51);
  queue.enqueue({
    update_id: 52,
    message: {
      text: 'another answer',
      chat: { id: -100123, type: 'supergroup', title: 'Lessons' },
      from: { id: 45, first_name: 'Sara' }
    }
  });
  const liveSnapshot = readTelegramUpdateQueue(queueFile, controlFile);
  assert.equal(liveSnapshot.active.id, '51');
  assert.equal(liveSnapshot.waiting[0].id, '52');
  queue.finish(entry);
  assert.equal(readTelegramUpdateQueue(queueFile, controlFile).waiting.length, 1);
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
    updateQueue: new TelegramUpdateQueue({
      queueFile: path.join(directory, 'telegram_update_queue.json'),
      controlFile: path.join(directory, 'telegram_agent_control.json')
    }),
    signal: controller.signal,
    retryDelayMs: 0,
    onStatus: state => states.push(state),
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(states, ['connecting', 'retrying', 'connected', 'disconnected']);
});
