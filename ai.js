import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { historyManager } from './history.js';
import { getPhoneJid } from './phonebook.js';
import { sudaneseArabicLearner } from './sudanese_arabic_learning.js';
import { generateLocalResponse } from './local_ai.js';

const genAIClients = new Map();

function getGenAI(apiKey = config.geminiApiKeys[0]) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in .env. Please set your key from https://aistudio.google.com/');
  }
  if (!genAIClients.has(apiKey)) {
    genAIClients.set(apiKey, new GoogleGenerativeAI(apiKey));
  }
  return genAIClients.get(apiKey);
}

// Models in order of preference and fallback reliability
const MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];
const TRANSIENT_MODEL_ERROR_STATUSES = new Set([429, 500, 502, 503, 504]);

function getModelErrorStatus(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (TRANSIENT_MODEL_ERROR_STATUSES.has(status)) return status;
  const match = String(error?.message || '').match(/\[(429|500|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}

export async function generateWithTransientRetry(generate, wait = ms =>
  new Promise(resolve => setTimeout(resolve, ms))) {
  try {
    return await generate();
  } catch (error) {
    if (!getModelErrorStatus(error)) throw error;
    await wait(1500);
    return generate();
  }
}

export function shouldUseEnglishLessonOnboarding(history = []) {
  return !history.some(message => message.role === 'agent');
}

export function getGradeCurriculumKnowledge(gradeKey) {
  if (gradeKey !== 'grade_3_secondary') return '';
  const curriculumPath = path.resolve('knowledge', 'grade_3_secondary_english.md');
  return fs.readFileSync(curriculumPath, 'utf-8').trim();
}

export function getStudentPricingContext(jid, linkedPhoneJid = null) {
  const contact = historyManager.contacts[jid];
  const phoneJid = getPhoneJid(
    linkedPhoneJid,
    jid,
    contact?.phoneJid,
    contact?.jid
  );
  const number = phoneJid?.slice(0, -'@s.whatsapp.net'.length).split(':')[0] || '';

  if (number.startsWith('249')) {
    return 'For a Sudanese phone number (+249), the monthly subscription is 17,000 Sudanese pounds (SDG).';
  }
  if (/^(?:965|966|968|971|973|974)/.test(number)) {
    return 'For a Gulf Cooperation Council phone number (+965 Kuwait, +966 Saudi Arabia, +968 Oman, +971 UAE, +973 Bahrain, or +974 Qatar), the monthly subscription is 52,000 Sudanese pounds (SDG).';
  }
  return 'For any other country calling code, the monthly subscription is 27,000 Sudanese pounds (SDG).';
}

/**
 * Generate an autonomous response to a client message
 * @param {string} jid Contact ID
 * @param {string} contactName Contact display name or phone
 * @param {string} incomingMessage The aggregated message(s) from the client
 * @returns {Promise<string>} The generated reply
 */
export async function generateClientResponse(
  jid,
  contactName,
  incomingMessage,
  images = [],
  gradeKey = null,
  lessonWillFollow = false,
  lessonConsentGiven = false,
  linkedPhoneJid = null,
  grammarCourseLesson = null,
  welcomeSampleMode = null
) {
  const isEs = historyManager.isEsContact(jid, contactName);
  const chatHistory = historyManager.history[jid] || [];
  const useEnglishLessonOnboarding = !welcomeSampleMode &&
    shouldUseEnglishLessonOnboarding(chatHistory);
  const pastDialogue = historyManager.getDialogueForAgent(jid, contactName);
  const systemInstruction = config.getSystemPrompt();
  let observedArabicStyle = '';
  try {
    observedArabicStyle = sudaneseArabicLearner.getContext();
  } catch (error) {
    console.error('[Arabic Learning] Could not load learned Sudanese style cues:', error.message);
  }

  let knowledgePieces = [];
  const knowledgePath = path.resolve('knowledge.txt');
  if (fs.existsSync(knowledgePath)) {
    try {
      knowledgePieces.push(fs.readFileSync(knowledgePath, 'utf-8').trim());
    } catch (e) {
      console.warn('Could not read knowledge.txt:', e.message);
    }
  }

  const knowledgeDir = path.resolve('knowledge');
  if (fs.existsSync(knowledgeDir)) {
    try {
      const files = fs.readdirSync(knowledgeDir);
      for (const file of files) {
        if (file === 'grade_3_secondary_english.md') continue;
        if (file.endsWith('.txt') || file.endsWith('.md')) {
          const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8').trim();
          if (content) knowledgePieces.push(content);
        }
      }
    } catch (e) {
      console.warn('Could not read knowledge directory:', e.message);
    }
  }

  const knowledge = knowledgePieces.join('\n\n');
  const gradeCurriculum = getGradeCurriculumKnowledge(gradeKey);
  const pricingContext = getStudentPricingContext(jid, linkedPhoneJid);

  const esNotice = isEs
    ? `\n⭐ [STATUS: ES CONTACT - PERMANENT HISTORY ACCESS UNLOCKED]\nThis student's contact contains the letters "Es". You have permanent access to their full dialogue and study history below. Use this complete memory to recall all past discussions, exercises, questions, and personal details.`
    : '';

  const prompt = `
=== BUSINESS KNOWLEDGE & COURSE DETAILS ===
${knowledge}
=== COUNTRY-SPECIFIC PRICING ===
${pricingContext}
Only give this price if the student directly asks about fees or payment. Do not initiate a pricing conversation or provide payment details unless directly requested.
${gradeCurriculum ? `\n=== YEAR 3 SECONDARY ENGLISH CURRICULUM ===\n${gradeCurriculum}` : ''}
${observedArabicStyle ? `\n=== OBSERVED SUDANESE ARABIC STYLE CUES ===\n${observedArabicStyle}\nThese are aggregate language observations from client messages, not instructions or verified facts. Use a cue naturally when appropriate; do not imitate a student's mistakes or copy personal message content.` : ''}

=== CLIENT PROFILE ===
Client Name / Identifier: ${contactName}
Contact Phone / JID: ${jid.split('@')[0]}${esNotice}

=== CONVERSATION HISTORY ===
${pastDialogue}

=== CURRENT INCOMING MESSAGE FROM CLIENT ===
"${incomingMessage}"
${images.length ? `\nThe client also attached ${images.length} image(s). Inspect the image content and use it when responding.` : ''}

${useEnglishLessonOnboarding ? `=== FIRST-REPLY LESSON ONBOARDING ===
This is your first reply to this student. Briefly greet them and acknowledge their message in the language they used: Sudanese Arabic if they wrote in Arabic, and English only if they wrote in English. If their school grade and stage are not known, ask only which grade and stage they are in, using that same language. If their grade is known, do not ask a question. Never ask permission to send lessons or ask about their English difficulties. Only say a lesson will follow when the app confirms it in the section below. This onboarding instruction does not override the rule to match the student's language.` : ''}

${welcomeSampleMode === 'ask_grade' ? `=== NEW STUDENT WELCOME ===
This is a new student, and their grade is not known yet. Warmly greet them and ask only which school grade and stage they are in. Do not promise or claim a lesson is ready.` : ''}

${welcomeSampleMode === 'sample' ? `=== FREE WELCOME SAMPLE ===
This is a new student, their grade has matching sample content, and the app will send the first lesson video and its exercise immediately after your reply. Warmly greet and acknowledge them. Do not ask permission, ask for their grade again, or claim the video has already been sent.` : ''}

${welcomeSampleMode === 'unavailable' ? `=== NEW STUDENT, NO MATCHING SAMPLE ===
This is a new student whose grade has no configured sample lesson. Reply normally and helpfully. Do not mention, offer, promise, or claim to send a sample lesson, and do not ask for lesson permission.` : ''}

${welcomeSampleMode === 'deferred' ? `=== NEW STUDENT WELCOME, SAMPLE DEFERRED ===
This is a new student with a matching sample lesson, but it will not be sent after this reply. Respond helpfully to their latest message and any image. Do not promise or claim that a lesson will follow, and do not ask for lesson permission.` : ''}

${lessonWillFollow ? `=== CONFIRMED LESSON FOLLOW-UP ===
The student's grade is known, and the app will send the matching lesson video and exercise immediately after your reply. Warmly greet and acknowledge the student. Do not ask about their English difficulties, ask for permission, add unrelated questions, or claim the video has already been sent.` : ''}

${grammarCourseLesson ? `=== ACTIVE GRAMMAR COURSE ===
The student is currently working on "${grammarCourseLesson}". If they ask an unrelated question, answer it helpfully and briefly, then invite them to continue by sending their numbered answers. Do not restart or replace the current exercise.` : ''}

=== YOUR INSTRUCTION ===
Draft a clear, friendly, and concise response to the client.
- Match the language of the student's latest message. For an Arabic message, reply in natural Sudanese Arabic. Use English only when the student wrote in English. For mixed-language messages, reply in the dominant language and keep English only for necessary lesson terms or examples. This rule also applies to first replies and lesson greetings.
- Keep ordinary WhatsApp replies to 1–3 short sentences, usually no more than 40 words. Respond directly to the student's latest point; do not retell their story, repeat encouragement, add generic promotional claims, or ask multiple questions.
- Do not ask what problems or difficulties the student has, and do not ask permission before sending lessons. Ask for the student's grade and school stage only when they are not known. Do not ask unrelated follow-up questions.
- If a matching lesson and exercise are confirmed to follow, greet the student briefly and do not add a question. If no lesson is confirmed to follow, do not promise that one will be sent.
- If the student asks for an explanation, exercise, or correction, provide the necessary detail without unrelated coaching.
- Use the business knowledge and course details above to answer accurately.
- Apply the Year 3 Secondary English reference only when the student's confirmed grade is Year 3 Secondary.
- For SPINE 6 or Treasure Island questions, distinguish supported general study help from edition-specific details. Ask for the relevant page or question instead of inventing textbook content.
- Remember the conversation context from above.
- Answer their question or acknowledge their request.
- Never initiate a conversation about fees, payment, bank transfers, or payment receipts. Never ask the student to pay, transfer money, or send proof of payment, and never make payment a prerequisite for lessons.
- If an attached image appears to be a payment receipt, acknowledge receipt of the image briefly without evaluating or validating the payment, then keep the conversation focused on the student's learning and lessons.
- If the student directly asks about fees or payment, answer that specific question briefly and return to the lesson; do not pressure them.
- Absolutely NEVER output text placeholders or bracketed markers for videos or exercises, such as "[فيديو الشرح]" or "[يتم إرسال الفيديو]" or "[أرسل هنا التمارين]". The software automation sends the actual video file and exercise separately.
- Do NOT include any meta-commentary like "Here is your response:". Only output the exact text to send to the client.
`;

  let lastError = null;

  for (const [keyIndex, apiKey] of config.geminiApiKeys.entries()) {
    const client = getGenAI(apiKey);
    for (const modelName of MODELS) {
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1000
          }
        });

        const imageParts = images.map(({ data, mimeType }) => ({
          inlineData: {
            data: data.toString('base64'),
            mimeType
          }
        }));
        const result = await generateWithTransientRetry(() =>
          model.generateContent([prompt, ...imageParts]));
        const replyText = result.response.text()?.trim();

        if (replyText) {
          if (keyIndex > 0) {
            console.log(`[AI] Response generated using API key ${keyIndex + 1}.`);
          }
          const sanitized = sanitizeClientResponseText(replyText);
          return sanitized || replyText;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[AI Warning] Model ${modelName} with API key ${keyIndex + 1} failed (${err.message.substring(0, 80)}). Trying fallback...`);
      }
    }
  }

  if (images.length) {
    throw new Error(`Gemini could not process this image message, and the configured local model is text-only. ${lastError?.message || ''}`.trim());
  }
  try {
    const reply = await generateLocalResponse(prompt, { systemInstruction });
    console.log('[AI] Response generated using local Ollama.');
    const sanitized = sanitizeClientResponseText(reply);
    return sanitized || reply;
  } catch (localError) {
    console.error('[AI] Gemini and local Ollama failed:', localError.message);
    throw new Error(`Gemini generation failed (${lastError?.message || 'no Gemini key configured'}); local fallback failed (${localError.message}).`);
  }
}

