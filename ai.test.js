import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import {
  generateWithTransientRetry,
  generateClientResponse,
  generateStudentFollowUp,
  getStudentPricingContext,
  getGradeCurriculumKnowledge,
  shouldUseEnglishLessonOnboarding
} from './ai.js';
import { evaluateStudentTask } from './task_evaluator.js';

test('English lesson onboarding is only used before the first agent reply', () => {
  assert.equal(shouldUseEnglishLessonOnboarding([]), true);
  assert.equal(shouldUseEnglishLessonOnboarding([{ role: 'client', text: 'Hello' }]), true);
  assert.equal(shouldUseEnglishLessonOnboarding([
    { role: 'client', text: 'Hello' },
    { role: 'agent', text: 'May I send you a lesson now?' }
  ]), false);
});

test('Year 3 Secondary AI context contains the requested English curriculum', () => {
  const curriculum = getGradeCurriculumKnowledge('grade_3_secondary');

  for (const topic of [
    'SPINE 6',
    'Treasure Island',
    'Present perfect continuous',
    'Passive voice',
    'First conditional',
    'Second conditional',
    'Third conditional',
    'Indirect (reported) speech',
    'Gerunds and infinitives',
    'Summary writing',
    'Composition writing',
    'Letter writing'
  ]) {
    assert.ok(curriculum.includes(topic), `Curriculum reference should include ${topic}`);
  }
});

test('Year 3 Secondary curriculum is not added to other students', () => {
  assert.equal(getGradeCurriculumKnowledge('grade_2_secondary'), '');
  assert.equal(getGradeCurriculumKnowledge(null), '');
});

test('student pricing uses the WhatsApp country calling code', () => {
  assert.match(
    getStudentPricingContext('249111111111@s.whatsapp.net'),
    /17,000 Sudanese pounds \(SDG\)/
  );
  for (const [countryCode, country] of [
    ['965', 'Kuwait'],
    ['966', 'Saudi Arabia'],
    ['968', 'Oman'],
    ['971', 'UAE'],
    ['973', 'Bahrain'],
    ['974', 'Qatar']
  ]) {
    assert.match(
      getStudentPricingContext(`${countryCode}111111111@s.whatsapp.net`),
      /52,000 Sudanese pounds \(SDG\)/,
      `${country} should use the Gulf price`
    );
  }
  assert.match(
    getStudentPricingContext('14155550123@s.whatsapp.net'),
    /27,000 Sudanese pounds \(SDG\)/
  );
  assert.match(
    getStudentPricingContext('12345@lid', '966111111111@s.whatsapp.net'),
    /52,000 Sudanese pounds \(SDG\)/
  );
});

test('transient Gemini service errors are retried once', async () => {
  let attempts = 0;
  let waitedMs = 0;
  const result = await generateWithTransientRetry(async () => {
    attempts++;
    if (attempts === 1) throw new Error('[503 Service Unavailable] model is busy');
    return 'reply';
  }, async ms => { waitedMs += ms; });

  assert.equal(result, 'reply');
  assert.equal(attempts, 2);
  assert.equal(waitedMs, 1500);
});

test('permanent Gemini request errors are not retried', async () => {
  let attempts = 0;
  await assert.rejects(generateWithTransientRetry(async () => {
    attempts++;
    throw new Error('[400 Bad Request] invalid request');
  }, async () => {}), /400 Bad Request/);
  assert.equal(attempts, 1);
});

test('student follow-ups use the local model when no Gemini keys are configured', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, config.ollamaModel);
    return {
      ok: true,
      json: async () => ({ message: { content: 'كيف ماشي معاك الإنجليزي؟' } })
    };
  };

  try {
    assert.equal(
      await generateStudentFollowUp('249111111111@s.whatsapp.net', 'Student'),
      'كيف ماشي معاك الإنجليزي؟'
    );
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});

test('incoming text gets a local response when Gemini keys are unavailable', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, config.ollamaModel);
    assert.ok(body.messages.some(message =>
      message.role === 'user' && message.content.includes('Hello, I need help with English.')));
    assert.ok(body.messages.some(message =>
      message.role === 'user' && message.content.includes('The student has agreed to receive a lesson')));
    assert.ok(body.messages.some(message =>
      message.role === 'user' && message.content.includes('17,000 Sudanese pounds (SDG)')));
    assert.ok(body.messages.some(message =>
      message.role === 'user' && message.content.includes('currently working on "Present Simple: Adding -s"')));
    return {
      ok: true,
      json: async () => ({ message: { content: 'Of course, what would you like help with?' } })
    };
  };

  try {
    assert.equal(
      await generateClientResponse(
        '249111111111@s.whatsapp.net',
        'Es Student',
        'Hello, I need help with English.',
        [],
        'grade_3_secondary',
        true,
        true,
        null,
        'Present Simple: Adding -s'
      ),
      'Of course, what would you like help with?'
    );
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});

test('task grading uses local Ollama and requests JSON when Gemini keys are unavailable', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.format, 'json');
    return {
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            isTaskSubmission: true,
            allCorrect: false,
            feedback: 'شغلك كويس، راجع السؤال الثاني.'
          })
        }
      })
    };
  };

  try {
    assert.deepEqual(await evaluateStudentTask({
      title: 'Simple present',
      taskMessage: 'Answer the questions.',
      answerKey: ['goes']
    }, 'He go to school.'), {
      isTaskSubmission: true,
      allCorrect: false,
      feedback: 'شغلك كويس، راجع السؤال الثاني.'
    });
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});
