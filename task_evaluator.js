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
    allCorrect: { type: 'boolean' }
  },
  required: ['isTaskSubmission', 'allCorrect'],
  additionalProperties: false
};

function getTaskFeedback(isTaskSubmission, allCorrect) {
  if (!isTaskSubmission) return '';
  return allCorrect
    ? 'ما شاء الله عليك، إجاباتك كلها صحيحة.'
    : 'شغلك كويس، في إجابة محتاجة مراجعة. ركز في المطلوب وحاول تاني.';
}

/**
 * Evaluates student's task submission using Gemini.
 * Returns structured feedback and progression status.
 * 
 * @param {object} lesson The lesson object containing taskMessage and answerKey
 * @param {string} studentSubmission The message sent by the student
 * @param {string} studentName The student's name
 * @returns {Promise<{ isTaskSubmission: boolean, allCorrect: boolean, feedback: string }>}
 */
export async function evaluateStudentTask(lesson, studentSubmission, studentName = 'الطالب') {
  if (typeof studentSubmission !== 'string' || !studentSubmission.trim()) {
    return { isTaskSubmission: false, allCorrect: false, feedback: '' };
  }
  if (typeof lesson?.taskMessage !== 'string' || !lesson.taskMessage.trim() ||
      !Array.isArray(lesson.answerKey) || lesson.answerKey.length === 0) {
    throw new Error('Cannot grade a lesson without configured questions and an answer key.');
  }

  const prompt = `
You are an encouraging Sudanese English teacher. Mark ${studentName}'s attempt using this lesson:
QUESTIONS: ${lesson.taskMessage}
ANSWER KEY: ${JSON.stringify(lesson.answerKey)}
STUDENT: "${studentSubmission}"

If the message is unrelated to this exercise, return isTaskSubmission=false.
Otherwise compare every answer with its question and the answer key. Judge meaning and the grammar being tested, not exact wording. Accept correct paraphrases, synonyms, valid equivalent forms, contractions, concise answers, and minor typos that do not change meaning. A one-word answer can be complete. Match unnumbered answers in order only when the order is clear. Reject answers that change meaning or use the wrong form when that form is tested. If meaning is ambiguous, do not assume correctness; ask for clarification. allCorrect is true only when every answer is correct.

Return only this JSON shape. Do not generate feedback; the app sends it:
{
  "isTaskSubmission": boolean,
  "allCorrect": boolean
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
        if (typeof parsed.isTaskSubmission !== 'boolean' ||
            typeof parsed.allCorrect !== 'boolean') {
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
      numPredict: 128
    });
    const parsed = JSON.parse(rawText);
    if (typeof parsed.isTaskSubmission !== 'boolean' ||
        typeof parsed.allCorrect !== 'boolean') {
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
