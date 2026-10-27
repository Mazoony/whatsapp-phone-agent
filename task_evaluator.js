import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { generateWithTransientRetry } from './ai.js';
import { generateLocalResponse } from './local_ai.js';

const genAIClients = new Map();
function getGenAI(apiKey) {
  if (!genAIClients.has(apiKey)) {
    genAIClients.set(apiKey, new GoogleGenerativeAI(apiKey));
  }
  return genAIClients.get(apiKey);
}

const MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];
const TASK_EVALUATION_FORMAT = {
  type: 'object',
  properties: {
    isTaskSubmission: { type: 'boolean' },
    allCorrect: { type: 'boolean' },
    answeredQuestionNumbers: { type: 'array', items: { type: 'integer' } },
    correctQuestionNumbers: { type: 'array', items: { type: 'integer' } },
    incorrectAnswers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          questionNumber: { type: 'integer' },
          studentAnswer: { type: 'string' },
          explanation: { type: 'string' }
        },
        required: ['questionNumber', 'studentAnswer', 'explanation'],
        additionalProperties: false
      }
    }
  },
  required: [
    'isTaskSubmission',
    'allCorrect',
    'answeredQuestionNumbers',
    'correctQuestionNumbers',
    'incorrectAnswers'
  ],
  additionalProperties: false
};

function getTaskFeedback(isTaskSubmission, allCorrect) {
  if (!isTaskSubmission) return '';
  return allCorrect
    ? 'صحيح، ممتاز.'
    : 'في إجابة محتاجة تصحيح. حاول تاني.';
}

/**
 * Evaluates student's task submission using Gemini.
 * Returns structured feedback and progression status.
 * 
 * @param {object} lesson The lesson object containing taskMessage and answerKey
 * @param {string} studentSubmission The message sent by the student
 * @param {string} studentName The student's name
 * @param {object} options Optional pending question numbers for partial corrections
 * @returns {Promise<{ isTaskSubmission: boolean, allCorrect: boolean, answeredQuestionNumbers: number[], correctQuestionNumbers: number[], incorrectAnswers: { questionNumber: number, studentAnswer: string }[], feedback: string }>}
 */
