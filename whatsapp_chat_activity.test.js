import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  timestampToMilliseconds,
  WhatsAppChatActivityStore
} from './whatsapp_chat_activity.js';

test('WhatsApp chat activity stores normalized direct-chat timestamps without replacing newer values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-chat-activity-'));
  const filePath = path.join(directory, 'activity.json');
  const store = new WhatsAppChatActivityStore(filePath);
  try {
    assert.equal(store.record([
      { id: '249111111111@s.whatsapp.net', conversationTimestamp: 1_800_000_000 },
      { id: '12345@g.us', conversationTimestamp: 1_800_000_100 },
      { id: '987654321@lid', lastMessageRecvTimestamp: 1_800_000_050 }
    ]), true);
    assert.deepEqual(store.read(), {
      '249111111111@s.whatsapp.net': 1_800_000_000_000,
      '987654321@lid': 1_800_000_050_000
    });

    assert.equal(store.record([
      { id: '249111111111@s.whatsapp.net', conversationTimestamp: 1_700_000_000 }
    ]), false);
    assert.equal(store.recordMessage('249111111111@s.whatsapp.net', 1_900_000_000), true);
    assert.equal(
      store.read()['249111111111@s.whatsapp.net'],
      1_900_000_000_000
    );
    assert.equal(store.recordMessage('12345@g.us', 1_900_000_000), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WhatsApp timestamps support seconds, milliseconds, and invalid values', () => {
  assert.equal(timestampToMilliseconds(1_800_000_000), 1_800_000_000_000);
  assert.equal(timestampToMilliseconds(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(timestampToMilliseconds('not-a-timestamp'), null);
});
