import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PAYMENT_RECEIPT_IMAGE_DIRECTORY = path.join(ROOT_DIR, 'data', 'payment_receipts');
const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getReceiptPath(receiptId, directory) {
  if (typeof receiptId !== 'string' || !RECEIPT_ID_PATTERN.test(receiptId)) {
    throw new Error('A valid receipt image ID is required.');
  }
  return path.join(directory, `${receiptId}.jpg`);
}

export function savePaymentReceiptImage(image, directory = PAYMENT_RECEIPT_IMAGE_DIRECTORY) {
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new Error('Receipt image data is required.');
  }
  const receiptId = crypto.randomUUID();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(getReceiptPath(receiptId, directory), image, { flag: 'wx' });
  return receiptId;
}

export function readPaymentReceiptImage(receiptId, directory = PAYMENT_RECEIPT_IMAGE_DIRECTORY) {
  return fs.readFileSync(getReceiptPath(receiptId, directory));
}

export function deletePaymentReceiptImage(receiptId, directory = PAYMENT_RECEIPT_IMAGE_DIRECTORY) {
  fs.rmSync(getReceiptPath(receiptId, directory), { force: true });
}
