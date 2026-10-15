import { config } from './config.js';
import { getPhoneJid } from './phonebook.js';

function phoneNumberFromJid(jid) {
  return jid?.endsWith('@s.whatsapp.net')
    ? jid.slice(0, -'@s.whatsapp.net'.length).split(':')[0]
    : '';
}

export function getEligibleBroadcastContacts(data, optedOutJids = []) {
  const optedOut = new Set(optedOutJids);
  const optedOutNumbers = new Set();
  for (const jid of optedOutJids) {
    const phoneJid = getPhoneJid(jid, data.contacts[jid]?.jid);
    const phoneNumber = phoneNumberFromJid(phoneJid || '');
    if (phoneNumber) optedOutNumbers.add(phoneNumber);
  }

  const aliasesByPhone = new Map();
  for (const [jid, contact] of Object.entries(data.contacts)) {
    const phoneJid = getPhoneJid(jid, contact.jid);
    if (!phoneJid) continue;
    const phoneNumber = phoneNumberFromJid(phoneJid);
    if (!aliasesByPhone.has(phoneNumber)) aliasesByPhone.set(phoneNumber, []);
    aliasesByPhone.get(phoneNumber).push({ jid, contact });
  }

  const contactsByPhone = new Map();
  for (const [phoneNumber, aliases] of aliasesByPhone) {
    const phoneJid = `${phoneNumber}@s.whatsapp.net`;
    const savedEsAlias = aliases.find(({ contact }) =>
      contact.isEs && contact.savedInAddressBook === true);
    if (!savedEsAlias ||
        aliases.some(({ jid, contact }) => optedOut.has(jid) || contact.ownerBlocked) ||
        optedOut.has(phoneJid) ||
        optedOutNumbers.has(phoneNumber) ||
        !config.shouldReplyTo(phoneNumber)) continue;

    const name = savedEsAlias.contact.name || phoneNumber;
    if (!contactsByPhone.has(phoneNumber)) {
      contactsByPhone.set(phoneNumber, {
        jid: phoneJid,
        name,
        phoneNumber
      });
    }
  }

  return [...contactsByPhone.values()]
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function listEligibleBroadcastContacts(data, optedOutJids = [], search = '', offset = 0, limit = 50) {
  const normalizedSearch = search.trim().toLocaleLowerCase().slice(0, 120);
  const contacts = getEligibleBroadcastContacts(data, optedOutJids).filter(contact =>
    !normalizedSearch ||
    contact.name.toLocaleLowerCase().includes(normalizedSearch) ||
    contact.phoneNumber.includes(normalizedSearch));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(5000, Math.max(1, Math.floor(limit)));

  return {
    total: contacts.length,
    offset: safeOffset,
    limit: safeLimit,
    contacts: contacts.slice(safeOffset, safeOffset + safeLimit)
  };
}

export function validateBroadcastRequest({ text, jids }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new Error('Message must be between 1 and 4,000 characters.');
  }
  if (!Array.isArray(jids) || jids.length === 0 || jids.length > 5000) {
    throw new Error('Select between 1 and 5,000 eligible contacts.');
  }
  if (jids.some(jid =>
    typeof jid !== 'string' ||
    !/^\d+@s\.whatsapp\.net$/.test(jid)) ||
    new Set(jids).size !== jids.length) {
    throw new Error('The recipient list contains an invalid or duplicate phone number.');
  }
  return { text: text.trim(), jids };
}
