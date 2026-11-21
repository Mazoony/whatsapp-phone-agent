import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { generateWithTransientRetry } from './ai.js';
import { generateLocalResponse } from './local_ai.js';
import { getAnswerFreeHint } from './answer_feedback.js';

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
    uncertainQuestionNumbers: { type: 'array', items: { type: 'integer' } },
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
    'uncertainQuestionNumbers',
    'incorrectAnswers'
  ],
  additionalProperties: false
};

function getTaskFeedback(isTaskSubmission, allCorrect, incorrectAnswers = [], answerKey = []) {
  if (!isTaskSubmission) return '';
  if (allCorrect) return 'صحيح، ممتاز.';
  const explanations = incorrectAnswers.map(answer => {
    const parsedAnswer = parseAnswerKey(answerKey[answer.questionNumber - 1]);
    const savedArabicExplanation = /[\u0600-\u06FF]/.test(parsedAnswer.explanation)
      ? parsedAnswer.explanation
      : '';
    const explanation = savedArabicExplanation ||
      (typeof answer.explanation === 'string' ? answer.explanation.trim() : '') ||
      'راجع قاعدة الدرس وحاول تاني.';
    const hint = getAnswerFreeHint(
      [parsedAnswer.expectedAnswer, ...parsedAnswer.acceptedAnswers],
      explanation
    );
    return `السؤال ${answer.questionNumber}: إجابتك محتاجة مراجعة. ${hint}`;
  });
  return explanations.length
    ? explanations.join('\n')
    : 'تمام، حفظت الإجابات الصحيحة. أرسل إجابات الأسئلة الباقية.';
}

