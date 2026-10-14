import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
function getGenAI() {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
  }
  return genAI;
}

const MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];

/**
 * Evaluates student's task submission using Gemini.
 * Returns structured feedback and progression status.
 * 
 * @param {object} lesson The lesson object containing taskMessage and answerKey
 * @param {string} studentSubmission The message sent by the student
 * @param {string} studentName The student's name
 * @returns {Promise<{ isTaskSubmission: boolean, allCorrect: boolean, feedback: string }>}
 */
export async function evaluateStudentTask(lesson, studentSubmission, studentName = 'يا بطل') {
  if (!studentSubmission || studentSubmission.trim().length < 2) {
    return { isTaskSubmission: false, allCorrect: false, feedback: '' };
  }

  const client = getGenAI();

  const prompt = `
You are Mr. Mazen (مستر مازن), an encouraging English teacher from Sudan running the eShool educational platform.
A student (${studentName}) sent a WhatsApp message after being assigned a task.

=== CURRENT LESSON ===
Title: ${lesson.title}

=== ASSIGNED TASK QUESTIONS ===
${lesson.taskMessage}

=== CORRECT ANSWER KEY & EXPLANATIONS ===
${JSON.stringify(lesson.answerKey, null, 2)}

=== STUDENT'S MESSAGE ===
"${studentSubmission}"

=== YOUR GOAL ===
1. Determine if this message is an attempt to solve the homework / exercise questions above.
   - If it's just general chat, greeting, question about fees, or unrelated talk -> isTaskSubmission = false.
   - If they are attempting to answer the questions -> isTaskSubmission = true.

2. If isTaskSubmission is true:
   - Mark the answers based on the Answer Key.
   - Set allCorrect = true ONLY if all questions are answered correctly.
   - If ANY answer is wrong or incomplete, set allCorrect = false.

3. Write the teacher's feedback strictly in warm, polite Sudanese Arabic (اللهجة السودانية الدارجة المهذبة والمشجعة):
   - If allCorrect is false:
     * Praise the parts they got right enthusiastically (ما شاء الله عليك، شغلك ممتاز).
     * For the incorrect questions, do NOT give away the final answer! Instead, point out which question was wrong and give a gentle hint in Sudanese Arabic (e.g. "ركز في زمن الجملة", "شوف الكلمة الدالة"), and kindly ask them to reattempt and send their answer again so they can move to the next lesson.
   - If allCorrect is true:
     * Celebrate their full success enthusiastically (الله أكبر عليك يا بطل! إجاباتك كلها صحيحة 100% وكفيت ووفيت).
     * Tell them they are ready for the next lesson and it is being sent to them right now!

=== OUTPUT FORMAT ===
Return ONLY a valid JSON object without markdown fences, matching this structure:
{
  "isTaskSubmission": boolean,
  "allCorrect": boolean,
  "feedback": "Your Sudanese Arabic feedback here"
}
`;

  let lastError = null;

  for (const modelName of MODELS) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.3, // Low temperature for consistent grading
          responseMimeType: 'application/json'
        }
      });

      const res = await model.generateContent(prompt);
      const rawText = res.response.text()?.trim();
      const cleaned = rawText.replace(/^```json/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        isTaskSubmission: !!parsed.isTaskSubmission,
        allCorrect: !!parsed.allCorrect,
        feedback: parsed.feedback || ''
      };
    } catch (err) {
      lastError = err;
      console.warn(`[Grader Warning] Model ${modelName} grading failed:`, err.message);
    }
  }

  console.error('[Grader Error] All models failed to evaluate task:', lastError?.message);
  return { isTaskSubmission: false, allCorrect: false, feedback: '' };
}
