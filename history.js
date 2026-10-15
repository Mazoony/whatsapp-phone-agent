import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const DATA_DIR = path.resolve('data');
const HISTORY_FILE = path.join(DATA_DIR, 'chat_history.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

const DEFAULT_MAX_MESSAGES = 20;
const ES_MAX_PERMANENT_MESSAGES = 5000; // Permanent memory for Es contacts

class ChatHistoryManager {
  constructor() {
    this.history = {};
    this.contacts = {};
    this.saveTimeout = null;
    this.saveContactsTimeout = null;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(HISTORY_FILE)) {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
        this.history = JSON.parse(raw);
      }
      if (fs.existsSync(CONTACTS_FILE)) {
        const rawContacts = fs.readFileSync(CONTACTS_FILE, 'utf-8');
        this.contacts = JSON.parse(rawContacts);
      }
    } catch (err) {
      console.error('[HistoryManager] Failed to load data:', err.message);
      this.history = this.history || {};
      this.contacts = this.contacts || {};
    }
  }

  scheduleSave() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    // Debounce disk writes by 3 seconds to save eMMC wear and battery on phone
    this.saveTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2), 'utf-8');
      } catch (err) {
        console.error('[HistoryManager] Failed to save chat history to file:', err.message);
      }
    }, 3000);
  }

  scheduleSaveContacts() {
    if (this.saveContactsTimeout) clearTimeout(this.saveContactsTimeout);
    this.saveContactsTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify(this.contacts, null, 2), 'utf-8');
      } catch (err) {
        console.error('[HistoryManager] Failed to save contacts to file:', err.message);
      }
    }, 3000);
  }

  /**
   * Save or update contact details and evaluate if they qualify as an "Es" contact
   * @param {string} jid
   * @param {string} name Contact display name or pushName
   */
  saveContact(jid, name) {
    if (!jid) return;
    const cleanName = (name || '').trim();
    const existing = this.contacts[jid] || {};
    const bestName = cleanName || existing.name || '';

    const isEs = config.isEsContact(bestName, jid) || existing.isEs || false;

    this.contacts[jid] = {
      ...existing,
      jid,
      name: bestName,
      isEs,
      updatedAt: new Date().toISOString()
    };

    this.scheduleSaveContacts();
    return this.contacts[jid];
  }

  markSavedContact(jid, name = '') {
    if (!jid) return;

    const contact = this.saveContact(jid, name);
    contact.savedInAddressBook = true;
    this.scheduleSaveContacts();
    return contact;
  }

  isSavedContact(...jids) {
    return jids.some(jid => jid && this.contacts[jid]?.savedInAddressBook === true);
  }

  hasContactSavePrompted(...jids) {
    return jids.some(jid => jid && this.contacts[jid]?.contactSavePromptedAt);
  }

  markContactSavePrompted(...jids) {
    for (const jid of jids.filter(Boolean)) {
      const contact = this.contacts[jid] || { jid, name: '' };
      contact.contactSavePromptedAt = new Date().toISOString();
      this.contacts[jid] = contact;
    }
    this.scheduleSaveContacts();
  }

  /**
   * Check if a contact contains the letters "Es" (in name, pushName, or config)
   * @param {string} jid
   * @param {string} explicitName
   * @returns {boolean}
   */
  isEsContact(jid, explicitName = '') {
    if (explicitName && config.isEsContact(explicitName, jid)) {
      return true;
    }
    const entry = this.contacts[jid];
    if (entry && (entry.isEs || config.isEsContact(entry.name, jid))) {
      return true;
    }
    return config.isEsContact('', jid);
  }

  /**
   * Add a message to the contact's history
   * @param {string} jid Contact ID (e.g. 123456789@s.whatsapp.net)
   * @param {'client' | 'agent'} role
   * @param {string} text Message content
   * @param {number} timestamp Unix epoch in seconds or milliseconds
   * @param {string} contactName Contact pushName or display name
   */
  addMessage(jid, role, text, timestamp = Date.now(), contactName = '') {
    if (!text || !text.trim()) return;

    if (contactName) {
      this.saveContact(jid, contactName);
    }

    if (!this.history[jid]) {
      this.history[jid] = [];
    }

    this.history[jid].push({
      role,
      text: text.trim(),
      timestamp
    });

    const isEs = this.isEsContact(jid, contactName);

    if (isEs) {
      // PERMANENT RETENTION FOR ES CONTACTS:
      // History is permanently preserved up to safety ceiling (5,000 messages)
      if (this.history[jid].length > ES_MAX_PERMANENT_MESSAGES) {
        this.history[jid] = this.history[jid].slice(-ES_MAX_PERMANENT_MESSAGES);
      }
    } else {
      // Non-Es contacts keep standard rolling window
      if (this.history[jid].length > DEFAULT_MAX_MESSAGES) {
        this.history[jid] = this.history[jid].slice(-DEFAULT_MAX_MESSAGES);
      }
    }

    this.scheduleSave();
  }

  /**
   * Returns conversation dialogue formatted for Gemini.
   * If contact contains "Es", returns extensive permanent history.
   * Otherwise returns the recent 10 messages.
   * @param {string} jid
   * @param {string} contactName
   * @param {number} limit
   * @returns {string}
   */
  getDialogueForAgent(jid, contactName = '', limit = null) {
    const list = this.history[jid] || [];
    if (list.length === 0) return 'No previous conversation history.';

    const isEs = this.isEsContact(jid, contactName);
    const maxMessages = limit || (isEs ? 100 : 10);
    const recent = list.slice(-maxMessages);

    const formattedLines = recent.map(msg => {
      const speaker = msg.role === 'client' ? (contactName || 'Client') : 'Mr. Mazen (You)';
      const timeStr = msg.timestamp ? ` [${new Date(msg.timestamp).toLocaleDateString('ar-EG')}]` : '';
      return `${speaker}${timeStr}: ${msg.text}`;
    });

    if (isEs) {
      return `[⭐ PERMANENT CHAT MEMORY ACTIVE - ES CONTACT: ${contactName || jid}]\n(Total stored messages: ${list.length})\n` + formattedLines.join('\n');
    }

    return formattedLines.join('\n');
  }

  /**
   * Get plain text conversation summary for prompt injection (backwards compatibility)
   */
  getRecentDialogueText(jid, limit = 8) {
    return this.getDialogueForAgent(jid, '', limit);
  }

  /**
   * Get list of all identified Es contacts
   */
  getEsContactsList() {
    return Object.values(this.contacts).filter(c => c.isEs);
  }
}

export const historyManager = new ChatHistoryManager();