/**
 * Evaluates student's task submission using Gemini.
 * Returns structured feedback and progression status.
 * 
 * @param {object} lesson The lesson object containing taskMessage and answerKey
 * @param {string} studentSubmission The message sent by the student
 * @param {string} studentName The student's name
 * @param {object} options Optional pending question numbers for partial corrections
 * @returns {Promise<{ isTaskSubmission: boolean, allCorrect: boolean, answeredQuestionNumbers: number[], correctQuestionNumbers: number[], uncertainQuestionNumbers: number[], incorrectAnswers: { questionNumber: number, studentAnswer: string, explanation: string }[], feedback: string }>}
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
      uncertainQuestionNumbers: [],
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
      uncertainQuestionNumbers: [],
      incorrectAnswers: [],
      feedback: ''
    };
  }
  const parsedAnswers = new Map(pending.map(questionNumber => [
    questionNumber,
    parseAnswerKey(lesson.answerKey[questionNumber - 1])
  ]));
  const verbHints = getQuestionVerbHints(lesson.taskMessage);
  const {
    correctQuestionNumbers: exactMatches,
    correctedAnswers,
    matchedLineIndexes
  } =
    findNumberedAnswers(
      studentSubmission,
      pending,
      parsedAnswers,
      verbHints,
      lesson.answerKey.length
    );
  const remainingPending = pending.filter(number => !exactMatches.has(number));
  const remainingSubmission = studentSubmission.split(/\r?\n/)
    .filter((_, index) => !matchedLineIndexes.has(index))
    .join('\n')
    .trim();

  if (remainingPending.length === 0) {
    const correctQuestionNumbers = [...exactMatches.keys()].sort((a, b) => a - b);
    return {
      isTaskSubmission: true,
      allCorrect: correctQuestionNumbers.length === pending.length,
      answeredQuestionNumbers: correctQuestionNumbers,
      correctQuestionNumbers,
      uncertainQuestionNumbers: [],
      incorrectAnswers: [],
      ...(correctedAnswers.length ? { correctedAnswers } : {}),
      feedback: getTaskFeedback(
        true,
        correctQuestionNumbers.length === pending.length,
        [],
        lesson.answerKey
      )
    };
  }

  const pendingAnswers = remainingPending.map(questionNumber => ({
    questionNumber,
    expectedAnswer: parsedAnswers.get(questionNumber).expectedAnswer,
    acceptedAnswers: parsedAnswers.get(questionNumber).acceptedAnswers,
    ruleExplanation: parsedAnswers.get(questionNumber).explanation
  }));
  const gradingSubmission = remainingSubmission || studentSubmission;

  const prompt = `
You are an encouraging Sudanese English teacher. Mark ${studentName}'s attempt using this lesson:
QUESTIONS: ${lesson.taskMessage}
PENDING ANSWERS: ${JSON.stringify(pendingAnswers)}
STUDENT: "${gradingSubmission}"

Only grade answers in the student's latest message; previously accepted answers are not part of this message. Students may copy each exercise question before writing its answer. Treat copied question text and verb hints in parentheses as context, not as the student's answer; when an answer follows the copied question, grade that answer. If the student completed the question itself, grade the completed question as their answer. If the message is unrelated to this exercise, return isTaskSubmission=false and empty arrays. Otherwise, identify which pending question numbers the student actually answered. Do not require students to number their answers: infer the question from answer content, task wording, context, and order. When there is only one pending question, match a clear answer to it even if it is unnumbered. For multiple unnumbered answers, match by meaning and order when they clearly fit the remaining questions. If the mapping is genuinely ambiguous, do not guess; leave the ambiguous answer unmatched and do not mark it wrong. Never treat a missing answer as wrong or answered.

Judge meaning and the grammar being tested, not exact wording. Treat listed acceptedAnswers as correct. Accept correct paraphrases, synonyms, valid equivalent forms, contractions, concise answers, and minor typos that do not change meaning. A one-word answer can be complete. Reject answers that change meaning or use the wrong form when that form is tested. If you are not confident an answer is wrong, classify its question number as uncertain instead of incorrect. An uncertain answer must appear in answeredQuestionNumbers and uncertainQuestionNumbers, but not in correctQuestionNumbers or incorrectAnswers. Never turn uncertainty into a wrong answer. answeredQuestionNumbers contains only questions answered in this message. correctQuestionNumbers and uncertainQuestionNumbers are subsets of answeredQuestionNumbers and must not overlap. incorrectAnswers must contain one entry for each answered but incorrect question; studentAnswer must be copied verbatim from the student's latest message as a concise contiguous excerpt, excluding any question-number prefix. explanation must be a concise, accurate hint in simple Sudanese Arabic that points to the relevant grammar rule and helps the student retry; do not state, quote, or give an example containing the expected answer or any accepted variant. allCorrect is true only when this message answers every question in PENDING ANSWERS and every one is correct, with no uncertain answers.

Return only this JSON shape. Do not generate feedback; the app sends it:
{
  "isTaskSubmission": boolean,
  "allCorrect": boolean,
  "answeredQuestionNumbers": number[],
  "correctQuestionNumbers": number[],
  "uncertainQuestionNumbers": number[],
  "incorrectAnswers": [{ "questionNumber": number, "studentAnswer": string, "explanation": string }]
}
`;

  let lastError = null;

  for (const modelName of MODELS) {
    for (const [keyIndex, apiKey] of config.geminiApiKeys.entries()) {
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
        if (!isValidTaskEvaluation(parsed, lesson.answerKey.length, remainingPending)) {
          throw new Error('Gemini returned task grading in an invalid format.');
        }

        if (keyIndex > 0) {
          console.log(`[Grader] Used API key ${keyIndex + 1} for task evaluation.`);
        }
        return combineExactMatches(parsed, exactMatches, pending, correctedAnswers, lesson);
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
    if (!isValidTaskEvaluation(parsed, lesson.answerKey.length, remainingPending)) {
      throw new Error('Ollama returned task grading in an invalid format.');
    }
    console.log('[Grader] Task evaluated using local Ollama.');
    return combineExactMatches(parsed, exactMatches, pending, correctedAnswers, lesson);
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
      !Array.isArray(result.uncertainQuestionNumbers) ||
      !Array.isArray(result.incorrectAnswers)) {
    return false;
  }
  const pending = new Set(pendingQuestionNumbers);
  const answered = new Set(result.answeredQuestionNumbers);
  const correct = new Set(result.correctQuestionNumbers);
  const uncertain = new Set(result.uncertainQuestionNumbers);
  const incorrect = new Set();
  for (const answer of result.incorrectAnswers) {
    if (!Number.isInteger(answer?.questionNumber) ||
        typeof answer.studentAnswer !== 'string' ||
        !answer.studentAnswer.trim() ||
        typeof answer.explanation !== 'string' ||
        !answer.explanation.trim() ||
        incorrect.has(answer.questionNumber) ||
        !answered.has(answer.questionNumber) ||
        correct.has(answer.questionNumber) ||
        uncertain.has(answer.questionNumber)) {
      return false;
    }
    incorrect.add(answer.questionNumber);
  }
  return answered.size === result.answeredQuestionNumbers.length &&
    correct.size === result.correctQuestionNumbers.length &&
    [...answered].every(number => Number.isInteger(number) && number >= 1 &&
      number <= answerCount && pending.has(number)) &&
    [...correct].every(number => answered.has(number)) &&
    [...uncertain].every(number => Number.isInteger(number) &&
      answered.has(number) && !correct.has(number) && !incorrect.has(number)) &&
    [...answered].every(number =>
      Number(correct.has(number)) + Number(uncertain.has(number)) +
      Number(incorrect.has(number)) === 1) &&
    (!result.allCorrect || (answered.size === pending.size &&
      [...pending].every(number => correct.has(number))));
}

export function parseAnswerKey(answerKeyEntry) {
  const entry = String(answerKeyEntry || '').trim()
    .replace(/^\s*\d+\s*[:.)/-]\s*/, '');
  const [expectedAnswer, explanation = ''] = entry.split(/\s+—\s+/, 2);
  const acceptedMatch = /also accepted:\s*(.+)$/i.exec(explanation);
  const acceptedAnswers = acceptedMatch
    ? acceptedMatch[1].split(/\s*[;,]\s*/).map(answer => answer.trim()).filter(Boolean)
    : [];
  return {
    expectedAnswer: expectedAnswer.trim(),
    acceptedAnswers,
    explanation: acceptedMatch
      ? explanation.slice(0, acceptedMatch.index).trim()
      : explanation.trim()
  };
}

