import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import {
  generateWithTransientRetry,
  generateClientResponse,
  generateStudentFollowUp,
  getStudentPricingContext,
  getGradeCurriculumKnowledge,
  shouldUseEnglishLessonOnboarding,
  sanitizeClientResponseText
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

test('new-student welcome prompts ask for grade or announce only an available sample', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  let expectedPromptSection = '';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.messages.some(message =>
      message.role === 'user' && message.content.includes(expectedPromptSection)));
    assert.ok(!body.messages.some(message =>
      message.role === 'user' && message.content.includes('May I send you a lesson now?')));
    return {
      ok: true,
      json: async () => ({ message: { content: 'Welcome!' } })
    };
  };

  try {
    expectedPromptSection = 'their grade is not known yet';
    assert.equal(await generateClientResponse(
      'new-welcome-test@s.whatsapp.net', 'New Student', 'Hello', [], null, false, false, null, null, 'ask_grade'
    ), 'Welcome!');
    expectedPromptSection = 'matching sample content';
    assert.equal(await generateClientResponse(
      'sample-welcome-test@s.whatsapp.net', 'New Student', 'I am in Year 3 Secondary', [], 'grade_3_secondary',
      false, false, null, null, 'sample'
    ), 'Welcome!');
    expectedPromptSection = 'no configured sample lesson';
    assert.equal(await generateClientResponse(
      'unavailable-welcome-test@s.whatsapp.net', 'New Student', 'I am in Year 2 Secondary', [],
      'grade_2_secondary', false, false, null, null, 'unavailable'
    ), 'Welcome!');
    expectedPromptSection = 'matching sample lesson, but it will not be sent';
    assert.equal(await generateClientResponse(
      'deferred-welcome-test@s.whatsapp.net', 'New Student', 'Please check this exercise', [],
      'grade_3_secondary', false, false, null, null, 'deferred'
    ), 'Welcome!');
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});

test('first replies greet and ask only for grade when unknown, never about problems or lesson permission', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  const promptContents = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    promptContents.push(body.messages.map(message => message.content).join('\n'));
    return {
      ok: true,
      json: async () => ({ message: { content: 'Welcome!' } })
    };
  };

  try {
    await generateClientResponse(
      'first-reply-grade-unknown@s.whatsapp.net', 'New Student', 'السلام عليكم', [], null
    );
    await generateClientResponse(
      'first-reply-grade-known@s.whatsapp.net', 'New Student', 'أهلاً، أنا في الصف الثالث الثانوي', [], 'grade_3_secondary',
      true
    );
    assert.match(promptContents[0], /Sudanese Arabic if they wrote in Arabic, and English only if they wrote in English/i);
    assert.match(promptContents[0], /ask only which grade and stage/i);
    assert.match(promptContents[0], /Never ask permission to send lessons or ask about their English difficulties/);
    assert.match(promptContents[1], /The student's grade is known, and the app will send the matching lesson video and exercise/);
    for (const prompt of promptContents) {
      assert.match(prompt, /Match the language of the student's latest message/);
      assert.match(prompt, /For an Arabic message, reply in natural Sudanese Arabic\. Use English only when the student wrote in English/);
      assert.doesNotMatch(prompt, /What is the biggest difficulty you face in English\?/);
      assert.doesNotMatch(prompt, /May I send you a lesson now\?/);
    }
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});

test('system instructions require Sudanese Arabic for Arabic messages and English only for English messages', () => {
  const systemPrompt = config.getSystemPrompt();
  assert.match(systemPrompt, /إذا كتب بالعربية، رد باللهجة السودانية فقط/);
  assert.match(systemPrompt, /استخدم الإنجليزية فقط عندما تكون رسالة الطالب بالإنجليزية/);
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
    assert.doesNotMatch(
      JSON.stringify(body.messages),
      /Ask one thoughtful question|past English-learning difficulty/
    );
    return {
      ok: true,
      json: async () => ({ message: { content: 'أهلاً بيك، مستمرين مع بعض في دروس الإنجليزي إن شاء الله.' } })
    };
  };

  try {
    assert.equal(
      await generateStudentFollowUp('249111111111@s.whatsapp.net', 'Student'),
      'أهلاً بيك، مستمرين مع بعض في دروس الإنجليزي إن شاء الله.'
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
      message.role === 'user' && message.content.includes('The student\'s grade is known, and the app will send the matching lesson video and exercise')));
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

test('sanitizes bracketed video and exercise placeholders from AI response text', () => {
  assert.equal(
    sanitizeClientResponseText('أهلاً بيك يا وعد! [فيديو الشرح] بالتوفيق إن شاء الله'),
    'أهلاً بيك يا وعد!  بالتوفيق إن شاء الله'
  );
  assert.equal(
    sanitizeClientResponseText('حاضر من عيوني [يتم إرسال الفيديو] شوفي وقولي لي رأيك'),
    'حاضر من عيوني  شوفي وقولي لي رأيك'
  );
  assert.equal(
    sanitizeClientResponseText('تمام يا مازن [أرسل هنا التمارين الخاصة بالدرس]'),
    'تمام يا مازن'
  );
  assert.equal(
    sanitizeClientResponseText('[فيديو الشرح]'),
    ''
  );
});
