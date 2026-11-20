import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HISTORICAL_PAYMENT_RECEIPTS_FILE = path.join(
  ROOT_DIR,
  'data',
  'historical_payment_receipts.json'
);

function normalizeTimestamp(value, fieldName) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${fieldName} must be a valid date.`);
  }
  return new Date(value).toISOString();
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id) ||
      typeof record.studentKey !== 'string' || !record.studentKey.trim() ||
      typeof record.name !== 'string' ||
      typeof record.gradeName !== 'string' ||
      typeof record.receiptId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.receiptId) ||
      !Number.isFinite(record.amount) || record.amount <= 0 ||
      typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency) ||
      typeof record.mimeType !== 'string' ||
      !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(record.mimeType) ||
      typeof record.receiptHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.receiptHash) ||
      typeof record.paidAt !== 'string' || !Number.isFinite(Date.parse(record.paidAt)) ||
      typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new Error('Historical payment receipt record is invalid.');
  }
}

export function createHistoricalPaymentReceiptStore(filePath = HISTORICAL_PAYMENT_RECEIPTS_FILE) {
  function read() {
    let records;
    try {
      records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (!Array.isArray(records)) {
      throw new Error(`Invalid historical payment receipt file: ${filePath}`);
    }
    for (const record of records) validateRecord(record);
    return records;
  }

  function write(records) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), 'utf8');
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Historical Payments] Could not clean temporary file:', cleanupError.message);
      }
      throw error;
    }
  }

  return {
    list() {
      return read();
    },
    add({
      studentKey,
      name,
      gradeName,
      paidAt,
      amount,
      currency,
      receiptId,
      mimeType,
      image
    }) {
      if (typeof studentKey !== 'string' || !studentKey.trim()) {
        throw new Error('A student is required for a historical payment.');
      }
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('A student name is required for a historical payment.');
      }
      if (typeof gradeName !== 'string') {
        throw new Error('A student grade is required for a historical payment.');
      }
      const normalizedAmount = Number(amount);
      if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new Error('Payment amount must be greater than zero.');
      }
      const normalizedCurrency = String(currency || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
        throw new Error('Currency must be a three-letter code such as SDG or USD.');
      }
      if (!Buffer.isBuffer(image) || image.length === 0) {
        throw new Error('A receipt image is required.');
      }
      const normalizedPaidAt = normalizeTimestamp(paidAt, 'Payment date');
      const now = new Date().toISOString();
      const record = {
        id: crypto.randomUUID(),
        studentKey: studentKey.trim(),
        name: name.trim().slice(0, 180),
        gradeName: gradeName.trim().slice(0, 120),
        paidAt: normalizedPaidAt,
        amount: normalizedAmount,
        currency: normalizedCurrency,
        source: 'historical-receipt',
        receiptId,
        mimeType,
        receiptHash: crypto.createHash('sha256').update(image).digest('hex'),
        recordedAt: now
      };
      validateRecord(record);

      const records = read();
      if (records.some(existing => existing.receiptHash === record.receiptHash)) {
        throw new Error('This receipt has already been added.');
      }
      if (records.some(existing =>
        existing.studentKey === record.studentKey &&
        existing.paidAt.slice(0, 10) === record.paidAt.slice(0, 10) &&
        existing.amount === record.amount &&
        existing.currency === record.currency)) {
        throw new Error('An identical historical payment is already recorded for this student and date.');
      }
      records.push(record);
      write(records);
      return record;
    }
  };
}
