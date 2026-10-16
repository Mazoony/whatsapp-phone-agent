import fs from 'node:fs';
import path from 'node:path';

export const CHAT_READ_STATE_FILE = path.resolve('data', 'chat_read_state.json');

function latestIncomingTimestamp(messages) {
  return messages.reduce((latest, message) => {
    if (message.role !== 'client') return latest;
    const numericTimestamp = Number(message.timestamp);
    const rawTimestamp = Number.isFinite(numericTimestamp)
      ? numericTimestamp
      : Date.parse(message.timestamp);
    const timestamp = rawTimestamp > 0 && rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
}

export class ChatReadStateStore {
  constructor(filePath = CHAT_READ_STATE_FILE) {
    this.filePath = filePath;
  }

  read() {
    if (!fs.existsSync(this.filePath)) return {};
    const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error(`Invalid chat read state in ${this.filePath}`);
    }
    return state;
  }

  ensureInitialized(history) {
    if (fs.existsSync(this.filePath)) return this.read();
    const state = Object.fromEntries(Object.entries(history).map(([jid, messages]) => [
      jid,
      latestIncomingTimestamp(messages)
    ]));
    this.write(state);
    return state;
  }

  markRead(jid, messages) {
    const state = this.read();
    const lastIncomingAt = latestIncomingTimestamp(messages);
    if (Number(state[jid] || 0) === lastIncomingAt) return state;
    state[jid] = lastIncomingAt;
    this.write(state);
    return state;
  }

  write(state) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(state), 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Dashboard] Could not clean temporary chat read state:', cleanupError.message);
      }
      throw error;
    }
  }
}

export function getChatReadStatus(messages, lastReadAt = 0) {
  const lastIncomingAt = latestIncomingTimestamp(messages);
  return {
    lastIncomingAt,
    unread: lastIncomingAt > Number(lastReadAt || 0)
  };
}
