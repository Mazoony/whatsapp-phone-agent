import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { generateWithTransientRetry } from './ai.js';
import { generateLocalResponse } from './local_ai.js';

const genAIClients = new Map();
const MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];
const MAX_QUESTIONS = 50;

const ANSWER_KEY_FORMAT = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          acceptedAlternatives: { type: 'array', items: { type: 'string' } },
          explanation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: ['answer', 'acceptedAlternatives', 'explanation', 'confidence'],
        additionalProperties: false
      }
    }
  },
  required: ['answers'],
  additionalProperties: false
};

function getGenAI(apiKey) {
  if (!genAIClients.has(apiKey)) {
    genAIClients.set(apiKey, new GoogleGenerativeAI(apiKey));
  }
  return genAIClients.get(apiKey);
}

function parseQuestionCount(taskMessage) {
  const numberedQuestions = [...taskMessage.matchAll(/^\s*(\d{1,2})[.)]\s+/gm)]
    .map(match => Number(match[1]));
  if (!numberedQuestions.length) return null;
  const uniqueNumbers = [...new Set(numberedQuestions)];
  if (uniqueNumbers.length > MAX_QUESTIONS ||
      uniqueNumbers.some((number, index) => number !== index + 1)) {
    throw new Error(`Numbered questions must run consecutively from 1 to ${MAX_QUESTIONS}.`);
  }
  return uniqueNumbers.length;
}

function parseAnswerKeyResponse(rawText, expectedCount) {
  const cleaned = String(rawText || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('The AI returned an unreadable answer-key draft. Please try again.');
  }

  if (!Array.isArray(parsed?.answers) ||
      parsed.answers.length === 0 ||
      parsed.answers.length > MAX_QUESTIONS ||
      (expectedCount !== null && parsed.answers.length !== expectedCount)) {
    throw new Error('The AI answer-key draft did not include exactly one answer per question.');
  }

  const answers = parsed.answers.map((item, index) => {
    const answer = typeof item?.answer === 'string' ? item.answer.trim() : '';
    const acceptedAlternatives = Array.isArray(item?.acceptedAlternatives)
      ? item.acceptedAlternatives.filter(value => typeof value === 'string')
        .map(value => value.trim()).filter(Boolean)
      : null;
    const explanation = typeof item?.explanation === 'string' ? item.explanation.trim() : '';
    const confidence = item?.confidence;
    if (!answer || acceptedAlternatives === null || !explanation ||
        !['high', 'medium', 'low'].includes(confidence)) {
      throw new Error(`The AI returned an incomplete answer-key draft for question ${index + 1}.`);
    }
    const answerText = acceptedAlternatives.length
      ? `${answer} (also accept: ${acceptedAlternatives.join('; ')})`
      : answer;
    return {
      questionNumber: index + 1,
      answer: answerText,
      explanation,
      confidence
    };
  });
  return answers;
}

export async function generateLessonAnswerKey(taskMessage, notes = '', { generateContent } = {}) {
  if (typeof taskMessage !== 'string' || !taskMessage.trim()) {
    throw new Error('Add the lesson questions before generating answer keys.');
  }
  if (taskMessage.length > 12_000) {
    throw new Error('The lesson questions are too long to generate answer keys.');
  }
  if (typeof notes !== 'string' || notes.length > 8_000) {
    throw new Error('Supporting notes must be 8,000 characters or fewer.');
  }

  const expectedCount = parseQuestionCount(taskMessage);
  const prompt = `You are helping an English teacher draft an answer key for their lesson exercise.
Solve every question in order. Never invent missing context or present a guess as certain.
Return one answer for each question. Include only genuinely valid alternatives, and provide a brief explanation useful to the teacher.
Set confidence to "low" whenever the question is ambiguous, depends on missing information, or cannot be answered reliably; explain why in that entry.
The teacher will review and edit every answer before using it. Do not include question text in the answer.
${expectedCount === null ? 'Infer the number of questions from the exercise.' : `There are exactly ${expectedCount} numbered questions; return exactly ${expectedCount} answers in order.`}

SUPPORTING NOTES FROM THE TEACHER:
${notes.trim() || '(No additional notes provided)'}

LESSON EXERCISE:
${taskMessage.trim()}

Return only JSON matching this shape:
{"answers":[{"answer":"...","acceptedAlternatives":[],"explanation":"...","confidence":"high"}]}`;

  if (typeof generateContent === 'function') {
    return { answers: parseAnswerKeyResponse(await generateContent(prompt), expectedCount) };
  }

  let lastError = null;
  for (const [keyIndex, apiKey] of config.geminiApiKeys.entries()) {
    for (const modelName of MODELS) {
      try {
        const model = getGenAI(apiKey).getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: ANSWER_KEY_FORMAT
          }
        });
        const result = await generateWithTransientRetry(() => model.generateContent(prompt));
        const answers = parseAnswerKeyResponse(result.response.text(), expectedCount);
        if (keyIndex > 0) {
          console.log(`[Answer Key] Used API key ${keyIndex + 1} for lesson answer generation.`);
        }
        return { answers };
      } catch (error) {
        lastError = error;
        console.warn(`[Answer Key Warning] Model ${modelName} with API key ${keyIndex + 1} failed:`, error.message);
      }
    }
  }

  try {
    const rawText = await generateLocalResponse(prompt, {
      systemInstruction: 'Draft a correct lesson answer key. Return only valid JSON matching the requested shape.',
      format: ANSWER_KEY_FORMAT,
      numPredict: 4096
    });
    return { answers: parseAnswerKeyResponse(rawText, expectedCount) };
  } catch (localError) {
    console.error('[Answer Key Error] Gemini and local AI failed:', localError.message, lastError?.message || '');
    throw new Error(`Could not generate an answer-key draft: ${localError.message}`);
  }
}
