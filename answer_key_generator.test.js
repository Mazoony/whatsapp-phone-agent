import assert from 'node:assert/strict';
import test from 'node:test';
import { generateLessonAnswerKey } from './answer_key_generator.js';

test('answer-key generation returns one reviewed draft entry per numbered exercise question', async () => {
  const task = '1. She ____ (go) to school.\n2. They ____ (play) football.';
  let prompt = '';
  const result = await generateLessonAnswerKey(task, 'Use the present simple.', {
    generateContent: async value => {
      prompt = value;
      return JSON.stringify({
        answers: [
          {
            answer: 'goes',
            acceptedAlternatives: [],
            explanation: 'A singular subject takes -es here.',
            confidence: 'high'
          },
          {
            answer: 'play',
            acceptedAlternatives: ['are playing'],
            explanation: 'Accept the simple form; check the intended tense.',
            confidence: 'medium'
          }
        ]
      });
    }
  });

  assert.match(prompt, /Use the present simple/);
  assert.match(prompt, /exactly 2 numbered questions/);
  assert.deepEqual(result, {
    answers: [
      {
        questionNumber: 1,
        answer: 'goes',
        explanation: 'A singular subject takes -es here.',
        confidence: 'high'
      },
      {
        questionNumber: 2,
        answer: 'play (also accept: are playing)',
        explanation: 'Accept the simple form; check the intended tense.',
        confidence: 'medium'
      }
    ]
  });
});

test('answer-key generation rejects missing questions, malformed results, and non-consecutive numbering', async () => {
  await assert.rejects(
    generateLessonAnswerKey(' \n', '', { generateContent: async () => '{}' }),
    /Add the lesson questions/
  );
  await assert.rejects(
    generateLessonAnswerKey('1. First\n3. Third', '', { generateContent: async () => '{}' }),
    /run consecutively/
  );
  await assert.rejects(
    generateLessonAnswerKey('1. One\n2. Two', '', {
      generateContent: async () => JSON.stringify({
        answers: [{
          answer: 'one',
          acceptedAlternatives: [],
          explanation: 'Answer',
          confidence: 'high'
        }]
      })
    }),
    /exactly one answer per question/
  );
});