export async function evaluateStudentTask(
  lesson,
  studentSubmission,
  studentName = 'الطالب',
  { pendingQuestionNumbers } = {}
) {
  if (typeof studentSubmission !== 'string' || !studentSubmission.trim()) {
    return {
      isTaskSubmission: false,
      allCorrect: false,
      answeredQuestionNumbers: [],
      correctQuestionNumbers: [],
      incorrectAnswers: [],
      feedback: ''
    };
  }
  if (typeof lesson?.taskMessage !== 'string' || !lesson.taskMessage.trim() ||
      !Array.isArray(lesson.answerKey) || lesson.answerKey.length === 0) {
    throw new Error('Cannot grade a lesson without configured questions and an answer key.');
  }
  const pending = Array.isArray(pendingQuestionNumbers)
    ? [...new Set(pendingQuestionNumbers.filter(number =>
        Number.isInteger(number) && number >= 1 && number <= lesson.answerKey.length))]
    : lesson.answerKey.map((_, index) => index + 1);
  if (pending.length === 0) {
    return {
      isTaskSubmission: false,
      allCorrect: false,
      answeredQuestionNumbers: [],
      correctQuestionNumbers: [],
      incorrectAnswers: [],
      feedback: ''
    };
  }
  const pendingAnswers = pending.map(questionNumber => ({
    questionNumber,
    expectedAnswer: lesson.answerKey[questionNumber - 1]
  }));

  const prompt = `
You are an encouraging Sudanese English teacher. Mark ${studentName}'s attempt using this lesson:
QUESTIONS: ${lesson.taskMessage}
PENDING ANSWERS: ${JSON.stringify(pendingAnswers)}
STUDENT: "${studentSubmission}"

Only grade answers in the student's latest message; previously accepted answers are not part of this message. If the message is unrelated to this exercise, return isTaskSubmission=false and empty arrays. Otherwise, identify which pending question numbers the student actually answered. Do not require students to number their answers: infer the question from answer content, task wording, context, and order. When there is only one pending question, match a clear answer to it even if it is unnumbered. For multiple unnumbered answers, match by meaning and order when they clearly fit the remaining questions. If the mapping is genuinely ambiguous, do not guess; leave the ambiguous answer unmatched and do not mark it wrong. Never treat a missing answer as wrong or answered.

Judge meaning and the grammar being tested, not exact wording. Accept correct paraphrases, synonyms, valid equivalent forms, contractions, concise answers, and minor typos that do not change meaning. A one-word answer can be complete. Reject answers that change meaning or use the wrong form when that form is tested. If meaning is ambiguous, do not assume correctness. answeredQuestionNumbers contains only questions answered in this message. correctQuestionNumbers is the subset of those answers that are correct. incorrectAnswers must contain one entry for each answered but incorrect question; studentAnswer must be copied verbatim from the student's latest message as a concise contiguous excerpt, excluding any question-number prefix. explanation must be a concise, accurate explanation in Sudanese Arabic of why the expected answer is correct; do not reveal the expected answer inside explanation because the app supplies it separately. allCorrect is true only when this message answers every question in PENDING ANSWERS and every one is correct.

Return only this JSON shape. Do not generate feedback; the app sends it:
{
  "isTaskSubmission": boolean,
  "allCorrect": boolean,
  "answeredQuestionNumbers": number[],
  "correctQuestionNumbers": number[],
  "incorrectAnswers": [{ "questionNumber": number, "studentAnswer": string, "explanation": string }]
}
`;

  let lastError = null;

  for (const [keyIndex, apiKey] of config.geminiApiKeys.entries()) {
    for (const modelName of MODELS) {
      try {
        const model = getGenAI(apiKey).getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.3, // Low temperature for consistent grading
            responseMimeType: 'application/json'
          }
        });

        const res = await generateWithTransientRetry(() => model.generateContent(prompt));
        const rawText = res.response.text()?.trim();
        const cleaned = rawText.replace(/^```json/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!isValidTaskEvaluation(parsed, lesson.answerKey.length, pending)) {
          throw new Error('Gemini returned task grading in an invalid format.');
        }

        if (keyIndex > 0) {
          console.log(`[Grader] Used API key ${keyIndex + 1} for task evaluation.`);
        }
        return {
          ...parsed,
          feedback: getTaskFeedback(parsed.isTaskSubmission, parsed.allCorrect)
        };
      } catch (err) {
        lastError = err;
        console.warn(`[Grader Warning] Model ${modelName} with API key ${keyIndex + 1} grading failed:`, err.message);
      }
    }
  }

  try {
    const rawText = await generateLocalResponse(prompt, {
      systemInstruction: 'Evaluate the student answer using the provided rubric. Follow the requested JSON format exactly.',
      format: TASK_EVALUATION_FORMAT,
      numPredict: 256
    });
    const parsed = JSON.parse(rawText);
    if (!isValidTaskEvaluation(parsed, lesson.answerKey.length, pending)) {
      throw new Error('Ollama returned task grading in an invalid format.');
    }
    console.log('[Grader] Task evaluated using local Ollama.');
    return {
      ...parsed,
      feedback: getTaskFeedback(parsed.isTaskSubmission, parsed.allCorrect)
    };
  } catch (localError) {
    console.error('[Grader Error] Gemini and local Ollama failed:', localError.message, lastError?.message || '');
    throw new Error(`Could not evaluate the student's task: ${localError.message}`);
  }
}

function isValidTaskEvaluation(result, answerCount, pendingQuestionNumbers) {
  if (typeof result?.isTaskSubmission !== 'boolean' ||
      typeof result?.allCorrect !== 'boolean' ||
      !Array.isArray(result.answeredQuestionNumbers) ||
      !Array.isArray(result.correctQuestionNumbers) ||
      !Array.isArray(result.incorrectAnswers)) {
    return false;
  }
  const pending = new Set(pendingQuestionNumbers);
  const answered = new Set(result.answeredQuestionNumbers);
  const correct = new Set(result.correctQuestionNumbers);
  const incorrect = new Set();
  for (const answer of result.incorrectAnswers) {
    if (!Number.isInteger(answer?.questionNumber) ||
        typeof answer.studentAnswer !== 'string' ||
        !answer.studentAnswer.trim() ||
        typeof answer.explanation !== 'string' ||
        !answer.explanation.trim() ||
        incorrect.has(answer.questionNumber) ||
        !answered.has(answer.questionNumber) ||
        correct.has(answer.questionNumber)) {
      return false;
    }
    incorrect.add(answer.questionNumber);
  }
  return answered.size === result.answeredQuestionNumbers.length &&
    correct.size === result.correctQuestionNumbers.length &&
    [...answered].every(number => Number.isInteger(number) && number >= 1 &&
      number <= answerCount && pending.has(number)) &&
    [...correct].every(number => answered.has(number)) &&
    [...answered].filter(number => !correct.has(number)).every(number => incorrect.has(number));
}
