import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PAYMENT_RECEIPT_IMAGE_DIRECTORY = path.join(ROOT_DIR, 'data', 'payment_receipts');
const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_FORMATS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf']
]);

function getReceiptPath(receiptId, directory, mimeType = 'image/jpeg') {
  if (typeof receiptId !== 'string' || !RECEIPT_ID_PATTERN.test(receiptId)) {
    throw new Error('A valid receipt image ID is required.');
  }
  const extension = RECEIPT_FORMATS.get(mimeType);
  if (!extension) throw new Error('This receipt file type is not supported.');
  return path.join(directory, `${receiptId}.${extension}`);
}

export function validatePaymentReceiptUpload(image, mimeType) {
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new Error('Receipt file data is required.');
  }
  const matchesFormat = mimeType === 'image/jpeg'
    ? image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
    : mimeType === 'image/png'
      ? image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mimeType === 'image/webp'
        ? image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' &&
          image.toString('ascii', 8, 12) === 'WEBP'
        : mimeType === 'application/pdf'
          ? image.toString('ascii', 0, 5) === '%PDF-'
          : false;
  if (!matchesFormat) throw new Error('The receipt content does not match its file type.');
}

export function savePaymentReceiptImage(
  image,
  directory = PAYMENT_RECEIPT_IMAGE_DIRECTORY,
  mimeType = 'image/jpeg'
) {
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new Error('Receipt image data is required.');
  }
  const receiptId = crypto.randomUUID();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(getReceiptPath(receiptId, directory, mimeType), image, { flag: 'wx' });
  return receiptId;
}

export function readPaymentReceiptImage(
  receiptId,
  directory = PAYMENT_RECEIPT_IMAGE_DIRECTORY,
  mimeType = 'image/jpeg'
) {
  return fs.readFileSync(getReceiptPath(receiptId, directory, mimeType));
}

export function deletePaymentReceiptImage(
  receiptId,
  directory = PAYMENT_RECEIPT_IMAGE_DIRECTORY,
  mimeType = 'image/jpeg'
) {
  fs.rmSync(getReceiptPath(receiptId, directory, mimeType), { force: true });
}
