import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const TELEGRAM_UPDATE_QUEUE_FILE = path.join(DATA_DIR, 'telegram_update_queue.json');
export const TELEGRAM_AGENT_CONTROL_FILE = path.join(DATA_DIR, 'telegram_agent_control.json');

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Telegram Queue] Could not clean temporary state file:', cleanupError.message);
    }
    throw error;
  }
}

function describe(entry, position) {
  const message = entry.update?.message || {};
  const user = message.from || {};
  const chat = message.chat || {};
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
    (user.username ? `@${user.username}` : `Telegram user ${user.id || ''}`);
  const messageType = typeof message.text === 'string'
    ? 'Text'
    : message.photo?.length
      ? 'Photo'
      : message.video
        ? 'Video'
        : message.document
          ? 'Document'
          : 'Media';
  return {
    id: String(entry.update.update_id),
    name: name || 'Telegram user',
    chat: chat.title || (chat.type === 'private' ? 'Private chat' : `Telegram ${chat.type || 'chat'}`),
    messageType,
    position,
    queuedAt: entry.queuedAt,
    ...(position === 1 ? { startedAt: entry.startedAt } : {})
  };
}

export function readTelegramUpdateQueue(
  queueFile = TELEGRAM_UPDATE_QUEUE_FILE,
  controlFile = TELEGRAM_AGENT_CONTROL_FILE
) {
  const stored = readJsonFile(queueFile, { active: null, waiting: [], updatedAt: null });
  const control = readJsonFile(controlFile, { paused: false });
  if (!stored || !Array.isArray(stored.waiting)) {
    throw new Error(`Invalid Telegram update queue in ${queueFile}.`);
  }
  return {
    active: stored.active ? describe(stored.active, 1) : null,
    waiting: stored.waiting.map((entry, index) =>
      describe(entry, index + (stored.active ? 2 : 1))),
    paused: control.paused === true,
    updatedAt: stored.updatedAt || null
  };
}

export function setTelegramUpdateQueuePaused(
  paused,
  controlFile = TELEGRAM_AGENT_CONTROL_FILE
) {
  if (typeof paused !== 'boolean') {
    throw new TypeError('Telegram update queue pause state must be a boolean.');
  }
  const control = { paused, updatedAt: new Date().toISOString() };
  writeJsonAtomically(controlFile, control);
  return control;
}

export class TelegramUpdateQueue {
  constructor({
    queueFile = TELEGRAM_UPDATE_QUEUE_FILE,
    controlFile = TELEGRAM_AGENT_CONTROL_FILE
  } = {}) {
    this.queueFile = queueFile;
    this.controlFile = controlFile;
    const stored = readJsonFile(queueFile, { active: null, waiting: [] });
    if (!stored || !Array.isArray(stored.waiting)) {
      throw new Error(`Invalid Telegram update queue in ${queueFile}.`);
    }
    this.active = null;
    this.waiting = [
      ...(stored.active ? [{ ...stored.active, startedAt: undefined }] : []),
      ...stored.waiting
    ];
    this.paused = readJsonFile(controlFile, { paused: false }).paused === true;
    this.persist();
  }

  enqueue(update) {
    if (!Number.isSafeInteger(update?.update_id)) {
      throw new TypeError('A Telegram update with a valid update_id is required.');
    }
    if (this.active?.update?.update_id === update.update_id ||
        this.waiting.some(entry => entry.update?.update_id === update.update_id)) return;
    this.waiting.push({ update, queuedAt: new Date().toISOString() });
    this.persist();
  }

  takeNext() {
    this.paused = readJsonFile(this.controlFile, { paused: false }).paused === true;
    if (this.paused || this.active || this.waiting.length === 0) return null;
    this.active = this.waiting.shift();
    this.active.startedAt = new Date().toISOString();
    this.persist();
    return this.active;
  }

  finish(entry) {
    if (this.active !== entry) {
      throw new Error('Cannot finish a Telegram update that is not active.');
    }
    this.active = null;
    this.persist();
  }

  persist() {
    writeJsonAtomically(this.queueFile, {
      active: this.active,
      waiting: this.waiting,
      updatedAt: new Date().toISOString()
    });
  }
}
