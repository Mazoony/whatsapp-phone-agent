import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIncomingMessageDeduplicator,
  shouldProcessIncomingUpsert
} from './incoming_message_utils.js';

test('only live notifications and explicit unavailable-device catch-up messages are processed', () => {
  assert.equal(shouldProcessIncomingUpsert({ type: 'notify' }), true);
  assert.equal(shouldProcessIncomingUpsert({ type: 'append' }), false);
  assert.equal(shouldProcessIncomingUpsert({ type: 'append', requestId: 'phone-fetch-1' }), true);
  assert.equal(shouldProcessIncomingUpsert({ type: 'notify', requestId: 'phone-fetch-1' }), true);
  assert.equal(shouldProcessIncomingUpsert({ type: 'append', requestId: '' }), false);
});

test('duplicate upserts are ignored by message ID while the agent is running', () => {
  const isDuplicate = createIncomingMessageDeduplicator(2);
  const message = id => ({ key: { id } });

  assert.equal(isDuplicate(message('message-1')), false);
  assert.equal(isDuplicate(message('message-1')), true);
  assert.equal(isDuplicate(message('message-2')), false);
  assert.equal(isDuplicate(message('message-3')), false);
  assert.equal(isDuplicate(message('message-1')), false);
  assert.equal(isDuplicate({ key: {} }), false);
});
