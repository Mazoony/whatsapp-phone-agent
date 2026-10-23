import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { config } from './config.js';
import { historyManager } from './history.js';
import {
  hasLessonDeliveryConsent,
  inferSentLessonProgress,
  lessonManager,
  resolveLessonVideoPath
} from './lesson_manager.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

test('a correct submission immediately delivers the next numbered lesson', async () => {
  const jid = 'immediate-lesson-progression-test@s.whatsapp.net';
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.lessons[0];
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
    currentLessonId: lesson.id,
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
          allCorrect: true
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
      'My answers are correct.',
      'Student',
      null
    ), true);

    assert.equal(lessonManager.progress[jid].currentLessonId, 'lesson_2');
    assert.equal(lessonManager.progress[jid].status, 'awaiting_task');
    assert.deepEqual(
      sentMessages.map(message => message.text || (message.video ? 'video' : '')),
      [
        'صحيح، ممتاز.',
        'video',
        lessonManager.lessonsConfig.grade_3_secondary.lessons[1].taskMessage
      ]
    );
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

test('detects each Sudanese school grade with its stage', () => {
  const cases = [
    ['انا في الصف الاول الابتدائي', 'grade_1_primary'],
    ['تانية ابتدائي', 'grade_2_primary'],
    ['ثالثة ابتدائي', 'grade_3_primary'],
    ['رابعة ابتدائي', 'grade_4_primary'],
    ['خامسة ابتدائي', 'grade_5_primary'],
    ['سادسة ابتدائي', 'grade_6_primary'],
    ['أولى متوسط', 'grade_1_intermediate'],
    ['٢ متوسط', 'grade_2_intermediate'],
    ['تالتة متوسط', 'grade_3_intermediate'],
    ['اولى ثانوي', 'grade_1_secondary'],
    ['الصف الثاني الثانوي', 'grade_2_secondary'],
    ['ثالثة ثانوي', 'grade_3_secondary'],
    ['I am in Year 3 Secondary', 'grade_3_secondary'],
    ['I study in the third year secondary', 'grade_3_secondary'],
    ['انا ممتحنة السنة دي', 'grade_3_secondary'],
    ['انا ممتحنه السنه دي', 'grade_3_secondary'],
    ['انا ممتحن شهادة سودانية', 'grade_3_secondary'],
    ['الشهادة السودانية', 'grade_3_secondary']
  ];

  for (const [message, expectedGrade] of cases) {
    assert.equal(lessonManager.detectGrade(message), expectedGrade, message);
  }
});

test('does not guess a stage when a student only gives a grade number', () => {
  assert.equal(lessonManager.detectGrade('أنا في الصف الثاني'), null);
  assert.equal(lessonManager.detectGrade('أنا في تالتة'), null);
});

test('resolves configured lesson video paths from the app directory', () => {
  const originalDirectory = process.cwd();
  const unrelatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-path-cwd-'));
  try {
    process.chdir(unrelatedDirectory);
    const videoPath = resolveLessonVideoPath('media/lessons/grade_3_secondary/lesson_1.mp4');
    assert.equal(
      videoPath,
      path.join(APP_DIR, 'media', 'lessons', 'grade_3_secondary', 'lesson_1.mp4')
    );
    assert.equal(fs.existsSync(videoPath), true);
  } finally {
    process.chdir(originalDirectory);
    fs.rmSync(unrelatedDirectory, { recursive: true, force: true });
  }
});

test('orders available third-secondary videos numerically and waits at the first unconfigured lesson', () => {
  assert.deepEqual(lessonManager.getLessonVideoNumbers('grade_3_secondary'), [1, 2, 3, 4, 5, 6, 8, 9, 10]);
  assert.deepEqual(lessonManager.getNextSequentialLesson('grade_3_secondary', 'lesson_1'), {
    status: 'ready',
    lessonIndex: 1
  });
  assert.deepEqual(lessonManager.getNextSequentialLesson('grade_3_secondary', 'lesson_2'), {
    status: 'awaiting_content'
  });
  assert.deepEqual(lessonManager.getNextSequentialLesson('grade_3_secondary', 'lesson_6'), {
    status: 'awaiting_content'
  });
  assert.deepEqual(lessonManager.getNextSequentialLesson('grade_2_secondary', 'lesson_1'), {
    status: 'completed'
  });

  const grade = lessonManager.lessonsConfig.grade_3_secondary;
  const originalLessons = grade.lessons;
  try {
    grade.lessons = [{
      id: 'lesson_8',
      videoFile: 'media/lessons/grade_3_secondary/lesson_8.mp4',
      taskMessage: 'Complete lesson 8.',
      answerKey: ['answer']
    }];
    assert.deepEqual(lessonManager.getNextSequentialLesson('grade_3_secondary', 'lesson_6'), {
      status: 'awaiting_content'
    });
  } finally {
    grade.lessons = originalLessons;
  }
});

