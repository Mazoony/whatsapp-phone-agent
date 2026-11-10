export function shouldProcessIncomingUpsert({ type, requestId }) {
  return type === 'notify' || (typeof requestId === 'string' && requestId.length > 0);
}

export function createIncomingMessageDeduplicator(maxEntries = 5000) {
  const messageIds = new Set();

  return message => {
    const id = message?.key?.id;
    if (typeof id !== 'string' || !id) return false;
    if (messageIds.has(id)) return true;

    messageIds.add(id);
    if (messageIds.size > maxEntries) {
      messageIds.delete(messageIds.values().next().value);
    }
    return false;
  };
}