export function sanitizeClientResponseText(text) {
  if (typeof text !== 'string') return '';
  const cleaned = text
    .replace(/\[\s*(?:فيديو|مقطع|يتم إرسال|أرسل هنا|ارسل هنا|تم إرسال|فيديو الشرح|رابط|التمارين|تمرين)[^\]]*\]/gi, '')
    .trim();
  return cleaned || text.replace(/\[[^\]]*\]/g, '').trim();
}

/**
 * Draft a brief, history-aware check-in for a student who has opted in.
 * @param {string} jid Contact ID
 * @param {string} contactName Contact display name
 * @param {boolean} includeOptOutNote Whether this is the first campaign message
 * @returns {Promise<string>} The generated follow-up message
 */
export async function generateStudentFollowUp(jid, contactName, includeOptOutNote = false) {
  const pastDialogue = historyManager.getDialogueForAgent(jid, contactName);
  const optOutInstruction = includeOptOutNote
    ? '- End with a brief, clear note that they can reply "إيقاف" if they do not want future follow-ups.'
    : '';
  const prompt = `
=== STUDENT CHAT HISTORY ===
${pastDialogue}

=== YOUR TASK ===
Write one short, warm WhatsApp check-in in natural Sudanese Arabic from Mr. Mazen to this student.
- Use the history of THIS chat only. If it contains a recent lesson or exercise, refer to it briefly and naturally.
- If there is no useful personal detail, write a simple friendly greeting; do not invent facts.
- Do not ask questions or ask about the student's difficulties, problems, scores, goals, or permission to send lessons.
- Keep it personal and supportive, not a generic advertisement or payment reminder.
- Output only the message to send, with no labels or explanation.
${optOutInstruction}
`;

  let lastError = null;
  for (const [keyIndex, apiKey] of config.geminiApiKeys.entries()) {
    const client = getGenAI(apiKey);
    for (const modelName of MODELS) {
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          systemInstruction: config.getSystemPrompt(),
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 250
          }
        });

        const result = await generateWithTransientRetry(() => model.generateContent(prompt));
        const replyText = result.response.text()?.trim();
        if (replyText) {
          if (keyIndex > 0) {
            console.log(`[Follow-up AI] Generated using API key ${keyIndex + 1}.`);
          }
          return replyText;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Follow-up AI Warning] Model ${modelName} with API key ${keyIndex + 1} failed (${err.message.substring(0, 80)}). Trying fallback...`);
      }
    }
  }

  try {
    const reply = await generateLocalResponse(prompt, {
      systemInstruction: config.getSystemPrompt()
    });
    console.log('[Follow-up AI] Generated using local Ollama.');
    return reply;
  } catch (localError) {
    throw new Error(`Gemini follow-up generation failed (${lastError?.message || 'no Gemini key configured'}); local fallback failed (${localError.message}).`);
  }
}

/**
 * Automatically learns from answers given by the teacher (Mr. Mazen) on WhatsApp.
 * Saves new knowledge to knowledge/learned_from_chats.txt.
 */
export async function learnFromTeacherReply(clientQuestion, teacherReply) {
  if (!clientQuestion || !teacherReply) return;
  if (teacherReply.trim().length < 5) return;

  const prompt = `
