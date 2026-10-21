import assert from 'node:assert/strict';
import test from 'node:test';
import { config, resolveStudentGrade } from './config.js';
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
import { historyManager } from './history.js';

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

test('student grade defaults to Year 3 Secondary unless another grade is known', () => {
  assert.equal(resolveStudentGrade(), 'grade_3_secondary');
  assert.equal(resolveStudentGrade(null, 'grade_2_secondary'), 'grade_2_secondary');
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

test('incoming images use local Ollama vision when Gemini keys are unavailable', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousVisionModel = config.ollamaVisionModel;
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  config.ollamaVisionModel = 'test-vision-model';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-vision-model');
    assert.deepEqual(body.messages.at(-1).images, [
      Buffer.from('student image').toString('base64')
    ]);
    return {
      ok: true,
      json: async () => ({ message: { content: 'وصلتني الصورة، خلينا نشوفها سوا.' } })
    };
  };

  try {
    assert.equal(await generateClientResponse(
      'vision-fallback-test@s.whatsapp.net',
      'Es Student',
      'ممكن تشرح لي؟',
      [{ data: Buffer.from('student image'), mimeType: 'image/jpeg' }]
    ), 'وصلتني الصورة، خلينا نشوفها سوا.');
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    config.ollamaVisionModel = previousVisionModel;
    globalThis.fetch = previousFetch;
  }
});

test('payment questions receive the configured price and requested Bankak details', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages.find(message => message.role === 'user').content;
    assert.match(prompt, /If the student asks how much the course costs, give the applicable monthly price above/i);
    assert.match(prompt, /17,000 Sudanese pounds \(SDG\)/);
    assert.match(prompt, /Bankak\) account number 2865022/i);
    assert.match(prompt, /Mazen Mohammed Ahmed Al-Siddiq Saleh/i);
    assert.match(prompt, /If they ask for both, provide both/i);
    assert.match(prompt, /Do not bring up fees, payment, or payment details unless the student asks/i);
    assert.match(prompt, /كم رسوم الاشتراك ورقم حساب بنكك؟/);
    return {
      ok: true,
      json: async () => ({ message: { content: 'الاشتراك ١٧ ألف جنيه شهرياً. رقم حساب بنكك 2865022 باسم مازن محمد أحمد الصديق صالح.' } })
    };
  };

  try {
    assert.match(
      await generateClientResponse(
        '249111111111@s.whatsapp.net',
        'Es Student',
        'كم رسوم الاشتراك ورقم حساب بنكك؟',
        [],
        'grade_3_secondary'
      ),
      /2865022/
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
    assert.deepEqual(body.format, {
      type: 'object',
      properties: {
        isTaskSubmission: { type: 'boolean' },
        allCorrect: { type: 'boolean' }
      },
      required: ['isTaskSubmission', 'allCorrect'],
      additionalProperties: false
    });
    assert.deepEqual(body.options, { num_predict: 128 });
    return {
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            isTaskSubmission: true,
            allCorrect: false
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
      feedback: 'One or more answers need correction. Try again.'
    });
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});

test('task grading accepts a single-word answer as a complete submission', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.messages.some(message =>
      message.role === 'user' &&
      message.content.includes('A one-word answer can be complete')));
    assert.ok(body.messages.some(message =>
      message.role === 'user' &&
      message.content.includes('Judge meaning and the grammar being tested, not exact wording')));
    assert.ok(body.messages.some(message =>
      message.role === 'user' &&
      message.content.includes('Accept correct paraphrases, synonyms, valid equivalent forms')));
    assert.ok(body.messages.some(message =>
      message.role === 'user' && message.content.includes('interprets')));
    return {
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            isTaskSubmission: true,
            allCorrect: true
          })
        }
      })
    };
  };

  try {
    assert.deepEqual(await evaluateStudentTask({
      title: 'Present Simple',
      taskMessage: 'Complete the sentence: The analyst ____ the results. (interpret)',
      answerKey: ['interprets']
    }, 'interprets'), {
      isTaskSubmission: true,
      allCorrect: true,
      feedback: 'Correct.'
    });
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});

test('task grading gives short feedback in the submitted language', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: JSON.stringify({
          isTaskSubmission: true,
          allCorrect: false
        })
      }
    })
  });

  try {
    const result = await evaluateStudentTask({
      title: 'Present Simple',
      taskMessage: 'أكمل الجملة.',
      answerKey: ['goes']
    }, 'الإجابة غلط');
    assert.equal(result.feedback, 'في إجابة محتاجة تصحيح. حاول تاني.');
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
  }
});