function normalizeAnswer(answer) {
  return answer.toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTypoDistanceThreshold(answer) {
  const normalized = normalizeAnswer(answer).replace(/\s/g, '');
  if (/^\d+$/.test(normalized)) return 0;
  const length = normalized.length;
  if (length >= 24) return 2;
  if (length >= 5) return 1;
  return 0;
}

function getEditDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1])
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function isMinorSpellingTypo(candidate, expected) {
  const normalizedCandidate = normalizeAnswer(candidate);
  const normalizedExpected = normalizeAnswer(expected);
  if (!normalizedCandidate || !normalizedExpected ||
      normalizedCandidate === normalizedExpected ||
      getTypoDistanceThreshold(expected) === 0) return false;
  const candidateWords = normalizedCandidate.split(' ');
  const expectedWords = normalizedExpected.split(' ');
  if (candidateWords.length !== expectedWords.length) return false;

  let totalDistance = 0;
  for (let index = 0; index < expectedWords.length; index += 1) {
    if (candidateWords[index] === expectedWords[index]) continue;
    if (expectedWords[index].length < 5) return false;
    const remainingLimit = getTypoDistanceThreshold(expected) - totalDistance;
    if (remainingLimit <= 0) return false;
    const distance = getEditDistance(
      candidateWords[index],
      expectedWords[index],
      remainingLimit
    );
    if (distance > remainingLimit) {
      return false;
    }
    totalDistance += distance;
    if (totalDistance > getTypoDistanceThreshold(expected)) return false;
  }
  return totalDistance > 0;
}

function parseNumberedAnswer(line) {
  const match = /^\s*(\d{1,3})\s*[.)/:=-]\s*(.+?)\s*$/.exec(line);
  return match
    ? { questionNumber: Number(match[1]), answer: match[2] }
    : null;
}

function getQuestionVerbHints(taskMessage) {
  const hints = new Map();
  for (const line of taskMessage.split(/\r?\n/)) {
    const question = parseNumberedAnswer(line);
    const hintMatch = question && /\(([^()]*)\)\s*$/.exec(question.answer);
    if (!hintMatch) continue;
    hints.set(question.questionNumber, new Set(
      hintMatch[1].split(/\s*\/\s*/).map(normalizeAnswer).filter(Boolean)
    ));
  }
  return hints;
}

function removeMatchingVerbHint(submittedAnswer, expectedAnswer) {
  const hintMatch = /\s*\(([^()]*)\)\s*$/.exec(submittedAnswer);
  if (!hintMatch) return submittedAnswer;

  const hint = normalizeAnswer(hintMatch[1]);
  const expectedWords = new Set(normalizeAnswer(expectedAnswer).split(' '));
  return hint && expectedWords.has(hint)
    ? submittedAnswer.slice(0, hintMatch.index).trim()
    : submittedAnswer;
}

