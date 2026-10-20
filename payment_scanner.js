import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { generateWithTransientRetry } from './ai.js';
import { generateLocalResponse } from './local_ai.js';

const genAIClients = new Map();

function getGenAI(apiKey) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in .env. Please set your key from https://aistudio.google.com/');
  }
  if (!genAIClients.has(apiKey)) {
    genAIClients.set(apiKey, new GoogleGenerativeAI(apiKey));
  }
  return genAIClients.get(apiKey);
}

export const PAYMENT_SCAN_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3.8-flash'
];

export const PAYMENT_SCAN_SYSTEM_INSTRUCTION = `
You are an expert document inspector for an online English school in Sudan ("eSchool", owned by teacher Mazen Mohammed / مستر مازن).
Students pay their subscription fees by bank transfer or mobile deposit and send a photo or screenshot of the transaction receipt.

Your job is to inspect the attached image(s) and determine if it shows a genuine payment receipt, bank transfer slip, deposit voucher, ATM confirmation, or mobile banking confirmation (e.g., Bank of Khartoum "Bankak" بنكك, Fawry بنك فيصل, Omdurman Bank, GCC bank transfer, or cash deposit).

Known school payment details:
- Recipient / Teacher: Mazen Mohammed Ahmed Al-Siddiq Saleh / مازن محمد أحمد الصديق صالح / مستر مازن
- Bank: Bank of Khartoum (بنك الخرطوم - بنكك / Bankak)
- Account Number: 2865022
- Standard subscription fees: usually in SDG (Sudanese Pounds), e.g. 17,000 SDG, 27,000 SDG, 52,000 SDG, or any transfer amount.
- Other banks / foreign accounts: accepted if showing a completed money transfer or deposit to the school/teacher.

CRITICAL RULES:
1. Mark "isPayment": true ONLY if the image is an actual payment receipt, transaction confirmation screen, or deposit slip showing a completed or successful money transfer.
2. Mark "isPayment": false if the image is:
   - Handwritten student homework or exercise answers on a notebook or paper
   - A textbook or story page (e.g., Spine series, Treasure Island, English book)
   - A personal photo, selfie, meme, avatar, or landscape
   - A screenshot of a chat, WhatsApp conversation, price list, or fee inquiry WITHOUT an actual transfer confirmation
   - A blank or illegible image

Respond strictly with a JSON object in this format:
{
  "isPayment": boolean,
  "confidence": number,
  "details": {
    "bank": "Bank name if recognized, e.g. Bank of Khartoum (Bankak) or null",
    "amount": number or null,
    "currency": "Currency code e.g. SDG or null",
    "transactionId": "Reference/transaction number or null",
    "recipientName": "Recipient name on receipt or null",
    "recipientAccount": "Account number on receipt or null",
    "date": "Date string on receipt or null"
  },
  "reason": "Brief explanation of what the image shows"
}
`.trim();

export function buildPaymentScanPrompt(caption = '') {
  const captionPart = caption && caption.trim() && caption.trim() !== 'أرسل صورة'
    ? `\nThe student included this text/caption with the photo:\n"${caption.trim()}"\n`
    : '';

  return `
Analyze the attached image(s) to verify if any image is a payment receipt, bank transfer confirmation, or deposit slip.
${captionPart}
Remember: return only valid JSON matching the requested structure.
`.trim();
}