test('offers a welcome sample only for grades with a real first lesson video and exercise', () => {
  const gradeConfig = lessonManager.lessonsConfig.grade_3_secondary;
  const originalLesson = gradeConfig.lessons[0];

  assert.equal(lessonManager.getWelcomeSampleLesson('grade_3_secondary'), originalLesson);
  assert.equal(lessonManager.getWelcomeSampleLesson('grade_2_secondary'), null);

  try {
    gradeConfig.lessons[0] = { ...originalLesson, taskMessage: '   ' };
    assert.equal(lessonManager.getWelcomeSampleLesson('grade_3_secondary'), null);
    gradeConfig.lessons[0] = { ...originalLesson, answerKey: [] };
    assert.equal(lessonManager.getWelcomeSampleLesson('grade_3_secondary'), null);
    gradeConfig.lessons[0] = { ...originalLesson, videoFile: 'missing-welcome-sample.mp4' };
    assert.equal(lessonManager.getWelcomeSampleLesson('grade_3_secondary'), null);
  } finally {
    gradeConfig.lessons[0] = originalLesson;
  }
});

test('selects lesson one for a new student and the next sequence lesson after progress', () => {
  const jid = 'next-lesson-selection-test@s.whatsapp.net';
  const originalProgress = lessonManager.progress[jid];

  try {
    assert.equal(lessonManager.getNextLessonToDeliver(jid, 'grade_3_secondary').lessonIndex, 0);
    lessonManager.progress[jid] = {
      grade: 'grade_3_secondary',
      currentLessonIndex: 0,
      currentLessonId: 'lesson_1',
      status: 'awaiting_next_lesson'
    };
    assert.equal(lessonManager.hasActiveLesson(jid), false);
    assert.equal(lessonManager.getNextLessonToDeliver(jid, 'grade_3_secondary').lessonIndex, 1);
    lessonManager.progress[jid].status = 'awaiting_task';
    assert.equal(lessonManager.hasActiveLesson(jid), true);
    lessonManager.progress[jid] = { grade: 'grade_3_secondary', status: 'completed' };
    assert.equal(
      lessonManager.getNextLessonToDeliver(jid, 'grade_3_secondary').status,
      'awaiting_content'
    );
  } finally {
    if (originalProgress) lessonManager.progress[jid] = originalProgress;
    else delete lessonManager.progress[jid];
  }
});

test('infers the last delivered lesson only from outgoing lesson markers or exercise text', () => {
  const lessons = [
    {
      id: 'lesson_1',
      title: 'Present simple',
      taskMessage: 'Complete all the present simple exercises in your notebook.'
    },
    {
      id: 'lesson_2',
      title: 'Past simple',
      taskMessage: 'Write five sentences using the past simple tense.'
    }
  ];

  assert.deepEqual(inferSentLessonProgress([
    { role: 'client', text: lessons[1].taskMessage },
    { role: 'agent', text: '🎬 [فيديو: Past simple]\nPast simple' },
    { role: 'agent', text: lessons[0].taskMessage },
    { role: 'agent', text: lessons[1].taskMessage }
  ], lessons), {
    lessonIndex: 1,
    lessonId: 'lesson_2'
  });
  assert.equal(inferSentLessonProgress([
    { role: 'client', text: lessons[1].taskMessage },
    { role: 'agent', text: 'I will prepare more lessons soon.' }
  ], lessons), null);
  assert.deepEqual(inferSentLessonProgress([
    { role: 'agent', text: 'Complete all the present simple exercises in your notebook.' }
  ], lessons.slice(0, 1)), { lessonIndex: 0, lessonId: 'lesson_1' });
  assert.deepEqual(inferSentLessonProgress([
    { role: 'agent', text: '🎬 [فيديو: lesson_2]' }
  ], [{ id: 'lesson_2', title: '', taskMessage: '' }]), {
    lessonIndex: 0,
    lessonId: 'lesson_2'
  });
  assert.equal(inferSentLessonProgress([
    { role: 'agent', text: 'Do these exercises after class.' }
  ], [
    { id: 'lesson_1', taskMessage: 'Do these exercises after class.' },
    { id: 'lesson_2', taskMessage: 'Do these exercises after class.' }
  ]), null);
});

