import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { historyManager } from './history.js';

let genAI = null;

function getGenAI() {
  if (!genAI) {
    if (!config.geminiApiKey || config.geminiApiKey === 'your_gemini_api_key_here') {
      throw new Error('GEMINI_API_KEY is not configured in .env. Please set your key from https://aistudio.google.com/');
    }
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
  }
  return genAI;
}

// Models in order of preference and fallback reliability
const MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'];

/**
 * Generate an autonomous response to a client message
 * @param {string} jid Contact ID
 * @param {string} contactName Contact display name or phone
 * @param {string} incomingMessage The aggregated message(s) from the client
 * @returns {Promise<string>} The generated reply
 */
export async function generateClientResponse(jid, contactName, incomingMessage, images = []) {
  const client = getGenAI();
  const isEs = historyManager.isEsContact(jid, contactName);
  const pastDialogue = historyManager.getDialogueForAgent(jid, contactName);
  const systemInstruction = config.getSystemPrompt();

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

  const esNotice = isEs
    ? `\n⭐ [STATUS: ES CONTACT - PERMANENT HISTORY ACCESS UNLOCKED]\nThis student's contact contains the letters "Es". You have permanent access to their full dialogue and study history below. Use this complete memory to recall all past discussions, exercises, questions, and personal details.`
    : '';

  const prompt = `
=== BUSINESS KNOWLEDGE & COURSE DETAILS ===
${knowledge}

=== CLIENT PROFILE ===
Client Name / Identifier: ${contactName}
Contact Phone / JID: ${jid.split('@')[0]}${esNotice}

=== CONVERSATION HISTORY ===
${pastDialogue}

=== CURRENT INCOMING MESSAGE FROM CLIENT ===
"${incomingMessage}"
${images.length ? `\nThe client also attached ${images.length} image(s). Inspect the image content and use it when responding.` : ''}

=== YOUR INSTRUCTION ===
Draft a clear, friendly, and concise response to the client.
- Use the business knowledge and course details above to answer accurately.
- Remember the conversation context from above.
- Answer their question or acknowledge their request.
- Never initiate a conversation about fees, payment, bank transfers, or payment receipts. Never ask the student to pay, transfer money, or send proof of payment, and never make payment a prerequisite for lessons.
- If an attached image appears to be a payment receipt, acknowledge receipt of the image briefly without evaluating or validating the payment, then keep the conversation focused on the student's learning and lessons.
- If the student directly asks about fees or payment, answer that specific question briefly and return to the lesson; do not pressure them.
- Do NOT include any meta-commentary like "Here is your response:". Only output the exact text to send to the client.
`;

  let lastError = null;

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
      const result = await model.generateContent([prompt, ...imageParts]);
      const replyText = result.response.text()?.trim();

      if (replyText) {
        return replyText;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[AI Warning] Model ${modelName} failed (${err.message.substring(0, 80)}). Trying fallback...`);
    }
  }

  console.error('All AI models failed:', lastError?.message);
  throw lastError || new Error('Failed to generate response from any AI model.');
}

/**
 * Draft a personal, history-aware check-in for a student who has opted in.
 * @param {string} jid Contact ID
 * @param {string} contactName Contact display name
 * @param {boolean} includeOptOutNote Whether this is the first campaign message
 * @returns {Promise<string>} The generated follow-up message
 */
export async function generateStudentFollowUp(jid, contactName, includeOptOutNote = false) {
  const client = getGenAI();
  const pastDialogue = historyManager.getDialogueForAgent(jid, contactName);
  const optOutInstruction = includeOptOutNote
    ? '- End with a brief, clear note that they can reply "إيقاف" if they do not want future follow-ups.'
    : '';
  const prompt = `
=== STUDENT CHAT HISTORY ===
${pastDialogue}

=== YOUR TASK ===
Write one short, warm WhatsApp check-in in natural Sudanese Arabic from Mr. Mazen to this student.
- Use the history of THIS chat only. If it contains a past English-learning difficulty, exam result, goal, lesson, or question, refer to that detail naturally.
- If there is no useful personal detail, write a simple friendly check-in about how the student's English study is going; do not invent facts.
- Ask one thoughtful question that continues the conversation. Do not repeat a question already asked in the recent chat.
- Keep it personal and supportive, not a generic advertisement or payment reminder.
- Output only the message to send, with no labels or explanation.
${optOutInstruction}
`;

  let lastError = null;
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

      const result = await model.generateContent(prompt);
      const replyText = result.response.text()?.trim();
      if (replyText) return replyText;
    } catch (err) {
      lastError = err;
      console.warn(`[Follow-up AI Warning] Model ${modelName} failed (${err.message.substring(0, 80)}). Trying fallback...`);
    }
  }

  throw lastError || new Error('Failed to generate a student follow-up.');
}

/**
 * Automatically learns from answers given by the teacher (Mr. Mazen) on WhatsApp.
 * Saves new knowledge to knowledge/learned_from_chats.txt.
 */
export async function learnFromTeacherReply(clientQuestion, teacherReply) {
  if (!clientQuestion || !teacherReply) return;
  if (teacherReply.trim().length < 5) return;

  const client = getGenAI();
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

  try {
    const model = client.getGenerativeModel({
      model: 'gemini-3.1-flash-lite',
      generationConfig: { maxOutputTokens: 150, temperature: 0.2 }
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text()?.trim();

    if (text && !text.toUpperCase().includes('SKIP') && text.length > 5) {
      const learnedPath = path.resolve('knowledge', 'learned_from_chats.txt');
      const entry = `\n${text}\n`;
      fs.appendFileSync(learnedPath, entry, 'utf-8');
      console.log(`[Auto-Learn 🧠] New knowledge learned from Mr. Mazen:\n${text}`);
    }
  } catch (err) {
    console.warn('[Auto-Learn] Background learning error:', err.message);
  }
}
