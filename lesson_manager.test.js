import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  hasLessonDeliveryConsent,
  lessonManager,
  resolveLessonVideoPath
} from './lesson_manager.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

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