test('recognizes requests to send or resend a lesson video', () => {
  for (const message of [
    'رسل لي الفيديو',
    'أرسل الفيديو تاني',
    'ابعث لي المقطع مرة تانية',
    'Please resend the video',
    'Send me the clip again',
    'ما وصل الفيديو',
    'الفيديو ما وصل يا أستاذ',
    'وين الفيديو؟',
    'رسل لي الفيديو الأول تاني'
  ]) {
    assert.equal(lessonManager.isLessonVideoRequest(message), true, message);
  }

  for (const message of ['رسل لي التمرين', 'I watched the video yesterday', 'كيف حالك؟']) {
    assert.equal(lessonManager.isLessonVideoRequest(message), false, message);
  }
});

test('recognizes requests to resend a lesson task or exercise', () => {
  for (const message of [
    'Can you send the exercise again?',
    'Please resend my homework',
    'I did not get the task',
    'رسل لي التمرين تاني',
    'ممكن ترسل الواجب مرة تانية',
    'ما وصلني التمرين'
  ]) {
    assert.equal(lessonManager.isLessonTaskRequest(message), true, message);
  }

  for (const message of [
    'I finished the exercise',
    'ما فهمت السؤال',
    'رسل لي الفيديو تاني',
    'كيف حالك؟'
  ]) {
    assert.equal(lessonManager.isLessonTaskRequest(message), false, message);
  }
});

test('lets Grade 3 students choose and complete Treasure Island lessons without changing curriculum progress', async () => {
  const jid = 'test-treasure-island@s.whatsapp.net';
  const videoPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'treasure-island-video-')), 'chapter.mp4');
  fs.writeFileSync(videoPath, 'test-video');
  const grade = lessonManager.lessonsConfig.grade_3_secondary;
  const originalCollection = grade.collections?.treasure_island;
  const originalProgress = lessonManager.progress;
  const originalSaveProgress = lessonManager.saveProgress;
  const originalAddMessage = historyManager.addMessage;
  const sent = [];

  try {
    grade.collections ||= {};
    grade.collections.treasure_island = {
      title: 'Treasure Island',
      lessons: [{
        id: 'chapter_1',
        title: 'Chapter One',
        videoFile: videoPath,
        caption: 'Chapter One video',
        introMessage: '',
        taskMessage: 'Answer the Chapter One exercise.',
        answerKey: ['The answer is Jim.']
      }]
    };
    lessonManager.progress = {
      [jid]: { grade: 'grade_3_secondary', currentLessonIndex: 4, status: 'completed' }
    };
    lessonManager.saveProgress = () => {};
    historyManager.addMessage = () => {};

    const sock = {
      sendMessage: async (...args) => { sent.push(args); }
    };
    assert.equal(await lessonManager.handleTreasureIslandMessage(
      sock, jid, 'Can I choose a Treasure Island lesson?', 'Student'
    ), true);
    assert.match(sent[0][1].text, /1\. Chapter One/);

    assert.equal(await lessonManager.handleTreasureIslandMessage(
      sock, jid, '١', 'Student'
    ), true);
    assert.ok(Buffer.isBuffer(sent.find(([, payload]) => payload.video)?.[1].video));
    assert.equal(sent.at(-1)[1].text, 'Answer the Chapter One exercise.');

    assert.equal(lessonManager.progress[jid].currentLessonIndex, 4);
    assert.equal(lessonManager.progress[jid].status, 'completed');
    assert.equal(lessonManager.progress[jid].treasureIsland.activeLessonId, 'chapter_1');
    assert.equal(lessonManager.progress[jid].treasureIsland.status, 'awaiting_task');
  } finally {
    lessonManager.progress = originalProgress;
    lessonManager.saveProgress = originalSaveProgress;
    historyManager.addMessage = originalAddMessage;
    if (originalCollection) grade.collections.treasure_island = originalCollection;
    else delete grade.collections.treasure_island;
    if (Object.keys(grade.collections).length === 0) delete grade.collections;
    fs.rmSync(path.dirname(videoPath), { recursive: true, force: true });
  }
});

