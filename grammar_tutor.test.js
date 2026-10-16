import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GRAMMAR_CURRICULUM,
  GrammarTutor,
  isGrammarCourseStartRequest,
  parseNumberedAnswers
} from './grammar_tutor.js';

function withTutor(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grammar-tutor-'));
  const tutor = new GrammarTutor({
    progressFile: path.join(directory, 'progress.json'),
    sendText: async (sock, jid, text) => sock.sendMessage(jid, { text })
  });
  const sent = [];
  const sock = { sendMessage: async (jid, message) => sent.push({ jid, ...message }) };
  return Promise.resolve(run({ tutor, sock, sent, directory })).finally(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

test('grammar course start request is explicit and recognized in English and Arabic', () => {
  assert.equal(isGrammarCourseStartRequest('Please start the English grammar course'), true);
  assert.equal(isGrammarCourseStartRequest('I want grammar lessons'), true);
  assert.equal(isGrammarCourseStartRequest('عايز أبدأ قواعد الإنجليزي'), true);
  assert.equal(isGrammarCourseStartRequest('How much is the monthly fee?'), false);
});

test('curriculum lessons each contain ten structured exercises and a valid sequence', () => {
  const lessons = Object.values(GRAMMAR_CURRICULUM);
  assert.equal(lessons.length, 20);
  assert.ok(lessons.every(item =>
    item.exercises.length === 10 &&
    item.answer_key.length === 10 &&
    item.rules.length > 0 &&
    item.examples.length >= 2
  ));
  assert.deepEqual(
    lessons.slice(0, -1).map(item => item.next_lesson_id),
    lessons.slice(1).map(item => item.lesson_id)
  );
  assert.equal(lessons.at(-1).next_lesson_id, null);
});

test('numbered answer parser extracts answers and flags missing or invalid numbers', () => {
  assert.deepEqual(parseNumberedAnswers('1. studies\n2) reads\n10: goes'), {
    answers: { 1: 'studies', 2: 'reads', 10: 'goes' },
    invalidNumbers: []
  });
  assert.deepEqual(parseNumberedAnswers('1. plays\n11. jumps'), {
    answers: { 1: 'plays' },
    invalidNumbers: [11]
  });
  assert.deepEqual(parseNumberedAnswers('plays, reads'), {
    answers: {},
    invalidNumbers: []
  });
});

test('course asks for secondary grade, sends explanation before exercises, and saves progress', async () => {
  await withTutor(async ({ tutor, sock, sent }) => {
    assert.equal(await tutor.handleMessage(sock, '249111111111@s.whatsapp.net', 'Start grammar course'), true);
    assert.equal(tutor.getStudent('249111111111@s.whatsapp.net').status, 'awaiting_grade');
    assert.equal(sent.length, 1);

    await tutor.handleMessage(
      sock,
      '249111111111@s.whatsapp.net',
      'I am in Year 2 Secondary',
      'grade_2_secondary'
    );
    assert.equal(sent.length, 3);
    assert.match(sent[1].text, /Present Simple: Adding -s/);
    assert.match(sent[1].text, /Examples:/);
    assert.match(sent[2].text, /Practice — 10 questions/);
    assert.equal((sent[2].text.match(/^\d+\./gm) || []).length, 10);
    assert.equal(tutor.getStudent('249111111111@s.whatsapp.net').gradeKey, 'grade_2_secondary');
  });
});

test('course records partial answers, requests missing questions, and advances after correction', async () => {
  await withTutor(async ({ tutor, sock, sent }) => {
    const jid = '249111111112@s.whatsapp.net';
    await tutor.start(sock, jid, 'grade_3_secondary');
    await tutor.handleMessage(sock, jid, '1. play\n2. reads');
    assert.equal(tutor.getStudent(jid).status, 'awaiting_answers');
    assert.equal(Object.keys(tutor.getStudent(jid).answers).length, 2);
    assert.match(sent.at(-1).text, /Please complete: 3, 4, 5, 6, 7, 8, 9, 10/);

    const rest = GRAMMAR_CURRICULUM['present-s'].answer_key.slice(2)
      .map(item => `${item.question_id}. ${item.accepted_answers[0]}`).join('\n');
    await tutor.handleMessage(sock, jid, rest);
    assert.equal(tutor.getStudent(jid).status, 'awaiting_retry');
    assert.deepEqual(tutor.getStudent(jid).incorrectQuestionIds, [1]);
    assert.equal(tutor.getStudent(jid).currentScore, 9);
    assert.deepEqual(tutor.getStudent(jid).conceptsNeedingRevision, ['present-s']);
    assert.match(sent.at(-1).text, /correct answer is \*plays\*/);

    await tutor.handleMessage(sock, jid, '1. plays');
    assert.equal(tutor.getStudent(jid).currentLessonId, 'present-es');
    assert.ok(tutor.getStudent(jid).completedLessonIds.includes('present-s'));
    assert.equal(tutor.getStudent(jid).status, 'awaiting_answers');
    assert.equal(tutor.getStudent(jid).currentScore, 0);
    assert.deepEqual(tutor.getStudent(jid).conceptsNeedingRevision, []);
    assert.match(sent.at(-2).text, /Present Simple: Adding -es/);
  });
});

test('course asks for numbered clarification instead of guessing an unstructured answer', async () => {
  await withTutor(async ({ tutor, sock, sent }) => {
    const jid = '249111111113@s.whatsapp.net';
    await tutor.start(sock, jid, 'grade_1_secondary');
    assert.equal(await tutor.handleMessage(sock, jid, 'plays, reads'), true);
    assert.match(sent.at(-1).text, /send answers with question numbers/);
    assert.equal(Object.keys(tutor.getStudent(jid).answers).length, 0);
  });
});

test('course refuses to change grade without teacher confirmation', async () => {
  await withTutor(async ({ tutor, sock, sent }) => {
    const jid = '249111111114@s.whatsapp.net';
    await tutor.start(sock, jid, 'grade_1_secondary');
    await tutor.start(sock, jid, 'grade_2_secondary');
    assert.equal(tutor.getStudent(jid).gradeKey, 'grade_1_secondary');
    assert.match(sent.at(-1).text, /different grade/);
  });
});
