import fs from 'node:fs';
import path from 'node:path';

export const INCOMING_CHAT_QUEUE_FILE = path.resolve('data', 'incoming_chat_queue.json');

function emptySnapshot() {
  return { active: null, waiting: [], paused: false, updatedAt: new Date().toISOString() };
}

export function readIncomingChatQueue(filePath = INCOMING_CHAT_QUEUE_FILE) {
  if (!fs.existsSync(filePath)) return emptySnapshot();
  const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!snapshot || !Array.isArray(snapshot.waiting)) {
    throw new Error(`Invalid incoming chat queue in ${filePath}`);
  }
  return snapshot;
}

export class IncomingChatQueue {
  constructor(filePath = INCOMING_CHAT_QUEUE_FILE) {
    this.filePath = filePath;
    this.active = null;
    this.waiting = [];
    this.paused = false;
    this.persist();
  }

  setPaused(paused) {
    if (typeof paused !== 'boolean') {
      throw new TypeError('Incoming chat queue pause state must be a boolean.');
    }
    this.paused = paused;
    this.persist();
  }

  enqueue(entry) {
    const existing = this.waiting.find(item => item.jid === entry.jid);
    if (existing) {
      existing.texts.push(...entry.texts);
      existing.images.push(...entry.images);
      existing.pushName = entry.pushName || existing.pushName;
      existing.senderNumber = entry.senderNumber || existing.senderNumber;
      existing.ready = false;
      this.persist();
      return existing;
    }
    entry.ready = false;
    this.waiting.push(entry);
    this.persist();
    return entry;
  }

  delay(entry) {
    if (this.waiting.includes(entry)) {
      entry.ready = false;
      this.persist();
    }
  }

  markReady(entry) {
    if (!this.waiting.includes(entry)) return;
    entry.ready = true;
    this.persist();
  }

  cancelWaiting(jid) {
    const index = this.waiting.findIndex(entry => entry.jid === jid);
    if (index < 0) return null;
    const [entry] = this.waiting.splice(index, 1);
    this.persist();
    return entry;
  }

  takeNext() {
    if (this.paused || this.active || this.waiting.length === 0 || !this.waiting[0].ready) return null;
    this.active = this.waiting.shift();
    this.active.startedAt = new Date().toISOString();
    this.persist();
    return this.active;
  }

  finish(entry) {
    if (this.active !== entry) {
      throw new Error('Cannot finish a chat that is not currently being handled.');
    }
    this.active = null;
    this.persist();
  }

  snapshot() {
    const describe = (entry, position) => ({
      jid: entry.jid,
      name: entry.pushName || entry.jid.split('@')[0],
      position,
      queuedAt: entry.queuedAt,
      ...(position === 1 ? { startedAt: entry.startedAt } : {})
    });
    return {
      active: this.active ? describe(this.active, 1) : null,
      waiting: this.waiting.map((entry, index) =>
        describe(entry, index + (this.active ? 2 : 1))),
      paused: this.paused,
      updatedAt: new Date().toISOString()
    };
  }

  persist() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const snapshot = this.snapshot();
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(snapshot), 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Agent Queue] Could not clean temporary queue state:', cleanupError.message);
      }
      console.error('[Agent Queue] Could not persist incoming chat order:', error.message);
    }
  }
}