test('resends the assigned exercise without changing student progress', async () => {
  const jid = 'task-resend-test@s.whatsapp.net';
  const originalProgress = lessonManager.progress[jid];
  const originalAddMessage = historyManager.addMessage;
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.lessons[1];
  const sentMessages = [];
  const progress = {
    grade: 'grade_3_secondary',
    currentLessonIndex: 1,
    currentLessonId: lesson.id,
    status: 'awaiting_reattempt',
    deliveredAt: '2026-10-19T12:00:00.000Z'
  };
  lessonManager.progress[jid] = progress;
  historyManager.addMessage = () => {};

  try {
    assert.equal(await lessonManager.resendCurrentLessonTask({
      sendMessage: async (_jid, message) => sentMessages.push(message)
    }, jid), true);
    assert.deepEqual(sentMessages, [{ text: lesson.taskMessage }]);
    assert.equal(lessonManager.progress[jid], progress);
    assert.equal(progress.status, 'awaiting_reattempt');
  } finally {
    if (originalProgress) lessonManager.progress[jid] = originalProgress;
    else delete lessonManager.progress[jid];
    historyManager.addMessage = originalAddMessage;
  }
});

test('recognizes explicit lesson delivery requests', () => {
  for (const message of [
    'Please send me the lesson now',
    'Can you send the video?',
    'Can I get the video lesson?',
    'I would like to receive videos',
    'I want to start the lessons',
    'أرسل لي الدرس',
    'داير الفيديو',
    'ممكن فيديوهات لي مقرر الصف الثالث الثانوي',
    'عايزة فيديو الحصة الأولى',
    'ممكن ترسل لي درس المضارع البسيط',
    'اي نبدا هسي',
    'يلا نبدا طوالي'
  ]) {
    assert.equal(lessonManager.isLessonDeliveryRequest(message), true, message);
  }

  for (const message of [
    'What lessons do you offer?',
    'I watched the lesson yesterday',
    'ممكن تشرح لي قاعدة المضارع البسيط؟'
  ]) {
    assert.equal(lessonManager.isLessonDeliveryRequest(message), false, message);
  }
});