export function parsePaymentScanResult(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { isPayment: false, confidence: 0, details: null, reason: 'Empty response' };
  }
  const cleaned = rawText
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Invalid JSON returned by payment scanner: ${err.message}`);
  }

  if (typeof parsed.isPayment !== 'boolean') {
    throw new Error('Scanner returned invalid format: missing isPayment boolean');
  }

  let amount = null;
  if (typeof parsed.details?.amount === 'number' && Number.isFinite(parsed.details.amount)) {
    amount = parsed.details.amount;
  } else if (parsed.details?.amount != null) {
    const parsedNum = Number(String(parsed.details.amount).replace(/[^0-9.]/g, ''));
    amount = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : null;
  }

  return {
    isPayment: parsed.isPayment,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : (parsed.isPayment ? 1 : 0),
    details: parsed.isPayment && parsed.details && typeof parsed.details === 'object' ? {
      bank: typeof parsed.details.bank === 'string' && parsed.details.bank.trim() ? parsed.details.bank.trim() : null,
      amount,
      currency: typeof parsed.details.currency === 'string' && parsed.details.currency.trim() ? parsed.details.currency.trim() : 'SDG',
      transactionId: parsed.details.transactionId != null ? String(parsed.details.transactionId).trim() : null,
      recipientName: typeof parsed.details.recipientName === 'string' && parsed.details.recipientName.trim() ? parsed.details.recipientName.trim() : null,
      recipientAccount: parsed.details.recipientAccount != null ? String(parsed.details.recipientAccount).trim() : null,
      date: typeof parsed.details.date === 'string' && parsed.details.date.trim() ? parsed.details.date.trim() : null
    } : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  };
}

export async function scanPaymentReceipt(images = [], caption = '', options = {}) {
  const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
  if (imageList.length === 0) {
    return {
      isPayment: false,
      confidence: 0,
      details: null,
      reason: 'No images provided'
    };
  }

  if (typeof options.generateContent === 'function') {
    const raw = await options.generateContent(imageList, caption);
    return parsePaymentScanResult(raw);
  }

  const prompt = buildPaymentScanPrompt(caption);
  const systemInstruction = options.systemInstruction || PAYMENT_SCAN_SYSTEM_INSTRUCTION;
  const apiKeys = Array.isArray(options.geminiApiKeys) && options.geminiApiKeys.length > 0
    ? options.geminiApiKeys
    : config.geminiApiKeys;
  const models = options.models || PAYMENT_SCAN_MODELS;

  const imageParts = imageList.map(({ data, mimeType }) => ({
    inlineData: {
      data: Buffer.isBuffer(data) ? data.toString('base64') : String(data),
      mimeType: mimeType || 'image/jpeg'
    }
  }));

  let lastError = null;

  for (const [keyIndex, apiKey] of apiKeys.entries()) {
    const client = getGenAI(apiKey);
    for (const modelName of models) {
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
          }
        });

        const result = await generateWithTransientRetry(() =>
          model.generateContent([prompt, ...imageParts]));
        const replyText = result.response.text()?.trim();

        if (replyText) {
          if (keyIndex > 0) {
            console.log(`[Payment Scanner] Image analyzed using Gemini API key ${keyIndex + 1}.`);
          }
          return parsePaymentScanResult(replyText);
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Payment Scanner Warning] Model ${modelName} with API key ${keyIndex + 1} failed: ${err.message}`);
      }
    }
  }

  // Fallback to local Ollama vision if available
  try {
    const localRaw = await generateLocalResponse(prompt, {
      systemInstruction,
      images: imageList,
      fetchImpl: options.fetchImpl || fetch
    });
    console.log('[Payment Scanner] Image analyzed using local Ollama vision model.');
    return parsePaymentScanResult(localRaw);
  } catch (localErr) {
    console.error('[Payment Scanner Error] Gemini and local vision fallback failed:', localErr.message);
    throw new Error(`Payment scanning failed (${lastError?.message || 'no Gemini API key configured'}); local vision fallback failed: ${localErr.message}`);
  }
}

export function formatPaymentAcknowledgment(scannedPayment, { studentName = '', language = 'arabic' } = {}) {
  const isArabic = language === 'arabic';
  if (!isArabic) {
    return 'Payment receipt received, thank you! Let’s continue with our lessons.';
  }
  return 'وصل إيصال التحويل، تسلم يا رب وبارك الله فيك. حنواصل في حصصنا وتماريننا طوالي.';
}
