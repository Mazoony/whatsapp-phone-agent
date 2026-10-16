import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WHATSAPP_CHAT_ACTIVITY_FILE = path.join(ROOT_DIR, 'data', 'whatsapp_chat_activity.json');

function timestampValue(value) {
  if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function isDirectChat(jid) {
  return typeof jid === 'string' &&
    (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

export class WhatsAppChatActivityStore {
  constructor(filePath = WHATSAPP_CHAT_ACTIVITY_FILE) {
    this.filePath = filePath;
  }

  read() {
    if (!fs.existsSync(this.filePath)) return {};
    const activity = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
      throw new Error(`Invalid WhatsApp chat activity in ${this.filePath}`);
    }
    return activity;
  }

  record(chats) {
    if (!Array.isArray(chats)) {
      throw new TypeError('WhatsApp chat activity must be recorded from a chat list.');
    }
    const activity = this.read();
    let changed = false;
    for (const chat of chats) {
      const jid = chat?.id;
      if (!isDirectChat(jid)) continue;
      const timestamp = Math.max(
        timestampValue(chat.conversationTimestamp) || 0,
        timestampValue(chat.lastMessageRecvTimestamp) || 0
      );
      if (!timestamp || timestamp <= (Number(activity[jid]) || 0)) continue;
      activity[jid] = timestamp;
      changed = true;
    }
    if (changed) this.write(activity);
    return changed;
  }

  recordMessage(jid, timestamp) {
    if (!isDirectChat(jid)) return false;
    const value = timestampValue(timestamp);
    if (!value) return false;
    return this.record([{ id: jid, conversationTimestamp: value }]);
  }

  write(activity) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(activity), 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[WhatsApp Chat Activity] Could not clean temporary activity file:', cleanupError.message);
      }
      throw error;
    }
  }
}

export const whatsappChatActivityStore = new WhatsAppChatActivityStore();

export function timestampToMilliseconds(value) {
  return timestampValue(value);
}
