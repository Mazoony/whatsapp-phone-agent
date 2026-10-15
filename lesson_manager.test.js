import assert from 'node:assert/strict';
import test from 'node:test';
import { lessonManager } from './lesson_manager.js';

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
    ['ثالثة ثانوي', 'grade_3_secondary']
  ];

  for (const [message, expectedGrade] of cases) {
    assert.equal(lessonManager.detectGrade(message), expectedGrade, message);
  }
});

test('does not guess a stage when a student only gives a grade number', () => {
  assert.equal(lessonManager.detectGrade('أنا في الصف الثاني'), null);
  assert.equal(lessonManager.detectGrade('أنا في تالتة'), null);
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
