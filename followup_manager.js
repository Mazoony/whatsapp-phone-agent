import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { historyManager } from './history.js';
import { generateStudentFollowUp } from './ai.js';
import { sendHumanizedMessage } from './humanization.js';

const DATA_DIR = path.resolve('data');
const STATE_FILE = path.join(DATA_DIR, 'followup_state.json');
const OPT_OUT_PATTERN = /(?:^\s*(?:stop|unsubscribe|cancel)\s*[.!؟]*$|\b(?:stop|unsubscribe)\s+(?:sending|messages?|follow[- ]?ups?)\b|^\s*(?:إيقاف|ايقاف|إلغاء\s*المتابعة|الغاء\s*المتابعة)\s*[.!؟]*$|(?:إيقاف|ايقاف|وقف|أوقف|اوقف)\s+(?:الرسائل|المتابعة)|ما\s+ترسل(?:ي)?\s+لي(?:\s+تاني)?)/i;

function emptyState() {
  return {
    cohortJids: [],
    nextCycleAt: null,
    pendingJids: [],
    nextIndex: 0,
    inFlightJid: null,
    cycleNumber: 0,
    cycleStartedAt: null,
    optedOutJids: []
  };
}

function timestampInMilliseconds(timestamp) {
  const value = Number(timestamp) || 0;
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function latestMessageTime(messages) {
  return messages.reduce((latest, message) => {
    return Math.max(latest, timestampInMilliseconds(message.timestamp));
  }, 0);
}

function latestClientMessageTime(messages) {
  return latestMessageTime(messages.filter(message => message.role === 'client'));
}

function isDirectWhatsAppJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function phoneNumberFromJid(jid) {
  return jid.slice(0, jid.indexOf('@')).split(':')[0];
}

function ownWhatsAppJid(sock) {
  const ownId = sock.user?.id;
  const ownNumber = ownId && isDirectWhatsAppJid(ownId) ? phoneNumberFromJid(ownId) : '';
  return ownNumber ? `${ownNumber}@s.whatsapp.net` : null;
}

export function isFollowUpOptOutRequest(text) {
  return OPT_OUT_PATTERN.test(text || '');
}

export function getEligibleFollowUpContacts(
  contacts,
  history,
  maxContacts = 700,
  blockedJids = [],
  cohortJids = null
) {
  const blocked = new Set(blockedJids);
  const blockedNumbers = new Set(blockedJids.filter(isDirectWhatsAppJid).map(phoneNumberFromJid));
  const cohort = cohortJids ? new Set(cohortJids) : null;
  return Object.values(contacts)
    .filter(contact => {
      const jid = contact.jid;
      const phoneNumber = isDirectWhatsAppJid(jid) ? phoneNumberFromJid(jid) : '';
      const messages = history[jid];
      return contact.isEs &&
        isDirectWhatsAppJid(jid) &&
        !blocked.has(jid) &&
        !blockedNumbers.has(phoneNumber) &&
        (!cohort || cohort.has(jid)) &&
        config.shouldReplyTo(phoneNumber) &&
        Array.isArray(messages) &&
        messages.some(message => message.role === 'client');
    })
    .map(contact => ({
      jid: contact.jid,
      name: contact.name || contact.jid.slice(0, contact.jid.indexOf('@')),
      lastClientMessageAt: latestClientMessageTime(history[contact.jid])
    }))
    .sort((a, b) => b.lastClientMessageAt - a.lastClientMessageAt)
    .slice(0, maxContacts);
}

class FollowUpManager {
  constructor() {
    this.state = this.loadState();
    this.timer = null;
    this.socket = null;
    this.running = false;
  }

  loadState() {
    if (!fs.existsSync(STATE_FILE)) return emptyState();

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (!Array.isArray(state.cohortJids) ||
        !Array.isArray(state.pendingJids) ||
        !Array.isArray(state.optedOutJids) ||
        !Number.isInteger(state.nextIndex)) {
      throw new Error(`[Follow-up] Invalid persisted state in ${STATE_FILE}`);
    }
    return { ...emptyState(), ...state };
  }

  saveState() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  optOut(jid) {
    if (this.state.optedOutJids.includes(jid)) return false;
    this.state.optedOutJids.push(jid);
    this.saveState();
    console.log(`[Follow-up] ${jid} opted out of future follow-ups.`);
    return true;
  }

  start(sock, delayMs = config.followUpStartDelayMs) {
    if (!config.followUpsEnabled) return;
    this.socket = sock;
    if (this.running) return;
    if (this.timer) clearTimeout(this.timer);
    console.log(`[Follow-up] Enabled; initial/restart check in ${Math.ceil(delayMs / 1000)} seconds.`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runCampaign(sock).catch(err => {
        console.error('[Follow-up] Campaign failed:', err.message);
        this.schedule(sock, 5 * 60 * 1000);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  schedule(sock, delayMs) {
    if (!config.followUpsEnabled || this.socket !== sock) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runCampaign(sock).catch(err => {
        console.error('[Follow-up] Campaign failed:', err.message);
        this.schedule(sock, 5 * 60 * 1000);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  stop(sock) {
    if (sock && this.socket !== sock) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket = null;
  }

  beginCycle(sock) {
    const excludedJids = [...this.state.optedOutJids];
    const ownJid = ownWhatsAppJid(sock);
    if (ownJid) excludedJids.push(ownJid);

    if (!this.state.cohortJids.length) {
      const initialContacts = getEligibleFollowUpContacts(
        historyManager.contacts,
        historyManager.history,
        config.followUpMaxContacts,
        excludedJids
      );
      this.state.cohortJids = initialContacts.map(contact => contact.jid);
    }

    const targets = getEligibleFollowUpContacts(
      historyManager.contacts,
      historyManager.history,
      config.followUpMaxContacts,
      excludedJids,
      this.state.cohortJids
    );
    const cycleStartedAt = Date.now();

    this.state.pendingJids = targets.map(contact => contact.jid);
    this.state.nextIndex = 0;
    this.state.inFlightJid = null;
    this.state.cycleNumber += 1;
    this.state.cycleStartedAt = cycleStartedAt;
    this.state.nextCycleAt = null;
    this.saveState();
    console.log(`[Follow-up] Cycle ${this.state.cycleNumber} queued ${targets.length} opted-in Es contacts.`);
  }

  async runCampaign(sock) {
    if (!config.followUpsEnabled || this.running || this.socket !== sock) return;
    this.running = true;
    try {
      if (this.state.pendingJids.length === 0) {
        if (this.state.nextCycleAt && Date.now() < this.state.nextCycleAt) {
          this.schedule(sock, this.state.nextCycleAt - Date.now());
          return;
        }
        this.beginCycle(sock);
      }

      if (this.state.inFlightJid) {
        console.warn(`[Follow-up] Previous send to ${this.state.inFlightJid} has an uncertain result; skipping it to prevent a duplicate.`);
        this.state.nextIndex += 1;
        this.state.inFlightJid = null;
        this.saveState();
      }

      while (this.state.nextIndex < this.state.pendingJids.length && this.socket === sock) {
        const jid = this.state.pendingJids[this.state.nextIndex];
        const contact = historyManager.contacts[jid];
        const messages = historyManager.history[jid] || [];
        const latestActivity = latestMessageTime(messages);
        const latestClientActivity = latestClientMessageTime(messages);
        const isFirstCycle = this.state.cycleNumber === 1;
        const ownJid = ownWhatsAppJid(sock);

        if (this.state.optedOutJids.includes(jid) ||
            (ownJid && phoneNumberFromJid(jid) === phoneNumberFromJid(ownJid)) ||
            !contact?.isEs ||
            !isDirectWhatsAppJid(jid) ||
            !config.shouldReplyTo(phoneNumberFromJid(jid)) ||
            !messages.some(message => message.role === 'client') ||
            (!isFirstCycle && latestActivity > this.state.cycleStartedAt - config.followUpIntervalMs)) {
          this.state.nextIndex += 1;
          this.saveState();
          continue;
        }

        try {
          const name = contact.name || jid.slice(0, jid.indexOf('@'));
          const message = await generateStudentFollowUp(jid, name, isFirstCycle);
          if (this.socket !== sock) return;
          const updatedMessages = historyManager.history[jid] || [];
          if (this.state.optedOutJids.includes(jid) ||
              latestMessageTime(updatedMessages) > latestActivity) {
            this.state.nextIndex += 1;
            this.saveState();
            continue;
          }
          this.state.inFlightJid = jid;
          this.saveState();
          await sendHumanizedMessage(sock, jid, message, config.typingWordsPerMinute);
          historyManager.addMessage(jid, 'agent', message);
          console.log(`[Follow-up] Sent personalized check-in to ${name} (${jid.slice(0, jid.indexOf('@'))}).`);
          this.state.nextIndex += 1;
          this.state.inFlightJid = null;
          this.saveState();
        } catch (err) {
          console.error(`[Follow-up] Failed for ${jid}:`, err.message);
          this.schedule(sock, 5 * 60 * 1000);
          return;
        }

        if (this.state.nextIndex < this.state.pendingJids.length) {
          await new Promise(resolve => setTimeout(resolve, config.followUpSendDelayMs));
        }
      }

      if (this.state.nextIndex >= this.state.pendingJids.length) {
        this.state.pendingJids = [];
        this.state.nextIndex = 0;
        this.state.inFlightJid = null;
        this.state.nextCycleAt = Date.now() + config.followUpIntervalMs;
        this.saveState();
        console.log(`[Follow-up] Cycle ${this.state.cycleNumber} complete. Next cycle is due in ${config.followUpIntervalMs / 3600000} hours.`);
        this.schedule(sock, Math.max(0, this.state.nextCycleAt - Date.now()));
      }
    } finally {
      this.running = false;
      if (this.socket && this.socket !== sock) {
        this.start(this.socket, 0);
      }
    }
  }
}

export const followUpManager = new FollowUpManager();
