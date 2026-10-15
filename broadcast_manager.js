import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { historyManager } from './history.js';
import { sendHumanizedMessage } from './humanization.js';
import { followUpManager } from './followup_manager.js';
import { getEligibleBroadcastContacts } from './broadcast_utils.js';
import { getPhoneJid } from './phonebook.js';

const DATA_DIR = path.resolve('data');
const REQUESTS_FILE = path.join(DATA_DIR, 'broadcast_requests.json');
const MESSAGE_REQUESTS_FILE = path.join(DATA_DIR, 'message_requests.json');
const STATE_FILE = path.join(DATA_DIR, 'broadcast_state.json');
const POLL_INTERVAL_MS = 3000;
const SEND_GAP_MS = 5_000;

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function emptyState() {
  return { jobs: {} };
}

function phoneNumberFromJid(jid) {
  return jid.slice(0, -'@s.whatsapp.net'.length).split(':')[0];
}

function ownPhoneNumber(sock) {
  const ownJid = sock.user?.id;
  return ownJid?.endsWith('@s.whatsapp.net') ? phoneNumberFromJid(ownJid) : '';
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class BroadcastManager {
  constructor() {
    this.socket = null;
    this.timer = null;
    this.running = false;
  }

  start(sock) {
    this.socket = sock;
    if (this.timer) clearInterval(this.timer);
    const state = this.state();
    let recovered = false;
    for (const request of this.messageRequests()) {
      if (state.jobs[request.id]?.status === 'sending') {
        state.jobs[request.id].status = 'uncertain';
        state.jobs[request.id].completedAt = new Date().toISOString();
        recovered = true;
      }
    }
    if (recovered) this.saveState(state);
    this.timer = setInterval(() => {
      this.processNext(sock).catch(error =>
        console.error('[Broadcast] Queue processing failed:', error.message));
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.processNext(sock).catch(error =>
      console.error('[Broadcast] Queue processing failed:', error.message));
  }

  stop(sock) {
    if (sock && this.socket !== sock) return;
    this.socket = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  requests() {
    return readJsonFile(REQUESTS_FILE, []);
  }

  messageRequests() {
    return readJsonFile(MESSAGE_REQUESTS_FILE, []);
  }

  state() {
    const state = readJsonFile(STATE_FILE, emptyState());
    if (!state || typeof state.jobs !== 'object' || Array.isArray(state.jobs)) {
      throw new Error(`Invalid persisted broadcast state in ${STATE_FILE}`);
    }
    return state;
  }

  saveState(state) {
    writeJsonFile(STATE_FILE, state);
  }

  async processNext(sock) {
    if (this.running || this.socket !== sock) return;

    const requests = this.requests();
    const messageRequests = this.messageRequests();
    const state = this.state();
    const messageRequest = messageRequests.find(request => {
      const status = state.jobs[request.id]?.status;
      return !status || status === 'queued';
    });
    const job = requests.find(request => {
      const status = state.jobs[request.id]?.status;
      return !request.cancelled && (!status || status === 'queued' || status === 'running');
    });
    if (!messageRequest && !job) return;

    this.running = true;
    followUpManager.stop(sock);
    try {
      while (followUpManager.running && this.socket === sock) {
        await delay(100);
      }
      if (this.socket !== sock) return;
      if (messageRequest) await this.runDirectMessage(sock, messageRequest);
      else await this.runJob(sock, job);
    } finally {
      this.running = false;
      if (this.socket === sock) followUpManager.start(sock, 0);
    }
  }

  async runDirectMessage(sock, request) {
    const state = this.state();
    const messageState = {
      status: 'sending',
      createdAt: request.createdAt,
      startedAt: new Date().toISOString()
    };
    state.jobs[request.id] = messageState;
    this.saveState(state);

    const phoneJid = getPhoneJid(request.jid, historyManager.contacts[request.jid]?.jid);
    const phoneNumber = phoneJid
      ? phoneNumberFromJid(phoneJid)
      : '';
    const optedOutJids = followUpManager.state.optedOutJids || [];
    const isOptedOut = optedOutJids.some(jid => {
      if (jid === request.jid || jid === `${phoneNumber}@s.whatsapp.net`) return true;
      const optedOutPhoneJid = getPhoneJid(jid, historyManager.contacts[jid]?.jid);
      return Boolean(phoneNumber && optedOutPhoneJid === `${phoneNumber}@s.whatsapp.net`);
    });
    const isOwnerBlocked = Object.entries(historyManager.contacts).some(([jid, contact]) =>
      contact.ownerBlocked &&
      (jid === request.jid ||
        getPhoneJid(jid, contact.jid) === `${phoneNumber}@s.whatsapp.net`));

    if (!phoneNumber || isOptedOut || isOwnerBlocked || !config.shouldReplyTo(phoneNumber) ||
        phoneNumber === ownPhoneNumber(sock)) {
      messageState.status = 'rejected';
      messageState.error = isOptedOut
        ? 'Contact opted out.'
        : 'Contact is unavailable or blocked.';
      messageState.completedAt = new Date().toISOString();
      this.saveState(state);
      return;
    }

    try {
      await sendHumanizedMessage(sock, request.jid, request.text, config.typingWordsPerMinute);
      messageState.status = 'sent';
      messageState.completedAt = new Date().toISOString();
      this.saveState(state);
      historyManager.addMessage(request.jid, 'agent', request.text);
    } catch (error) {
      messageState.status = 'uncertain';
      messageState.error = error.message;
      messageState.completedAt = new Date().toISOString();
      this.saveState(state);
      console.error(`[Message] Send to ${phoneNumber.slice(-4)} failed; result may be uncertain:`, error.message);
    }
  }

  async runJob(sock, job) {
    const state = this.state();
    let jobState = state.jobs[job.id] || {
      status: 'queued',
      total: job.jids.length,
      sent: 0,
      skipped: 0,
      uncertain: 0,
      nextIndex: 0,
      createdAt: job.createdAt
    };

    if (jobState.inFlightJid) {
      jobState.uncertain += 1;
      jobState.nextIndex += 1;
      jobState.inFlightJid = null;
      console.warn('[Broadcast] A previous send has an uncertain result; skipping it to avoid a duplicate.');
    }

    jobState.status = 'running';
    jobState.startedAt ||= new Date().toISOString();
    state.jobs[job.id] = jobState;
    this.saveState(state);

    while (jobState.nextIndex < job.jids.length && this.socket === sock) {
      const currentRequest = this.requests().find(request => request.id === job.id);
      if (!currentRequest || currentRequest.cancelled) {
        jobState.status = 'cancelled';
        break;
      }

      const jid = job.jids[jobState.nextIndex];
      const eligible = getEligibleBroadcastContacts({
        contacts: historyManager.contacts,
        history: historyManager.history
      }, followUpManager.state.optedOutJids);
      const contact = eligible.find(candidate => candidate.jid === jid);
      const ownNumber = ownPhoneNumber(sock);
      if (!contact || (ownNumber && contact.phoneNumber === ownNumber)) {
        jobState.skipped += 1;
        jobState.nextIndex += 1;
        state.jobs[job.id] = jobState;
        this.saveState(state);
        continue;
      }

      jobState.inFlightJid = jid;
      state.jobs[job.id] = jobState;
      this.saveState(state);

      try {
        await sendHumanizedMessage(sock, jid, job.text, config.typingWordsPerMinute);
        historyManager.addMessage(jid, 'agent', job.text);
        jobState.sent += 1;
      } catch (error) {
        jobState.uncertain += 1;
        console.error(`[Broadcast] Send to ${contact.phoneNumber.slice(-4)} failed; result may be uncertain:`, error.message);
      }

      jobState.nextIndex += 1;
      jobState.inFlightJid = null;
      state.jobs[job.id] = jobState;
      this.saveState(state);

      if (jobState.nextIndex < job.jids.length && this.socket === sock) {
        await this.waitBetweenSends(sock, job.id);
      }
    }

    if (jobState.status !== 'cancelled') {
      jobState.status = jobState.nextIndex >= job.jids.length ? 'completed' : 'queued';
    }
    jobState.completedAt = ['completed', 'cancelled'].includes(jobState.status)
      ? new Date().toISOString()
      : null;
    state.jobs[job.id] = jobState;
    this.saveState(state);
    console.log(`[Broadcast] Job ${job.id}: ${jobState.sent} sent, ${jobState.skipped} skipped, ${jobState.uncertain} uncertain.`);
  }

  async waitBetweenSends(sock, jobId) {
    const deadline = Date.now() + SEND_GAP_MS;
    while (this.socket === sock && Date.now() < deadline) {
      const request = this.requests().find(item => item.id === jobId);
      if (!request || request.cancelled) return;
      await delay(Math.min(1000, deadline - Date.now()));
    }
  }
}

export const broadcastManager = new BroadcastManager();