function findNumberedAnswers(submission, pending, parsedAnswers, verbHints, answerCount) {
  const pendingSet = new Set(pending);
  const candidates = new Map();
  const ignoredLineIndexes = new Set();
  const lines = submission.split(/\r?\n/);
  let hasNumberedAnswer = false;
  const addCandidate = (questionNumber, submittedAnswer, lineIndex) => {
    const answerOptions = [
      parsedAnswers.get(questionNumber).expectedAnswer,
      ...parsedAnswers.get(questionNumber).acceptedAnswers
    ];
    const exactAnswer = answerOptions.find(answer =>
      normalizeAnswer(answer) === normalizeAnswer(submittedAnswer));
    const isUninflectedVerbHint = verbHints.get(questionNumber)
      ?.has(normalizeAnswer(submittedAnswer));
    const correctedAnswer = exactAnswer || isUninflectedVerbHint
      ? null
      : answerOptions.find(answer => isMinorSpellingTypo(submittedAnswer, answer));
    if (!exactAnswer && !correctedAnswer) return;
    const existing = candidates.get(questionNumber) || {
      count: 0,
      correctedAnswer: null,
      lineIndexes: []
    };
    existing.count += 1;
    existing.lineIndexes.push(lineIndex);
    if (correctedAnswer) existing.correctedAnswer = answerOptions[0];
    candidates.set(questionNumber, existing);
  };

  for (const [lineIndex, line] of lines.entries()) {
    const parsed = parseNumberedAnswer(line);
    if (parsed) hasNumberedAnswer = true;
    const questionNumber = parsed?.questionNumber;
    if (!questionNumber || !pendingSet.has(questionNumber)) continue;
    const rawAnswer = parsed?.answer ?? line.trim();
    const submittedAnswer = removeMatchingVerbHint(
      rawAnswer,
      parsedAnswers.get(questionNumber).expectedAnswer
    );
    addCandidate(questionNumber, submittedAnswer, lineIndex);
  }

  const unnumberedAnswers = lines
    .map((line, lineIndex) => ({ line: line.trim(), lineIndex }))
    .filter(answer => answer.line);
  if (!hasNumberedAnswer &&
      [pending.length, answerCount].includes(unnumberedAnswers.length)) {
    const isFullList = unnumberedAnswers.length === answerCount;
    unnumberedAnswers.forEach(({ line, lineIndex }, index) => {
      const questionNumber = isFullList ? index + 1 : pending[index];
      if (!pendingSet.has(questionNumber)) {
        ignoredLineIndexes.add(lineIndex);
        return;
      }
      const submittedAnswer = removeMatchingVerbHint(
        line,
        parsedAnswers.get(questionNumber).expectedAnswer
      );
      addCandidate(questionNumber, submittedAnswer, lineIndex);
    });
  }
  const matched = [...candidates].filter(([, match]) => match.count === 1);
  return {
    correctQuestionNumbers: new Set(matched.map(([number]) => number)),
    correctedAnswers: matched.flatMap(([questionNumber, match]) =>
      match.correctedAnswer ? [{ questionNumber, correctSpelling: match.correctedAnswer }] : []),
    matchedLineIndexes: new Set([
      ...ignoredLineIndexes,
      ...matched.flatMap(([, match]) => match.lineIndexes)
    ])
  };
}

function combineExactMatches(result, exactMatches, pending, correctedAnswers = [], lesson) {
  const exactCorrect = [...exactMatches];
  const answeredQuestionNumbers = [...new Set([
    ...exactCorrect,
    ...result.answeredQuestionNumbers
  ])].sort((a, b) => a - b);
  const correctQuestionNumbers = [...new Set([
    ...exactCorrect,
    ...result.correctQuestionNumbers
  ])].sort((a, b) => a - b);
  const uncertainQuestionNumbers = [...new Set(result.uncertainQuestionNumbers)]
    .filter(number => !exactMatches.has(number))
    .sort((a, b) => a - b);
  const allCorrect = pending.every(number => correctQuestionNumbers.includes(number));
  const incorrectAnswers = result.incorrectAnswers;
  const incorrectFeedback = getTaskFeedback(
    result.isTaskSubmission || exactCorrect.length > 0,
    allCorrect,
    incorrectAnswers,
    lesson.answerKey
  );
  const uncertaintyFeedback = uncertainQuestionNumbers.length
    ? 'ما قدرت أتأكد من بعض الإجابات، وما اعتبرتها غلط. وضّح الإجابات المحددة عشان أراجعها.'
    : '';
  return {
    ...result,
    ...(correctedAnswers.length ? { correctedAnswers } : {}),
    isTaskSubmission: result.isTaskSubmission || exactCorrect.length > 0,
    allCorrect,
    answeredQuestionNumbers,
    correctQuestionNumbers,
    uncertainQuestionNumbers,
    feedback: [incorrectFeedback, uncertaintyFeedback].filter(Boolean).join('\n')
  };
}