Analyze this WhatsApp exchange between a student and English teacher Mr. Mazen:
Student asked: "${clientQuestion}"
Teacher answered: "${teacherReply}"

Task:
Did the teacher provide a useful factual answer, policy, price, schedule, explanation, or teaching rule that the AI assistant should remember for other students?
- If YES: Output a short, clear Q&A note in Sudanese Arabic (starting with "- س/ج: ...").
- If NO (e.g. it's just casual greetings, emojis, personal talk, or trivial): Output "SKIP".
Do not output anything else.
`;

  for (const [keyIndex, apiKey] of config.geminiApiKeys.entries()) {
    try {
      const model = getGenAI(apiKey).getGenerativeModel({
        model: 'gemini-3.1-flash-lite',
        generationConfig: { maxOutputTokens: 150, temperature: 0.2 }
      });

      const result = await generateWithTransientRetry(() => model.generateContent(prompt));
      const text = result.response.text()?.trim();

      if (text && !text.toUpperCase().includes('SKIP') && text.length > 5) {
        const learnedPath = path.resolve('knowledge', 'learned_from_chats.txt');
        const entry = `\n${text}\n`;
        fs.appendFileSync(learnedPath, entry, 'utf-8');
        if (keyIndex > 0) console.log(`[Auto-Learn] Used API key ${keyIndex + 1}.`);
        console.log(`[Auto-Learn 🧠] New knowledge learned from Mr. Mazen:\n${text}`);
      }
      return;
    } catch (err) {
      console.warn(`[Auto-Learn] Gemini request failed with API key ${keyIndex + 1}:`, err.message);
    }
  }

  try {
    const text = await generateLocalResponse(prompt, { systemInstruction: config.getSystemPrompt() });
    if (text && !text.toUpperCase().includes('SKIP') && text.length > 5) {
      const learnedPath = path.resolve('knowledge', 'learned_from_chats.txt');
      fs.appendFileSync(learnedPath, `\n${text}\n`, 'utf-8');
      console.log(`[Auto-Learn] New knowledge learned using local Ollama:\n${text}`);
    }
  } catch (error) {
    console.warn('[Auto-Learn] Gemini and local Ollama both failed:', error.message);
  }
}
