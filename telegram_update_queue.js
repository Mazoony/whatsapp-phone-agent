import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const TELEGRAM_UPDATE_QUEUE_FILE = path.join(DATA_DIR, 'telegram_update_queue.json');
export const TELEGRAM_AGENT_CONTROL_FILE = path.join(DATA_DIR, 'telegram_agent_control.json');
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

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
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, filePath);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Telegram Queue] Could not clean temporary state file:', cleanupError.message);
    }
    throw error;
  }
}

function describe(entry, position, active = false) {
  const message = entry.update?.message || {};
  const user = message.from || {};
  const chat = message.chat || {};
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
    (user.username ? `@${user.username}` : `Telegram user ${user.id || ''}`);
  const messageType = Array.isArray(message.new_chat_members) && message.new_chat_members.length > 0
    ? 'Group join'
    : typeof message.text === 'string'
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
    ...(active ? {
      startedAt: entry.startedAt,
      detail: entry.detail || 'Processing Telegram update'
    } : {})
  };
}

function isGroupJoin(entry) {
  const members = entry.update?.message?.new_chat_members;
  return Array.isArray(members) && members.length > 0;
}

function getTrackSelectionIdentity(update) {
  const message = update?.message;
  const command = /^\/(?:lesson|grammar|literature|spine)(?:@[a-z0-9_]+)?(?:\s|$)/i;
  if (typeof message?.text !== 'string' || !command.test(message.text.trim()) ||
      !Number.isSafeInteger(message.from?.id) ||
      !Number.isSafeInteger(message.chat?.id)) {
    return null;
  }
  return `${message.chat.id}:${message.from.id}`;
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
    active: stored.active ? describe(stored.active, 1, true) : null,
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
    const trackSelectionIdentity = getTrackSelectionIdentity(update);
    if (trackSelectionIdentity) {
      this.waiting = this.waiting.filter(entry =>
        getTrackSelectionIdentity(entry.update) !== trackSelectionIdentity);
    }
    this.waiting.push({ update, queuedAt: new Date().toISOString() });
    this.persist();
  }

  isTrackSelection(entry) {
    return getTrackSelectionIdentity(entry?.update) !== null;
  }

  coalesceActiveTrackSelection(entry) {
    if (this.active !== entry) {
      throw new Error('Cannot coalesce a Telegram update that is not active.');
    }
    const identity = getTrackSelectionIdentity(entry.update);
    if (!identity) return false;
    let latestIndex = -1;
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      if (getTrackSelectionIdentity(this.waiting[index].update) === identity) {
        latestIndex = index;
        break;
      }
    }
    if (latestIndex < 0) return false;
    const latest = this.waiting[latestIndex];
    entry.update = latest.update;
    entry.queuedAt = latest.queuedAt;
    this.waiting = this.waiting.filter(candidate =>
      getTrackSelectionIdentity(candidate.update) !== identity);
    this.persist();
    return true;
  }

  updateActiveDetails(entry, detail) {
    if (this.active !== entry) {
      throw new Error('Cannot update details for a Telegram update that is not active.');
    }
    if (typeof detail !== 'string' || !detail.trim()) {
      throw new TypeError('Telegram update handling details must be a non-empty string.');
    }
    entry.detail = detail.trim().slice(0, 160);
    this.persist();
  }

  takeNext() {
    this.paused = readJsonFile(this.controlFile, { paused: false }).paused === true;
    if (this.paused || this.active || this.waiting.length === 0) return null;
    const nextGroupJoinIndex = this.waiting.findIndex(isGroupJoin);
    this.active = this.waiting.splice(nextGroupJoinIndex < 0 ? 0 : nextGroupJoinIndex, 1)[0];
    this.active.startedAt = new Date().toISOString();
    this.active.detail = 'Processing Telegram update';
    this.persist();
    return this.active;
  }

  isIdle() {
    return this.active === null && this.waiting.length === 0;
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
