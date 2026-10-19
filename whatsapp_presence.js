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
    if (error instanceof SyntaxError) {
      error.message = `Invalid JSON in ${filePath}: ${error.message}`;
    }
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

function readPresenceState(filePath, fallback) {
  try {
    return readJsonFile(filePath, fallback);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backupPath = `${filePath}.corrupt-${Date.now()}-${process.pid}.bak`;
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    writeJsonFile(filePath, fallback);
    console.error(`[WhatsApp Presence] Invalid presence JSON was preserved at ${backupPath}; starting with empty presence data.`);
    return fallback;
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
    const state = readPresenceState(this.presenceFile, { presences: {}, history: {} });
    if (!state || typeof state.presences !== 'object' || Array.isArray(state.presences)) {
      throw new Error('WhatsApp presence data file is invalid.');
    }
    if (!state.history) state.history = {};
    if (typeof state.history !== 'object' || Array.isArray(state.history)) {
      throw new Error('WhatsApp presence history file is invalid.');
    }
    let updated = 0;
    for (const [participant, presence] of Object.entries(update.presences)) {
      const status = presence?.lastKnownPresence;
      if (!['available', 'unavailable'].includes(status)) continue;
      const identifiers = new Set([update.id, participant].filter(isPresenceJid));
      if (!identifiers.size) continue;
      for (const jid of identifiers) {
        const normalizedStatus = status === 'available' ? 'online' : 'offline';
        if (!Array.isArray(state.history[jid])) state.history[jid] = [];
        if (!state.history[jid].length) {
          state.history[jid].push({
            status: normalizedStatus,
            at: new Date(now).toISOString()
          });
        } else if (state.presences[jid]?.status !== normalizedStatus &&
            state.history[jid].at(-1)?.status !== normalizedStatus) {
          state.history[jid].push({
            status: normalizedStatus,
            at: new Date(now).toISOString()
          });
        }
        state.presences[jid] = {
          status: normalizedStatus,
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

  getMetrics(jids, days, now = Date.now()) {
    if (!Array.isArray(jids) || ![30, 90].includes(days)) {
      throw new Error('Presence metrics require direct chat IDs and a 30- or 90-day range.');
    }
    const state = readPresenceState(this.presenceFile, { presences: {}, history: {} });
    if (!state || typeof state.presences !== 'object' || Array.isArray(state.presences) ||
        (state.history && (typeof state.history !== 'object' || Array.isArray(state.history)))) {
      throw new Error('WhatsApp presence history file is invalid.');
    }
    const uniqueJids = [...new Set(jids.filter(isPresenceJid))];
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const allEvents = uniqueJids.flatMap(jid => {
      const history = Array.isArray(state.history?.[jid]) ? state.history[jid] : [];
      return history
        .filter(event => event && ['online', 'offline'].includes(event.status) &&
          typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)))
        .map(event => ({ status: event.status, at: Date.parse(event.at) }));
    }).sort((left, right) => left.at - right.at);
    const events = allEvents.filter((event, index) =>
      index === 0 || event.at !== allEvents[index - 1].at ||
      event.status !== allEvents[index - 1].status
    );
    const precedingEvent = [...events].reverse().find(event => event.at < cutoff);
    const rangedEvents = events.filter(event => event.at >= cutoff && event.at <= now);
    const timelineEvents = [
      ...(precedingEvent ? [precedingEvent] : []),
      ...rangedEvents
    ];
    const currentPresence = uniqueJids
      .map(jid => state.presences[jid])
      .filter(entry => entry && ['online', 'offline'].includes(entry.status) &&
        typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt)))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] || null;
    const lastTransition = events.filter(event => event.at <= now).at(-1) || null;
    const lastObservedAt = currentPresence
      ? Date.parse(currentPresence.updatedAt)
      : lastTransition?.at || null;
    const isCurrentFresh = lastObservedAt !== null &&
      lastObservedAt <= now && now - lastObservedAt <= this.maxAgeMs;
    const summary = {
      days,
      currentStatus: isCurrentFresh && currentPresence ? currentPresence.status : 'unknown',
      lastObservedStatus: currentPresence?.status || lastTransition?.status || 'unknown',
      lastObservedAt: lastObservedAt ? new Date(lastObservedAt).toISOString() : null,
      lastSeenAt: typeof currentPresence?.lastSeenAt === 'string' &&
        Number.isFinite(Date.parse(currentPresence.lastSeenAt))
        ? currentPresence.lastSeenAt
        : null,
      historyStartedAt: events[0] ? new Date(events[0].at).toISOString() : null,
      transitions: 0,
      onlineDurationMs: 0,
      offlineDurationMs: 0,
      unknownDurationMs: 0,
      untrackedDurationMs: 0,
      sessions: []
    };
    const periodStartEvent = events.find(event => event.at <= now);
    if (!periodStartEvent || periodStartEvent.at > cutoff) {
      summary.untrackedDurationMs = periodStartEvent
        ? Math.max(0, periodStartEvent.at - cutoff)
        : days * 24 * 60 * 60 * 1000;
    }

    for (let index = 0; index < timelineEvents.length; index += 1) {
      const event = timelineEvents[index];
      const nextEvent = timelineEvents[index + 1];
      const start = Math.max(event.at, cutoff);
      let end = nextEvent?.at ?? now;
      if (!nextEvent && !isCurrentFresh) {
        end = Math.min(end, (lastObservedAt || event.at) + this.maxAgeMs);
      }
      end = Math.min(end, now);
      const durationMs = Math.max(0, end - start);
      if (event.at >= cutoff) summary.transitions += 1;
      if (event.status === 'online') summary.onlineDurationMs += durationMs;
      else summary.offlineDurationMs += durationMs;
      if (durationMs > 0 || (!nextEvent && event.at <= now)) {
        summary.sessions.push({
          status: event.status,
          startedAt: new Date(start).toISOString(),
          endedAt: nextEvent && nextEvent.at <= now && nextEvent.at >= cutoff
            ? new Date(nextEvent.at).toISOString()
            : null,
          durationMs,
          ongoing: !nextEvent
        });
      }
    }

    const latestEvent = timelineEvents.at(-1);
    if (latestEvent && !isCurrentFresh) {
      const gapStart = Math.max(cutoff, (lastObservedAt || latestEvent.at) + this.maxAgeMs);
      summary.unknownDurationMs += Math.max(0, now - gapStart);
    }
    summary.sessions = summary.sessions.slice(-30).reverse();
    return summary;
  }

  getPresence(...jids) {
    const state = readPresenceState(this.presenceFile, { presences: {}, history: {} });
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
