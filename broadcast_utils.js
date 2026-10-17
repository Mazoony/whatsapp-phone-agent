import { config } from './config.js';
import { getPhoneJid } from './phonebook.js';
import { MAX_BROADCAST_ATTACHMENTS } from './broadcast_media.js';
import { timestampToMilliseconds } from './whatsapp_chat_activity.js';
import { getChatReadStatus } from './chat_read_state.js';

function phoneNumberFromJid(jid) {
  return jid?.endsWith('@s.whatsapp.net')
    ? jid.slice(0, -'@s.whatsapp.net'.length).split(':')[0]
    : '';
}

export function getEligibleBroadcastContacts(data, optedOutJids = [], recipientType = 'es') {
  if (recipientType !== 'es' && recipientType !== 'non-es') {
    throw new Error('Recipient type must be "es" or "non-es".');
  }
  const dataContacts = data.contacts || {};
  const optedOut = new Set(optedOutJids);
  const blockedNumbers = new Set((data.blockedNumbers || []).map(record =>
    typeof record === 'string' ? record : record.number));
  const optedOutNumbers = new Set();
  for (const jid of optedOutJids) {
    const phoneJid = getPhoneJid(jid, dataContacts[jid]?.phoneJid, dataContacts[jid]?.jid);
    const phoneNumber = phoneNumberFromJid(phoneJid || '');
    if (phoneNumber) optedOutNumbers.add(phoneNumber);
  }

  const aliasesByPhone = new Map();
  for (const [jid, contact] of Object.entries(dataContacts)) {
    const phoneJid = getPhoneJid(jid, contact.phoneJid, contact.jid);
    if (!phoneJid) continue;
    const phoneNumber = phoneNumberFromJid(phoneJid);
    if (!aliasesByPhone.has(phoneNumber)) aliasesByPhone.set(phoneNumber, []);
    aliasesByPhone.get(phoneNumber).push({ jid, contact });
  }

  if (recipientType === 'non-es') {
    for (const jid of Object.keys(data.history || {})) {
      const phoneJid = getPhoneJid(jid, dataContacts[jid]?.phoneJid, dataContacts[jid]?.jid);
      if (!phoneJid || aliasesByPhone.has(phoneNumberFromJid(phoneJid))) continue;
      const phoneNumber = phoneNumberFromJid(phoneJid);
      aliasesByPhone.set(phoneNumber, [{
        jid,
        contact: { name: '', isEs: false }
      }]);
    }
  }

  const trackedPhoneJids = new Set(
    Object.keys(data.history || {})
      .map(jid => getPhoneJid(jid, dataContacts[jid]?.phoneJid, dataContacts[jid]?.jid) || jid)
      .filter(jid => jid.endsWith('@s.whatsapp.net'))
  );
  const contactsByPhone = new Map();
  for (const [phoneNumber, aliases] of aliasesByPhone) {
    const phoneJid = `${phoneNumber}@s.whatsapp.net`;
    const esAliases = aliases.filter(({ jid, contact }) =>
      contact.isEs || config.isEsContact(contact.name, phoneJid));
    const eligibleAlias = recipientType === 'es'
      ? esAliases.find(({ contact }) => contact.savedInAddressBook === true)
      : aliases.find(({ jid, contact }) =>
        !contact.isEs && !config.isEsContact(contact.name, phoneJid));
    if (!eligibleAlias ||
        (recipientType === 'non-es' && esAliases.length > 0) ||
        (recipientType === 'non-es' && !trackedPhoneJids.has(phoneJid)) ||
        aliases.some(({ jid, contact }) => optedOut.has(jid) || contact.ownerBlocked) ||
        optedOut.has(phoneJid) ||
        optedOutNumbers.has(phoneNumber) ||
        blockedNumbers.has(phoneNumber) ||
        !config.shouldReplyTo(phoneNumber)) continue;

    const name = eligibleAlias.contact.name || phoneNumber;
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

function dateInTimeZone(timestamp, timeZone) {
  const numericTimestamp = Number(timestamp);
  const rawTimestamp = Number.isFinite(numericTimestamp) ? numericTimestamp : Date.parse(timestamp);
  const milliseconds = rawTimestamp > 0 && rawTimestamp < 1e12
    ? rawTimestamp * 1000
    : rawTimestamp;
  if (!Number.isFinite(milliseconds)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(milliseconds));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateDateFilter(date, timeZone) {
  if (!date) return;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Date must use YYYY-MM-DD format.');
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Date must be a valid calendar day.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(parsed);
  } catch {
    throw new Error('The requested timezone is invalid.');
  }
}

function getIncomingMessagesByPhone(data, date, timeZone) {
  const latestByPhone = new Map();
  const messagesOnDateByPhone = new Map();
  for (const [historyJid, messages] of Object.entries(data.history || {})) {
    if (!Array.isArray(messages)) continue;
    const canonicalPhoneJid = getPhoneJid(
      historyJid,
      data.contacts?.[historyJid]?.phoneJid,
      data.contacts?.[historyJid]?.jid
    ) || historyJid;
    for (const message of messages) {
      if (message.role !== 'client') continue;
      const timestamp = timestampToMilliseconds(message.timestamp);
      if (!timestamp) continue;
      const latestMessage = latestByPhone.get(canonicalPhoneJid);
      if (!latestMessage || timestamp > latestMessage.timestamp) {
        latestByPhone.set(canonicalPhoneJid, timestamp);
      }
      if (date && dateInTimeZone(timestamp, timeZone) === date) {
        const latestOnDate = messagesOnDateByPhone.get(canonicalPhoneJid);
        if (!latestOnDate || timestamp > latestOnDate.timestamp) {
          messagesOnDateByPhone.set(canonicalPhoneJid, {
            text: message.text || '',
            timestamp
          });
        }
      }
    }
  }
  return { latestByPhone, messagesOnDateByPhone };
}

function getWhatsAppActivityByPhone(data) {
  const latestByPhone = new Map();
  for (const [chatJid, value] of Object.entries(data.whatsappChatActivity || {})) {
    const phoneJid = getPhoneJid(
      chatJid,
      data.contacts?.[chatJid]?.phoneJid,
      data.contacts?.[chatJid]?.jid
    ) || chatJid;
    const timestamp = timestampToMilliseconds(value);
    if (!phoneJid.endsWith('@s.whatsapp.net') || !timestamp) continue;
    if (timestamp > (latestByPhone.get(phoneJid) || 0)) latestByPhone.set(phoneJid, timestamp);
  }
  return latestByPhone;
}

function getReadActivityByPhone(data, readState) {
  const activityByPhone = new Map();
  for (const [jid, messages] of Object.entries(data.history || {})) {
    if ((!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) ||
        !Array.isArray(messages)) continue;
    const phoneJid = getPhoneJid(
      jid,
      data.contacts?.[jid]?.phoneJid,
      data.contacts?.[jid]?.jid
    ) || jid;
    const record = activityByPhone.get(phoneJid) || {
      lastActivityAt: 0,
      lastIncomingAt: 0,
      unread: false
    };
    const lastActivityAt = messages.reduce((latest, message) =>
      Math.max(latest, timestampToMilliseconds(message.timestamp) || 0), 0);
    const readStatus = getChatReadStatus(messages, readState[jid]);
    record.lastActivityAt = Math.max(record.lastActivityAt, lastActivityAt);
    record.lastIncomingAt = Math.max(
      record.lastIncomingAt,
      timestampToMilliseconds(readStatus.lastIncomingAt) || 0
    );
    record.unread ||= readStatus.unread;
    activityByPhone.set(phoneJid, record);
  }
  return activityByPhone;
}

export function listEligibleBroadcastContacts(
  data,
  optedOutJids = [],
  search = '',
  offset = 0,
  limit = 50,
  {
    date = '',
    timeZone = 'UTC',
    recipientType = 'es',
    sort = 'name',
    readFilter = 'all',
    readState = {}
  } = {}
) {
  validateDateFilter(date, timeZone);
  if (recipientType !== 'es' && recipientType !== 'non-es') {
    throw new Error('Recipient type must be "es" or "non-es".');
  }
  if (!['name', 'date-desc', 'date-asc', 'unread-first', 'read-first'].includes(sort)) {
    throw new Error('Invalid recipient sort option.');
  }
  if (!['all', 'read', 'unread'].includes(readFilter)) {
    throw new Error('Invalid recipient read filter.');
  }
  const normalizedSearch = search.trim().toLocaleLowerCase().slice(0, 120);
  const { latestByPhone: latestIncomingByPhone, messagesOnDateByPhone } =
    getIncomingMessagesByPhone(data, date, timeZone);
  const activityByPhone = getWhatsAppActivityByPhone(data);
  const readActivityByPhone = getReadActivityByPhone(data, readState);
  const contacts = getEligibleBroadcastContacts(data, optedOutJids, recipientType)
    .filter(contact =>
      (!normalizedSearch ||
        contact.name.toLocaleLowerCase().includes(normalizedSearch) ||
        contact.phoneNumber.includes(normalizedSearch)) &&
      (!date || messagesOnDateByPhone.has(contact.jid)))
    .map(contact => {
      const incomingMessage = messagesOnDateByPhone.get(contact.jid);
      const whatsappActivityAt = activityByPhone.get(contact.jid) || 0;
      const latestIncomingAt = latestIncomingByPhone.get(contact.jid) || 0;
      const readActivity = readActivityByPhone.get(contact.jid);
      const lastIncomingAt = readActivity?.lastIncomingAt || latestIncomingAt || null;
      const lastActivityAt = Math.max(
        whatsappActivityAt,
        lastIncomingAt || 0,
        readActivity?.lastIncomingAt || 0
      ) || null;
      return {
        ...contact,
        lastActivityAt,
        lastIncomingAt: (date && incomingMessage ? incomingMessage.timestamp : lastIncomingAt),
        unread: readActivity?.unread || false,
        activitySource: !lastActivityAt
          ? null
          : whatsappActivityAt >= (lastIncomingAt || 0)
            ? 'whatsapp'
            : 'history',
        ...(date && incomingMessage ? {
          lastIncomingMessage: incomingMessage.text,
          lastIncomingAt: incomingMessage.timestamp
        } : {})
      };
    })
    .filter(contact =>
      readFilter === 'all' ||
      (readFilter === 'unread' ? contact.unread : !contact.unread))
    .sort((left, right) => {
      if (sort === 'name') return left.name.localeCompare(right.name);
      if (sort === 'date-asc') {
        return (left.lastActivityAt || 0) - (right.lastActivityAt || 0) ||
          left.name.localeCompare(right.name);
      }
      if (sort === 'unread-first' || sort === 'read-first') {
        const readOrder = sort === 'unread-first'
          ? Number(right.unread) - Number(left.unread)
          : Number(left.unread) - Number(right.unread);
        if (readOrder) return readOrder;
      }
      return (right.lastActivityAt || 0) - (left.lastActivityAt || 0) ||
        left.name.localeCompare(right.name);
    });
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(5000, Math.max(1, Math.floor(limit)));

  return {
    total: contacts.length,
    offset: safeOffset,
    limit: safeLimit,
    contacts: contacts.slice(safeOffset, safeOffset + safeLimit)
  };
}

export function validateBroadcastRequest({ text = '', jids, attachments = [], recipientType = 'es' }) {
  if (recipientType !== 'es' && recipientType !== 'non-es') {
    throw new Error('Recipient type must be "es" or "non-es".');
  }
  if (typeof text !== 'string' || text.length > 4000) {
    throw new Error('Message must not exceed 4,000 characters.');
  }
  if (!Array.isArray(attachments) || attachments.length > MAX_BROADCAST_ATTACHMENTS ||
      attachments.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) ||
      new Set(attachments).size !== attachments.length) {
    throw new Error(`Attach between 0 and ${MAX_BROADCAST_ATTACHMENTS} valid, unique files.`);
  }
  if (!text.trim() && attachments.length === 0) {
    throw new Error('Write a message or attach at least one file.');
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
  return {
    text: text.trim(),
    jids,
    ...(attachments.length ? { attachments: [...attachments] } : {})
  };
}
