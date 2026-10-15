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
});
