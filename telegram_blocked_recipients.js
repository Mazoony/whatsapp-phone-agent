import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const TELEGRAM_BLOCKED_RECIPIENTS_FILE = path.join(
  DATA_DIR,
  'telegram_blocked_recipients.json'
);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

function getPrivateChatId(chatId) {
  const value = String(chatId ?? '').trim();
  return /^\d+$/.test(value) ? value : null;
}

function readBlockedRecipients(filePath) {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!stored || typeof stored !== 'object' ||
        !stored.blockedPrivateChats ||
        typeof stored.blockedPrivateChats !== 'object' ||
        Array.isArray(stored.blockedPrivateChats)) {
      throw new Error('Invalid Telegram blocked-recipient data.');
    }
    return stored.blockedPrivateChats;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeBlockedRecipients(filePath, blockedPrivateChats) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({ blockedPrivateChats }, null, 2),
      'utf8'
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, filePath);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) ||
            attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error;
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          RENAME_RETRY_DELAYS_MS[attempt]
        );
      }
    }
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Telegram] Could not clean blocked-recipient state file:', cleanupError.message);
    }
    throw error;
  }
}

export function isTelegramPrivateChatBlocked(chatId, filePath = TELEGRAM_BLOCKED_RECIPIENTS_FILE) {
  const privateChatId = getPrivateChatId(chatId);
  if (!privateChatId) return false;
  return Object.prototype.hasOwnProperty.call(
    readBlockedRecipients(filePath),
    privateChatId
  );
}

export function getTelegramBlockedPrivateChatIds(filePath = TELEGRAM_BLOCKED_RECIPIENTS_FILE) {
  return new Set(Object.keys(readBlockedRecipients(filePath)));
}

export function markTelegramPrivateChatBlocked(
  chatId,
  filePath = TELEGRAM_BLOCKED_RECIPIENTS_FILE,
  blockedAt = new Date().toISOString()
) {
  const privateChatId = getPrivateChatId(chatId);
  if (!privateChatId) return false;
  const blockedPrivateChats = readBlockedRecipients(filePath);
  if (Object.prototype.hasOwnProperty.call(blockedPrivateChats, privateChatId)) return false;
  blockedPrivateChats[privateChatId] = blockedAt;
  writeBlockedRecipients(filePath, blockedPrivateChats);
  return true;
}

export function clearTelegramPrivateChatBlocked(
  chatId,
  filePath = TELEGRAM_BLOCKED_RECIPIENTS_FILE
) {
  const privateChatId = getPrivateChatId(chatId);
  if (!privateChatId) return false;
  const blockedPrivateChats = readBlockedRecipients(filePath);
  if (!Object.prototype.hasOwnProperty.call(blockedPrivateChats, privateChatId)) return false;
  delete blockedPrivateChats[privateChatId];
  writeBlockedRecipients(filePath, blockedPrivateChats);
  return true;
}

export function isTelegramBotBlockedError(error) {
  return /bot was blocked by the user/i.test(
    error instanceof Error ? error.message : String(error ?? '')
  );
}
