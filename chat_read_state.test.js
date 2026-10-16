import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatReadStateStore, getChatReadStatus } from './chat_read_state.js';

test('chat read state treats existing chats as read on first initialization', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-read-state-test-'));
  const store = new ChatReadStateStore(path.join(temporaryDirectory, 'read-state.json'));
  const history = {
    '1001@s.whatsapp.net': [
      { role: 'client', timestamp: 100 },
      { role: 'agent', timestamp: 200 }
    ]
  };

  try {
    const state = store.ensureInitialized(history);
    assert.deepEqual(state, { '1001@s.whatsapp.net': 100_000 });
    assert.deepEqual(getChatReadStatus(history['1001@s.whatsapp.net'], state['1001@s.whatsapp.net']), {
      lastIncomingAt: 100_000,
      unread: false
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('new incoming messages become unread until the chat is opened and marked read', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-read-state-test-'));
  const store = new ChatReadStateStore(path.join(temporaryDirectory, 'read-state.json'));
  const jid = '1001@s.whatsapp.net';
  const originalMessages = [{ role: 'client', timestamp: 100 }];

  try {
    store.ensureInitialized({ [jid]: originalMessages });
    const newMessages = [...originalMessages, { role: 'client', timestamp: 200 }];
    assert.equal(getChatReadStatus(newMessages, store.read()[jid]).unread, true);

    store.markRead(jid, newMessages);
    assert.equal(getChatReadStatus(newMessages, store.read()[jid]).unread, false);
    assert.equal(getChatReadStatus([
      ...newMessages,
      { role: 'client', timestamp: 300 }
    ], store.read()[jid]).unread, true);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
