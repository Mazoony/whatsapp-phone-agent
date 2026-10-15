export function calculateTypingDelayMs(text, wordsPerMinute = 40, minimumDelayMs = 1000) {
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) {
    throw new RangeError('Typing speed must be a positive number of words per minute.');
  }
  if (!Number.isFinite(minimumDelayMs) || minimumDelayMs < 0) {
    throw new RangeError('Minimum typing delay must be a non-negative number of milliseconds.');
  }

  const characterCount = Array.from(text || '').length;
  const estimatedMs = characterCount * (60_000 / (wordsPerMinute * 5));
  return Math.max(minimumDelayMs, Math.ceil(estimatedMs));
}

export async function sendHumanizedMessage(sock, jid, text, wordsPerMinute = 40) {
  const canUpdatePresence = typeof sock.sendPresenceUpdate === 'function';

  if (canUpdatePresence) {
    await sock.sendPresenceUpdate('composing', jid);
  }

  try {
    const delayMs = calculateTypingDelayMs(text, wordsPerMinute);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return await sock.sendMessage(jid, { text });
  } finally {
    if (canUpdatePresence) {
      await sock.sendPresenceUpdate('paused', jid);
    }
  }
}
