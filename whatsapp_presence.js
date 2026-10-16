import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
export const WHATSAPP_PRESENCE_FILE = path.join(DATA_DIR, 'whatsapp_presence.json');
export const WHATSAPP_PRESENCE_REQUESTS_FILE = path.join(DATA_DIR, 'whatsapp_presence_requests.json');
const PRESENCE_MAX_AGE_MS = 2 * 60 * 1000;
const REQUEST_MAX_AGE_MS = 2 * 60 * 1000;
const REQUEST_COOLDOWN_MS = REQUEST_MAX_AGE_MS;
const POLL_INTERVAL_MS = 3000;
const MAX_PRESENCES = 2000;
const MAX_REQUESTS = 100;
const MAX_SUBSCRIPTION_ATTEMPTS = 3;

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.error('[WhatsApp Presence] Could not clean up a temporary file:', cleanupError.message);
      }
    }
    throw error;
  }
}

function isPresenceJid(jid) {
  return typeof jid === 'string' &&
    /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid);
}

function readRequests(filePath) {
  const requests = readJsonFile(filePath, []);
  if (!Array.isArray(requests) || requests.some(request =>
    !request || typeof request.id !== 'string' || !isPresenceJid(request.jid) ||
    typeof request.requestedAt !== 'string')) {
    throw new Error('WhatsApp presence subscription queue is invalid.');
  }
  return requests;
}

function presenceTimestamp(lastSeen) {
  const value = Number(lastSeen);
  if (!Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 1e12 ? value * 1000 : value;
  if (milliseconds > Date.now() + 60_000) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export class WhatsAppPresenceManager {
  constructor({
    presenceFile = WHATSAPP_PRESENCE_FILE,
    requestsFile = WHATSAPP_PRESENCE_REQUESTS_FILE,
    pollIntervalMs = POLL_INTERVAL_MS,
    maxAgeMs = PRESENCE_MAX_AGE_MS
  } = {}) {
    this.presenceFile = presenceFile;
    this.requestsFile = requestsFile;
    this.pollIntervalMs = pollIntervalMs;
    this.maxAgeMs = maxAgeMs;
    this.socket = null;
    this.timer = null;
    this.running = false;
    this.attempts = new Map();
    this.completedRequests = new Set();
  }

  requestSubscription(jid, now = Date.now()) {
    return this.requestSubscriptions([jid], now)[0];
  }

  requestSubscriptions(jids, now = Date.now()) {
    if (!Array.isArray(jids) || jids.length < 1 || jids.length > 30 ||
        jids.some(jid => !isPresenceJid(jid))) {
      throw new Error('Provide between 1 and 30 valid direct WhatsApp chat IDs.');
    }
    const requests = readRequests(this.requestsFile)
      .filter(request => now - Date.parse(request.requestedAt) <= REQUEST_MAX_AGE_MS);
    const uniqueJids = [...new Set(jids)];
    let changed = false;
    const results = uniqueJids.map(jid => {
      const recentRequest = requests.find(request =>
        request.jid === jid && now - Date.parse(request.requestedAt) < REQUEST_COOLDOWN_MS
      );
      if (recentRequest) {
        return { jid, status: 'already-requested', requestedAt: recentRequest.requestedAt };
      }
      const request = {
        id: randomUUID(),
        jid,
        requestedAt: new Date(now).toISOString()
      };
      requests.push(request);
      changed = true;
      return { jid, status: 'queued', requestedAt: request.requestedAt };
    });
    if (changed) writeJsonFile(this.requestsFile, requests.slice(-MAX_REQUESTS));
    return results;
  }

  recordPresenceUpdate(update, now = Date.now()) {
    if (!update || !isPresenceJid(update.id) ||
        !update.presences || typeof update.presences !== 'object') return 0;
    const state = readJsonFile(this.presenceFile, { presences: {} });
    if (!state || typeof state.presences !== 'object' || Array.isArray(state.presences)) {
      throw new Error('WhatsApp presence data file is invalid.');
    }
    let updated = 0;
    for (const [participant, presence] of Object.entries(update.presences)) {
      const status = presence?.lastKnownPresence;
      if (!['available', 'unavailable'].includes(status)) continue;
      const identifiers = new Set([update.id, participant].filter(isPresenceJid));
      if (!identifiers.size) continue;
      for (const jid of identifiers) {
        state.presences[jid] = {
          status: status === 'available' ? 'online' : 'offline',
          updatedAt: new Date(now).toISOString(),
          lastSeenAt: presenceTimestamp(presence.lastSeen) ||
            state.presences[jid]?.lastSeenAt ||
            null
        };
        updated += 1;
      }
    }
    if (updated) {
      const recentPresences = Object.entries(state.presences)
        .sort((left, right) => Date.parse(right[1]?.updatedAt || '') -
          Date.parse(left[1]?.updatedAt || ''))
        .slice(0, MAX_PRESENCES);
      state.presences = Object.fromEntries(recentPresences);
      writeJsonFile(this.presenceFile, state);
    }
    return updated;
  }

  getPresence(...jids) {
    const state = readJsonFile(this.presenceFile, { presences: {} });
    if (!state || typeof state.presences !== 'object' || Array.isArray(state.presences)) {
      throw new Error('WhatsApp presence data file is invalid.');
    }
    const candidates = [...new Set(jids.filter(isPresenceJid))];
    const presence = candidates
      .map(jid => state.presences[jid])
      .filter(entry => entry && ['online', 'offline'].includes(entry.status) &&
        typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt)))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!presence) return null;
    const fresh = Date.now() - Date.parse(presence.updatedAt) <= this.maxAgeMs;
    return {
      status: fresh ? presence.status : 'unknown',
      updatedAt: presence.updatedAt,
      lastSeenAt: typeof presence.lastSeenAt === 'string' &&
        Number.isFinite(Date.parse(presence.lastSeenAt))
        ? presence.lastSeenAt
        : null
    };
  }

  start(sock) {
    if (!sock || typeof sock.presenceSubscribe !== 'function') {
      throw new Error('The connected WhatsApp client cannot subscribe to presence updates.');
    }
    this.stop();
    this.socket = sock;
    this.timer = setInterval(() => {
      this.processRequests(sock).catch(error =>
        console.error('[WhatsApp Presence] Could not process subscriptions:', error.message));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    this.processRequests(sock).catch(error =>
      console.error('[WhatsApp Presence] Could not process subscriptions:', error.message));
  }

  stop() {
    this.socket = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.attempts.clear();
    this.completedRequests.clear();
  }

  async processRequests(sock) {
    if (this.running || this.socket !== sock) return;
    this.running = true;
    try {
      const now = Date.now();
      const request = readRequests(this.requestsFile).find(item =>
        !this.completedRequests.has(item.id) &&
        now - Date.parse(item.requestedAt) <= REQUEST_MAX_AGE_MS
      );
      if (!request || this.socket !== sock) return;
      try {
        await sock.presenceSubscribe(request.jid);
        this.completedRequests.add(request.id);
        this.attempts.delete(request.id);
      } catch (error) {
        const attempts = (this.attempts.get(request.id) || 0) + 1;
        this.attempts.set(request.id, attempts);
        if (attempts >= MAX_SUBSCRIPTION_ATTEMPTS) {
          this.completedRequests.add(request.id);
          console.error(`[WhatsApp Presence] Could not subscribe to ${request.jid} after ${attempts} attempts:`, error.message);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