test('requires an affirmative reply to the lesson permission question', () => {
  const permissionQuestion = 'May I send you a lesson now?';
  const arabicPermissionQuestion = 'جاهزة أرسل ليكِ أول فيديو؟';
  assert.equal(hasLessonDeliveryConsent('Yes, please', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('Sure', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('ايوة', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('ااي', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('اي', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('اي نبدا هسي', arabicPermissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('يلا نبدا', arabicPermissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('تمام رسل', arabicPermissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('جاهزة رسلي', arabicPermissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('Yes, grammar is difficult', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('No, not yet', permissionQuestion), false);
  assert.equal(hasLessonDeliveryConsent('لا هسي ما جاهزة', arabicPermissionQuestion), false);
  assert.equal(hasLessonDeliveryConsent('Yes, but later', permissionQuestion), false);
  assert.equal(hasLessonDeliveryConsent('My problem is grammar. Yes, please.', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('Grammar is hard, but not yet.', permissionQuestion), false);
  assert.equal(hasLessonDeliveryConsent('Please help me with grammar.', permissionQuestion), false);
  assert.equal(hasLessonDeliveryConsent('Yes, please help me with grammar.', permissionQuestion), true);
  assert.equal(hasLessonDeliveryConsent('Yes', 'What is difficult in English?'), false);
});

test('resends the active lesson video without resetting lesson progress', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-video-'));
  const videoPath = path.join(directory, 'lesson.mp4');
  const video = Buffer.from('video-fixture');
  fs.writeFileSync(videoPath, video);
  const jid = 'video-resend-test@s.whatsapp.net';
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.lessons[1];
  const originalVideoPath = lesson.videoFile;
  const originalProgress = lessonManager.progress[jid];
  lesson.videoFile = videoPath;
  lessonManager.progress[jid] = {
    grade: 'grade_3_secondary',
    currentLessonIndex: 1,
    currentLessonId: lesson.id,
    status: 'awaiting_task',
    deliveredAt: '2026-01-01T00:00:00.000Z'
  };
  const sentMessages = [];

  try {
    assert.equal(await lessonManager.resendCurrentLessonVideo({
      sendMessage: async (_jid, content) => sentMessages.push(content)
    }, jid), true);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0].video, video);
    assert.equal(sentMessages[0].caption, lesson.caption || lesson.title);
    assert.equal(lessonManager.progress[jid].currentLessonIndex, 1);
    assert.equal(lessonManager.progress[jid].status, 'awaiting_task');
  } finally {
    lesson.videoFile = originalVideoPath;
    if (originalProgress) lessonManager.progress[jid] = originalProgress;
    else delete lessonManager.progress[jid];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('resends a failed media activity to its original recipient and preserves its activity ID', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-media-retry-'));
  const videoPath = path.join(directory, 'lesson.mp4');
  const video = Buffer.from('retry-video-fixture');
  fs.writeFileSync(videoPath, video);
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.lessons[0];
  const originalVideoPath = lesson.videoFile;
  const originalAddMessage = historyManager.addMessage;
  const sentMessages = [];
  lesson.videoFile = videoPath;
  historyManager.addMessage = () => {};

  try {
    await lessonManager.resendMediaActivity({
      sendMessage: async (...args) => sentMessages.push(args)
    }, {
      id: 'failed-video-activity',
      mediaType: 'video',
      recipientJid: '1001@s.whatsapp.net',
      description: lesson.caption || lesson.title,
      retry: { gradeKey: 'grade_3_secondary', lessonId: lesson.id }
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0][0], '1001@s.whatsapp.net');
    assert.deepEqual(sentMessages[0][1].video, video);
    assert.deepEqual(sentMessages[0][3], {
      activityId: 'failed-video-activity',
      retry: { gradeKey: 'grade_3_secondary', lessonId: lesson.id }
    });
  } finally {
    lesson.videoFile = originalVideoPath;
    historyManager.addMessage = originalAddMessage;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not send a video placeholder, task, or progress update when the lesson video is missing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-video-missing-'));
  const jid = 'video-missing-test@s.whatsapp.net';
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.lessons[0];
  const originalVideoPath = lesson.videoFile;
  const originalProgress = lessonManager.progress[jid];
  const previousProgress = {
    grade: 'grade_3_secondary',
    currentLessonIndex: 0,
    status: 'awaiting_task',
    deliveredAt: '2026-01-01T00:00:00.000Z'
  };
  lesson.videoFile = path.join(directory, 'missing.mp4');
  lessonManager.progress[jid] = previousProgress;
  const sentMessages = [];

  try {
    assert.equal(await lessonManager.deliverLesson({
      sendMessage: async (_jid, content) => sentMessages.push(content)
    }, jid, 'grade_3_secondary', 0), false);
    assert.equal(sentMessages.length, 1);
    assert.equal(typeof sentMessages[0].text, 'string');
    assert.match(sentMessages[0].text, /ما حأرسل التمرين/);
    assert.equal(sentMessages.some(message => message.video), false);
    assert.equal(sentMessages.some(message => /تمرين الحصة/.test(message.text || '')), false);
    assert.equal(sentMessages.some(message => /قيد الرفع/.test(message.text || '')), false);
    assert.equal(lessonManager.progress[jid], previousProgress);
  } finally {
    lesson.videoFile = originalVideoPath;
    if (originalProgress) lessonManager.progress[jid] = originalProgress;
    else delete lessonManager.progress[jid];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not deliver a second lesson within 24 hours', async () => {
  const jid = 'daily-delivery-limit-test@s.whatsapp.net';
  const originalProgress = lessonManager.progress[jid];
  const originalSaveProgress = lessonManager.saveProgress;
  const sentMessages = [];
  lessonManager.progress[jid] = {
    grade: 'grade_3_secondary',
    currentLessonIndex: 0,
    status: 'awaiting_next_lesson',
    treasureIsland: {
      deliveredAt: new Date(Date.now() - 60_000).toISOString()
    }
  };
  lessonManager.saveProgress = () => {};

  try {
    assert.equal(await lessonManager.deliverLesson({
      sendMessage: async (_jid, message) => sentMessages.push(message)
    }, jid, 'grade_3_secondary', 1), false);
    assert.equal(await lessonManager.deliverTreasureIslandLesson({
      sendMessage: async (_jid, message) => sentMessages.push(message)
    }, jid, { id: 'chapter_1', title: 'Chapter One', videoFile: 'missing.mp4' }), false);
    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[0].text, /آخر ٢٤ ساعة/);
  } finally {
    if (originalProgress) lessonManager.progress[jid] = originalProgress;
    else delete lessonManager.progress[jid];
    lessonManager.saveProgress = originalSaveProgress;
  }
});

test('delivers only the lesson video and task without simulated typing delays', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-fast-delivery-'));
  const videoPath = path.join(directory, 'lesson.mp4');
  fs.writeFileSync(videoPath, Buffer.from('video-fixture'));
  const jid = 'lesson-fast-delivery-test@s.whatsapp.net';
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.lessons[0];
  const originalVideoPath = lesson.videoFile;
  const originalProgress = lessonManager.progress[jid];
  const originalHistory = historyManager.history[jid];
  const originalScheduleSave = historyManager.scheduleSave;
  const originalSaveProgress = lessonManager.saveProgress;
  const sentMessages = [];
  const presenceUpdates = [];

  lesson.videoFile = videoPath;
  historyManager.scheduleSave = () => {};
  lessonManager.saveProgress = () => {};

  try {
    assert.equal(await lessonManager.deliverLesson({
      sendMessage: async (_jid, content) => sentMessages.push(content),
      sendPresenceUpdate: async (...args) => presenceUpdates.push(args)
    }, jid, 'grade_3_secondary', 0, null, { includeIntro: false }), true);

    assert.deepEqual(sentMessages.map(message => message.text || 'video'), [
      'video',
      lesson.taskMessage
    ]);
    assert.deepEqual(presenceUpdates, []);
    assert.equal(lessonManager.progress[jid].status, 'awaiting_task');
  } finally {
    lesson.videoFile = originalVideoPath;
    if (originalProgress) lessonManager.progress[jid] = originalProgress;
    else delete lessonManager.progress[jid];
    if (originalHistory) historyManager.history[jid] = originalHistory;
    else delete historyManager.history[jid];
    historyManager.scheduleSave = originalScheduleSave;
    lessonManager.saveProgress = originalSaveProgress;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('new grade entries wait for their own lesson content', () => {
  for (const gradeKey of [
    'grade_1_primary',
    'grade_2_primary',
    'grade_3_primary',
    'grade_4_primary',
    'grade_5_primary',
    'grade_6_primary',
    'grade_1_intermediate',
    'grade_2_intermediate',
    'grade_3_intermediate',
    'grade_1_secondary',
    'grade_2_secondary'
  ]) {
    assert.deepEqual(lessonManager.lessonsConfig[gradeKey].lessons, [], gradeKey);
  }
});

test('third-secondary lesson 1 has exactly 12 affirmative singular verb-s exercises', () => {
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.lessons[0];
  const exerciseNumbers = [...lesson.taskMessage.matchAll(/^\s*(\d+)\./gm)].map(match => Number(match[1]));
  const expectedAnswers = [
    'interprets', 'maintains', 'reflects', 'conducts', 'transmits', 'demands',
    'reports', 'recommends', 'permits', 'predicts', 'benefits', 'confirms'
  ];

  assert.deepEqual(exerciseNumbers, Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(lesson.answerKey.length, 12);
  assert.deepEqual(lesson.answerKey.map(answer => answer.split(' — ')[0].replace(/^\d+\.\s*/, '')), expectedAnswers);
  assert.equal((lesson.taskMessage.match(/\([a-z]+\)/g) || []).length, 12);
  assert.equal((lesson.taskMessage.match(/_{4,}/g) || []).length, 12);
});

test('standalone third-secondary lesson 5 has 11 do-not negatives and 4 lesson 1 review items', () => {
  const lesson = lessonManager.lessonsConfig.grade_3_secondary.standaloneLessons.find(item => item.id === 'lesson_5');
  assert.ok(lesson, 'lesson 5 is configured as a standalone lesson');

  const exerciseNumbers = [...lesson.taskMessage.matchAll(/^\s*(\d+)\./gm)].map(match => Number(match[1]));
  const expectedAnswers = [
    'do not allocate', 'do not disclose', 'do not assume', 'do not negotiate',
    'do not require', 'do not submit', 'do not postpone', 'do not identify',
    'do not recommend', 'do not distribute', 'do not interpret',
    'interprets', 'maintains', 'permits', 'confirms'
  ];

  assert.deepEqual(exerciseNumbers, Array.from({ length: 15 }, (_, index) => index + 1));
  assert.deepEqual(lesson.answerKey.map(answer => answer.split(' — ')[0].replace(/^\d+\.\s*/, '')), expectedAnswers);
  assert.equal((lesson.taskMessage.match(/_{4,}/g) || []).length, 15);
  assert.equal(/\bdoes not\b|\bdoesn't\b/i.test(`${lesson.taskMessage}\n${lesson.answerKey.join('\n')}`), false);
  assert.equal(lessonManager.lessonsConfig.grade_3_secondary.lessons.some(item => item.id === 'lesson_5'), false);
});
