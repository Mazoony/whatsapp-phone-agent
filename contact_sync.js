import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve('data');
export const CONTACT_SYNC_REQUESTS_FILE = path.join(DATA_DIR, 'contact_sync_requests.json');
export const CONTACT_SYNC_STATUS_FILE = path.join(DATA_DIR, 'contact_sync_status.json');
const POLL_INTERVAL_MS = 3000;

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

export class ContactSyncManager {
  constructor({
    requestsFile = CONTACT_SYNC_REQUESTS_FILE,
    statusFile = CONTACT_SYNC_STATUS_FILE,
    settleDelayMs = 3200
  } = {}) {
    this.requestsFile = requestsFile;
    this.statusFile = statusFile;
    this.settleDelayMs = settleDelayMs;
    this.socket = null;
    this.timer = null;
    this.running = false;
  }

  requests() {
    const requests = readJsonFile(this.requestsFile, []);
    if (!Array.isArray(requests)) throw new Error('Invalid contact refresh request queue.');
    return requests;
  }

  state() {
    const state = readJsonFile(this.statusFile, { jobs: {} });
    if (!state || typeof state.jobs !== 'object' || Array.isArray(state.jobs)) {
      throw new Error('Invalid contact refresh status file.');
    }
    return state;
  }

  queueRequest() {
    const request = {
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const requests = this.requests();
    requests.push(request);
    writeJsonFile(this.requestsFile, requests);
    return { ...request, status: 'queued' };
  }

  getStatus(id) {
    const state = this.state();
    const job = state.jobs[id];
    if (job) return { id, ...job };
    if (this.requests().some(request => request.id === id)) {
      return { id, status: 'queued' };
    }
    return null;
  }

  start(sock) {
    this.socket = sock;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.processNext(sock).catch(error =>
        console.error('[Contact Sync] Queue processing failed:', error.message));
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.processNext(sock).catch(error =>
      console.error('[Contact Sync] Queue processing failed:', error.message));
  }

  stop(sock) {
    if (sock && this.socket !== sock) return;
    this.socket = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async processNext(sock) {
    if (this.running || this.socket !== sock) return;

    const state = this.state();
    const request = this.requests().find(item =>
      !state.jobs[item.id] || state.jobs[item.id].status === 'queued'
    );
    if (!request) return;

    this.running = true;
    const job = {
      status: 'running',
      createdAt: request.createdAt,
      startedAt: new Date().toISOString()
    };
    state.jobs[request.id] = job;
    writeJsonFile(this.statusFile, state);

    try {
      await sock.resyncAppState(['critical_unblock_low'], false);
      if (this.settleDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.settleDelayMs));
      }
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date().toISOString();
      console.error('[Contact Sync] WhatsApp contact sync failed:', error.message);
    } finally {
      try {
        writeJsonFile(this.statusFile, state);
      } finally {
        this.running = false;
      }
    }
  }
}

export const contactSyncManager = new ContactSyncManager();
