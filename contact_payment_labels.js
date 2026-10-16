import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CONTACT_PAYMENT_LABELS_FILE = path.join(ROOT_DIR, 'data', 'contact_payment_labels.json');
export const PAID_WHATSAPP_LABEL_ID = 'es-paid';

export async function applyWhatsAppPaidLabel(sock, jid, action = 'add') {
  if (action === 'add') {
    if (!sock || typeof sock.addLabel !== 'function' || typeof sock.addChatLabel !== 'function') {
      throw new Error('This WhatsApp connection does not support chat labels.');
    }
    await sock.addLabel(jid, {
      id: PAID_WHATSAPP_LABEL_ID,
      name: 'paid',
      color: 3
    });
    await sock.addChatLabel(jid, PAID_WHATSAPP_LABEL_ID);
  } else if (action === 'remove') {
    if (!sock || typeof sock.removeChatLabel !== 'function') {
      throw new Error('This WhatsApp connection does not support removing chat labels.');
    }
    await sock.removeChatLabel(jid, PAID_WHATSAPP_LABEL_ID);
  } else {
    throw new Error('Unsupported WhatsApp payment-label action.');
  }
}

function normalizePaymentText(text) {
  return String(text || '')
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .trim();
}

export function isExplicitPaidClaim(text) {
  const normalized = normalizePaymentText(text);
  if (!normalized || /[?؟]\s*$/.test(normalized)) return false;
  if (/\b(?:not|never|didn['’]?t|don['’]?t|haven['’]?t|hasn['’]?t|won['’]?t)\b.{0,50}\b(?:paid|pay|transferred|sent|payment)\b/.test(normalized)) {
    return false;
  }
  if (/(?:ما|لم|لن)\s*(?:دفعت|حولت|سددت|ادفع|اسدد)|(?:ما\s+)?دفعت\s+لسه/.test(normalized)) {
    return false;
  }

  return /\b(?:i|we)(?:['’]ve)?\s+(?:(?:have|already|just)\s+)*(?:paid|transferred|sent\s+(?:(?:the|my|our)\s+)?(?:payment|fee|fees|money|amount))\b/.test(normalized) ||
    /\b(?:payment|fees?|transfer)\s+(?:has\s+been\s+)?(?:paid|sent|completed|complete)\b/.test(normalized) ||
    /\b(?:i|we)\s+(?:have\s+)?(?:made|completed)\s+(?:the\s+)?(?:payment|transfer)\b/.test(normalized) ||
    /^(?:paid|payment sent|fees paid)[.! ]*$/.test(normalized) ||
    /(?:انا\s*)?(?:دفعت|حولت|سددت)(?:\s+(?:الرسوم|المبلغ|ليك|لك))?/.test(normalized) ||
    /(?:تم|اكملت)\s*(?:الدفع|التحويل|السداد)/.test(normalized);
}

export function createContactPaymentLabelsStore(filePath = CONTACT_PAYMENT_LABELS_FILE) {
  function read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.entries(parsed).some(([number, record]) =>
          !/^\d{5,15}$/.test(number) ||
          !record ||
          typeof record !== 'object' ||
          !['paid', 'unpaid'].includes(record.label) ||
          typeof record.reportedAt !== 'string' ||
          typeof record.jid !== 'string' ||
          (record.whatsappAppliedAt !== null && typeof record.whatsappAppliedAt !== 'string') ||
          (record.whatsappAction != null && !['add', 'remove'].includes(record.whatsappAction)))) {
      throw new Error(`Invalid contact payment labels file: ${filePath}`);
    }
    return parsed;
  }

  function write(labels) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(labels, null, 2), 'utf8');
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Contact Payment Labels] Could not remove temporary file:', cleanupError.message);
      }
      throw error;
    }
  }

  return {
    list: read,
    get(number) {
      const normalizedNumber = String(number || '').replace(/[^0-9]/g, '');
      return read()[normalizedNumber] || null;
    },
    markPaid(number, jid) {
      const normalizedNumber = String(number || '').replace(/[^0-9]/g, '');
      if (!/^\d{5,15}$/.test(normalizedNumber)) {
        throw new Error('A valid phone number is required to label a paid contact.');
      }
      if (typeof jid !== 'string' || !jid.trim()) {
        throw new Error('A WhatsApp chat identifier is required to label a paid contact.');
      }
      const labels = read();
      const record = labels[normalizedNumber] || {
        label: 'paid',
        source: 'student-reported',
        reportedAt: new Date().toISOString(),
        jid,
        whatsappAppliedAt: null,
        whatsappAction: 'add'
      };
      if (!record.jid) record.jid = jid;
      labels[normalizedNumber] = record;
      write(labels);
      return record;
    },
    setManualStatus(number, jid, status) {
      const normalizedNumber = String(number || '').replace(/[^0-9]/g, '');
      if (!/^\d{5,15}$/.test(normalizedNumber)) {
        throw new Error('A valid phone number is required to update a paid label.');
      }
      if (typeof jid !== 'string' || !jid.trim()) {
        throw new Error('A WhatsApp chat identifier is required to update a paid label.');
      }
      if (status !== 'paid' && status !== 'unpaid') {
        throw new Error('Payment status must be paid or unpaid.');
      }
      const labels = read();
      const previous = labels[normalizedNumber];
      const record = {
        label: status,
        source: 'manual',
        reportedAt: previous?.reportedAt || new Date().toISOString(),
        jid,
        whatsappAppliedAt: null,
        whatsappAction: status === 'paid' ? 'add' : 'remove'
      };
      labels[normalizedNumber] = record;
      write(labels);
      return record;
    },
    markWhatsAppApplied(number) {
      const normalizedNumber = String(number || '').replace(/[^0-9]/g, '');
      const labels = read();
      const record = labels[normalizedNumber];
      if (!record) throw new Error('The contact has no student-reported paid label.');
      record.whatsappAppliedAt = new Date().toISOString();
      record.whatsappAction = null;
      write(labels);
      return record;
    },
    markWhatsAppRemoved(number) {
      const normalizedNumber = String(number || '').replace(/[^0-9]/g, '');
      const labels = read();
      const record = labels[normalizedNumber];
      if (!record || record.label !== 'unpaid') {
        throw new Error('The contact has no manually-cleared paid label.');
      }
      record.whatsappAppliedAt = new Date().toISOString();
      record.whatsappAction = null;
      write(labels);
      return record;
    },
    pendingActions() {
      return Object.entries(read())
        .filter(([, record]) => record.whatsappAction)
        .map(([number, record]) => ({ number, ...record }));
    }
  };
}
