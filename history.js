import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { getPhoneJid } from './phonebook.js';
import { getConversationJids, getConversationMessages } from './conversation_history.js';

const DATA_DIR = path.resolve('data');
const HISTORY_FILE = path.join(DATA_DIR, 'chat_history.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

const MAX_STORED_MESSAGES_PER_CHAT = 5000;

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
  saveContact(jid, name, linkedPhoneJid = null) {
    if (!jid) return;
    const cleanName = (name || '').trim();
    const existing = this.contacts[jid] || {};
    const bestName = cleanName || existing.name || '';
    const phoneJid = getPhoneJid(linkedPhoneJid, existing.phoneJid, jid);

    const isEs = config.isEsContact(bestName, phoneJid || jid) || existing.isEs || false;

    this.contacts[jid] = {
      ...existing,
      jid,
      ...(phoneJid ? { phoneJid } : {}),
      name: bestName,
      isEs,
      updatedAt: new Date().toISOString()
    };

    this.scheduleSaveContacts();
    return this.contacts[jid];
  }

  markSavedContact(jid, name = '', linkedPhoneJid = null) {
    if (!jid) return;

    const contact = this.saveContact(jid, name, linkedPhoneJid);
    contact.savedInAddressBook = true;
    this.scheduleSaveContacts();
    return contact;
  }

  saveWhatsAppContact(contact) {
    if (!contact || typeof contact !== 'object') return;
    const jids = [...new Set([contact.id, contact.jid, contact.lid]
      .filter(jid => typeof jid === 'string' && jid))];
    const phoneJid = getPhoneJid(...jids);
    const name = contact.name || contact.notify || contact.verifiedName || '';

    for (const jid of jids) {
      if (contact.name) {
        this.markSavedContact(jid, contact.name, phoneJid);
      } else {
        this.saveContact(jid, name, phoneJid);
      }
    }
  }

  isSavedContact(...jids) {
    return jids.some(jid => jid && this.contacts[jid]?.savedInAddressBook === true);
  }

  hasConversation(...jids) {
    const requestedJids = new Set(jids.filter(jid => typeof jid === 'string' && jid));
    const phoneJids = new Set([...requestedJids].map(jid =>
      getPhoneJid(jid, this.contacts[jid]?.phoneJid, this.contacts[jid]?.jid)
    ).filter(Boolean));
    return Object.entries(this.history).some(([historyJid, messages]) => {
      if (!Array.isArray(messages) || messages.length === 0) return false;
      if (requestedJids.has(historyJid)) return true;
      const phoneJid = getPhoneJid(
        historyJid,
        this.contacts[historyJid]?.phoneJid,
        this.contacts[historyJid]?.jid
      );
      return phoneJid && phoneJids.has(phoneJid);
    });
  }

  hasContactSavePrompted(...jids) {
    return jids.some(jid => jid && this.contacts[jid]?.contactSavePromptedAt);
  }

  getWelcomeSampleState(...jids) {
    const requestedJids = new Set(jids.filter(jid => typeof jid === 'string' && jid));
    const phoneJids = new Set([...requestedJids].map(jid =>
      getPhoneJid(jid, this.contacts[jid]?.phoneJid, this.contacts[jid]?.jid)
    ).filter(Boolean));
    for (const [contactJid, contact] of Object.entries(this.contacts)) {
      const phoneJid = getPhoneJid(contactJid, contact?.phoneJid, contact?.jid);
      if (requestedJids.has(contactJid) || (phoneJid && phoneJids.has(phoneJid))) {
        if (typeof contact.welcomeSampleState === 'string') return contact.welcomeSampleState;
      }
    }
    return null;
  }

  setWelcomeSampleState(state, ...jids) {
    const targets = new Set(jids.filter(jid => typeof jid === 'string' && jid));
    const phoneJids = new Set([...targets].map(jid =>
      getPhoneJid(jid, this.contacts[jid]?.phoneJid, this.contacts[jid]?.jid)
    ).filter(Boolean));
    for (const [contactJid, contact] of Object.entries(this.contacts)) {
      const phoneJid = getPhoneJid(contactJid, contact?.phoneJid, contact?.jid);
      if (phoneJid && phoneJids.has(phoneJid)) targets.add(contactJid);
    }
    for (const jid of targets) {
      const contact = this.contacts[jid] || { jid, name: '' };
      if (state) contact.welcomeSampleState = state;
      else delete contact.welcomeSampleState;
      this.contacts[jid] = contact;
    }
    this.scheduleSaveContacts();
  }

  hasLessonDeliveryConsent(...jids) {
    return jids.some(jid => jid && this.contacts[jid]?.lessonConsentGrantedAt);
  }

  setLessonDeliveryConsent(granted, ...jids) {
    for (const jid of jids.filter(Boolean)) {
      const contact = this.contacts[jid] || { jid, name: '' };
      if (granted) contact.lessonConsentGrantedAt = new Date().toISOString();
      else delete contact.lessonConsentGrantedAt;
      this.contacts[jid] = contact;
    }
    this.scheduleSaveContacts();
  }

  markContactSavePrompted(...jids) {
    for (const jid of jids.filter(Boolean)) {
      const contact = this.contacts[jid] || { jid, name: '' };
      contact.contactSavePromptedAt = new Date().toISOString();
      this.contacts[jid] = contact;
    }
    this.scheduleSaveContacts();
  }

  isOwnerBlockedContact(...jids) {
    return jids.some(jid => jid && this.contacts[jid]?.ownerBlocked === true);
  }

  blockContactForOwner(...jids) {
    for (const jid of jids.filter(Boolean)) {
      const contact = this.contacts[jid] || { jid, name: '' };
      contact.ownerBlocked = true;
      this.contacts[jid] = contact;
    }
    this.scheduleSaveContacts();
  }

  isOwnerAllowedContact(...jids) {
    return jids.some(jid => jid && this.contacts[jid]?.ownerAllowed === true);
  }

  allowContactForOwner(...jids) {
    for (const jid of jids.filter(Boolean)) {
      const contact = this.contacts[jid] || { jid, name: '' };
      contact.ownerAllowed = true;
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
  addMessage(jid, role, text, timestamp = Date.now(), contactName = '', messageId = null, linkedPhoneJid = null) {
    if (!text || !text.trim()) return;

    if (contactName) {
      this.saveContact(jid, contactName, linkedPhoneJid);
    }

    if (!this.history[jid]) {
      this.history[jid] = [];
    }

    if (messageId && this.history[jid].some(message => message.id === messageId)) return;

    this.history[jid].push({
      role,
      text: text.trim(),
      timestamp,
      ...(messageId ? { id: messageId } : {})
    });

    if (this.history[jid].length > MAX_STORED_MESSAGES_PER_CHAT) {
      this.history[jid] = this.history[jid]
        .map((message, index) => ({ message, index }))
        .sort((left, right) =>
          (Number(left.message.timestamp) || 0) - (Number(right.message.timestamp) || 0) ||
          left.index - right.index
        )
        .slice(-MAX_STORED_MESSAGES_PER_CHAT)
        .map(({ message }) => message);
    }

    this.scheduleSave();
  }

  getConversationMessages(...jids) {
    return getConversationMessages(this.history, this.contacts, ...jids);
  }

  /**
   * Returns conversation dialogue formatted for Gemini.
   * Returns the recent conversation across linked WhatsApp IDs.
   * @param {string} jid
   * @param {string} contactName
   * @param {number} limit
   * @returns {string}
   */
  getDialogueForAgent(jid, contactName = '', limit = null, linkedPhoneJid = null) {
    const relatedJids = getConversationJids(
      this.history,
      this.contacts,
      jid,
      linkedPhoneJid
    );
    const list = this.getConversationMessages(jid, linkedPhoneJid);
    if (list.length === 0) return 'No previous conversation history.';

    const isEs = relatedJids.some(relatedJid => this.isEsContact(relatedJid, contactName));
    const maxMessages = limit || 100;
    const recent = list.slice(-maxMessages);

    const formattedLines = recent.map(msg => {
      const speaker = msg.role === 'client' ? (contactName || 'Client') : 'Mr. Mazen (You)';
      const timeStr = msg.timestamp ? ` [${new Date(msg.timestamp).toLocaleDateString('ar-EG')}]` : '';
      return `${speaker}${timeStr}: ${msg.text}`;
    });

    if (isEs) {
      return `[⭐ PERMANENT CHAT MEMORY ACTIVE - ES CONTACT: ${contactName || jid}]\n(Total stored messages across linked WhatsApp IDs: ${list.length})\n` + formattedLines.join('\n');
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