test('task grading refuses to use an unconfigured answer key', async () => {
  await assert.rejects(evaluateStudentTask({
    title: 'Unconfigured lesson',
    taskMessage: 'Answer the question.',
    answerKey: []
  }, 'An answer'), /without configured questions and an answer key/);
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

test('returning student prompt explicitly forbids asking for grade or stage', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  const jid = 'returning-student-check@s.whatsapp.net';
  historyManager.history[jid] = [
    { role: 'client', text: 'السلام عليكم يا مستر مازن' },
    { role: 'agent', text: 'و عليكم السلام ورحمة الله وبركاته، مرحب بيك يا بطل' }
  ];

  let interceptedPrompt = '';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    interceptedPrompt = body.messages.find(m => m.role === 'user').content;
    return {
      ok: true,
      json: async () => ({ message: { content: 'أهلاً بيك يا غالي' } })
    };
  };

  try {
    const reply = await generateClientResponse(
      jid,
      'Ahmed',
      'كيفك يا مستر؟ جاهز للمذاكرة اليوم',
      [],
      null,
      false,
      false,
      null,
      null,
      null,
      true
    );
    assert.equal(reply, 'أهلاً بيك يا غالي');
    assert.match(interceptedPrompt, /=== STUDENT RELATIONSHIP: RETURNING STUDENT/);
    assert.match(interceptedPrompt, /ممنوع منعاً باتاً سؤالهم عن صفهم أو مرحلتهم الدراسية/);
    assert.match(interceptedPrompt, /NEVER ask a returning student or anyone with prior conversation history about their grade or stage/);
    assert.doesNotMatch(interceptedPrompt, /=== FIRST-REPLY LESSON ONBOARDING ===/);
    assert.doesNotMatch(interceptedPrompt, /=== NEW STUDENT WELCOME ===/);
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
    delete historyManager.history[jid];
  }
});

test('new student AI context uses the default grade without asking for it', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  const jid = 'default-grade-student@s.whatsapp.net';
  let interceptedPrompt = '';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    interceptedPrompt = body.messages.find(message => message.role === 'user').content;
    return {
      ok: true,
      json: async () => ({ message: { content: 'أهلاً بيك' } })
    };
  };

  try {
    await generateClientResponse(jid, 'New Student', 'السلام عليكم');
    assert.match(interceptedPrompt, /Assigned Grade \/ Stage: grade_3_secondary/);
    assert.match(interceptedPrompt, /=== YEAR 3 SECONDARY ENGLISH CURRICULUM ===/);
    assert.match(interceptedPrompt, /If their grade is known, do not ask a question/);
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
    delete historyManager.history[jid];
  }
});

test('AI prompt restores conversation context from both linked phone and LID histories', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  const phoneJid = '249000000040@s.whatsapp.net';
  const lidJid = '100000000000040@lid';
  const previousPhoneContact = historyManager.contacts[phoneJid];
  const previousLidContact = historyManager.contacts[lidJid];
  const previousPhoneHistory = historyManager.history[phoneJid];
  const previousLidHistory = historyManager.history[lidJid];
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  historyManager.contacts[phoneJid] = { jid: phoneJid, phoneJid, name: 'Student Es', isEs: true };
  historyManager.contacts[lidJid] = { jid: lidJid, phoneJid, name: 'Student Es', isEs: true };
  historyManager.history[phoneJid] = [
    { id: 'phone-old', role: 'client', text: 'I am studying grade three secondary.', timestamp: 1_700_000_000_000 },
    { id: 'phone-reply', role: 'agent', text: 'We practiced the past tense last week.', timestamp: 1_700_000_001_000 }
  ];
  historyManager.history[lidJid] = [
    { id: 'lid-latest', role: 'client', text: 'I got the last exercise wrong.', timestamp: 1_700_000_002_000 }
  ];

  let interceptedPrompt = '';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    interceptedPrompt = body.messages.find(message => message.role === 'user').content;
    return {
      ok: true,
      json: async () => ({ message: { content: 'Let’s review the exercise together.' } })
    };
  };

  try {
    const reply = await generateClientResponse(
      lidJid,
      'Student Es',
      'I got the last exercise wrong.',
      [],
      null,
      false,
      false,
      phoneJid
    );
    assert.equal(reply, 'Let’s review the exercise together.');
    assert.ok(interceptedPrompt.indexOf('I am studying grade three secondary.') <
      interceptedPrompt.indexOf('We practiced the past tense last week.'));
    assert.ok(interceptedPrompt.indexOf('We practiced the past tense last week.') <
      interceptedPrompt.indexOf('I got the last exercise wrong.'));
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
    if (previousPhoneContact) historyManager.contacts[phoneJid] = previousPhoneContact;
    else delete historyManager.contacts[phoneJid];
    if (previousLidContact) historyManager.contacts[lidJid] = previousLidContact;
    else delete historyManager.contacts[lidJid];
    if (previousPhoneHistory) historyManager.history[phoneJid] = previousPhoneHistory;
    else delete historyManager.history[phoneJid];
    if (previousLidHistory) historyManager.history[lidJid] = previousLidHistory;
    else delete historyManager.history[lidJid];
  }
});

test('new student without known grade is asked for stage while returning student is not', async () => {
  const previousKeys = [...config.geminiApiKeys];
  const previousFetch = globalThis.fetch;
  config.geminiApiKeys.splice(0, config.geminiApiKeys.length);
  const newJid = 'brand-new-student@s.whatsapp.net';
  delete historyManager.history[newJid];

  let interceptedPrompt = '';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    interceptedPrompt = body.messages.find(m => m.role === 'user').content;
    return {
      ok: true,
      json: async () => ({ message: { content: 'أهلاً بيك' } })
    };
  };

  try {
    // New student first message
    await generateClientResponse(
      newJid,
      'New Student',
      'السلام عليكم',
      [],
      null,
      false,
      false,
      null,
      null,
      null,
      false
    );
    assert.match(interceptedPrompt, /ask only which grade and stage they are in/i);
    assert.doesNotMatch(interceptedPrompt, /RETURNING STUDENT/);
  } finally {
    config.geminiApiKeys.splice(0, config.geminiApiKeys.length, ...previousKeys);
    globalThis.fetch = previousFetch;
    delete historyManager.history[newJid];
  }
});
