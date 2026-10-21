import { getPhoneJid } from './phonebook.js';

export function getConversationJids(history, contacts, ...requestedJids) {
  const jids = new Set(requestedJids.filter(jid => typeof jid === 'string' && jid));
  const phoneJids = new Set([...jids].map(jid =>
    getPhoneJid(jid, contacts[jid]?.phoneJid, contacts[jid]?.jid)
  ).filter(Boolean));

  if (phoneJids.size === 0) return [...jids];

  for (const historyJid of Object.keys(history)) {
    const phoneJid = getPhoneJid(
      historyJid,
      contacts[historyJid]?.phoneJid,
      contacts[historyJid]?.jid
    );
    if (phoneJid && phoneJids.has(phoneJid)) jids.add(historyJid);
  }

  return [...jids];
}

export function getConversationMessages(history, contacts, ...requestedJids) {
  const relatedJids = getConversationJids(history, contacts, ...requestedJids);
  const seenMessageIds = new Set();
  const seenMessageContent = new Set();
  const messages = [];

  for (const jid of relatedJids) {
    for (const message of history[jid] || []) {
      const messageId = message.id ? `${message.role}:${message.id}` : null;
      const messageContent = `${message.role}:${message.timestamp}:${message.text}`;
      if ((messageId && seenMessageIds.has(messageId)) || seenMessageContent.has(messageContent)) continue;
      if (messageId) seenMessageIds.add(messageId);
      seenMessageContent.add(messageContent);
      messages.push({ ...message, remoteJid: jid });
    }
  }

  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) =>
      (Number(left.message.timestamp) || 0) - (Number(right.message.timestamp) || 0) ||
      left.index - right.index
    )
    .map(({ message }) => message);
}
