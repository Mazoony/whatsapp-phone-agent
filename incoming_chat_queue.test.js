import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IncomingChatQueue,
  readIncomingChatQueue
} from './incoming_chat_queue.js';

test('incoming chat queue preserves FIFO order and waits for the debounce head', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-chat-queue-'));
  const queueFile = path.join(temporaryDirectory, 'queue.json');
  const queue = new IncomingChatQueue(queueFile);
  const first = {
    jid: '1001@s.whatsapp.net',
    pushName: 'Ali',
    texts: ['first'],
    images: [],
    queuedAt: '2026-01-01T00:00:00.000Z',
    process: async () => {}
  };
  const second = {
    jid: '1002@s.whatsapp.net',
    pushName: 'Sara',
    texts: ['second'],
    images: [],
    queuedAt: '2026-01-01T00:00:01.000Z',
    process: async () => {}
  };

  try {
    queue.enqueue(first);
    queue.enqueue(second);
    queue.markReady(second);
    assert.deepEqual(queue.snapshot().waiting.map(item => item.position), [1, 2]);
    assert.equal(queue.takeNext(), null, 'the later chat cannot pass an un-debounced head');

    queue.markReady(first);
    assert.equal(queue.takeNext(), first);
    assert.deepEqual(queue.snapshot().waiting.map(item => item.jid), [second.jid]);
    assert.equal(queue.snapshot().waiting[0].position, 2);
    assert.equal(readIncomingChatQueue(queueFile).active.name, 'Ali');

    const followUp = queue.enqueue({
      ...first,
      texts: ['message received while handling'],
      queuedAt: '2026-01-01T00:00:02.000Z'
    });
    assert.notEqual(followUp, first);
    queue.markReady(followUp);
    assert.deepEqual(queue.snapshot().waiting.map(item => item.name), ['Sara', 'Ali']);
    queue.finish(first);
    assert.equal(queue.takeNext(), second);
    queue.finish(second);
    assert.equal(queue.takeNext(), followUp);
    queue.finish(followUp);
    const finishedSnapshot = readIncomingChatQueue(queueFile);
    assert.equal(finishedSnapshot.active, null);
    assert.deepEqual(finishedSnapshot.waiting, []);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('new bursts merge into a waiting chat without changing its original position', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-chat-queue-'));
  const queue = new IncomingChatQueue(path.join(temporaryDirectory, 'queue.json'));
  const first = {
    jid: '1001@s.whatsapp.net',
    pushName: 'Ali',
    texts: ['first burst'],
    images: [],
    queuedAt: '2026-01-01T00:00:00.000Z',
    process: async () => {}
  };
  const other = {
    jid: '1002@s.whatsapp.net',
    pushName: 'Sara',
    texts: ['second chat'],
    images: [],
    queuedAt: '2026-01-01T00:00:01.000Z',
    process: async () => {}
  };

  try {
    const waitingAli = queue.enqueue(first);
    queue.enqueue(other);
    const mergedAli = queue.enqueue({
      ...first,
      texts: ['follow-up burst'],
      queuedAt: '2026-01-01T00:00:02.000Z'
    });

    assert.equal(mergedAli, waitingAli);
    assert.deepEqual(waitingAli.texts, ['first burst', 'follow-up burst']);
    assert.equal(waitingAli.queuedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(queue.snapshot().waiting.map(item => item.name), ['Ali', 'Sara']);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('paused chat handling holds ready chats in FIFO order until resumed', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-chat-queue-paused-'));
  const queue = new IncomingChatQueue(path.join(temporaryDirectory, 'queue.json'));
  const first = {
    jid: '1001@s.whatsapp.net',
    pushName: 'Ali',
    texts: ['first'],
    images: [],
    queuedAt: '2026-01-01T00:00:00.000Z',
    process: async () => {}
  };
  const second = {
    jid: '1002@s.whatsapp.net',
    pushName: 'Sara',
    texts: ['second'],
    images: [],
    queuedAt: '2026-01-01T00:00:01.000Z',
    process: async () => {}
  };

  try {
    queue.enqueue(first);
    queue.enqueue(second);
    queue.markReady(first);
    queue.markReady(second);
    queue.setPaused(true);
    assert.equal(queue.takeNext(), null);
    assert.equal(queue.snapshot().paused, true);
    assert.deepEqual(queue.snapshot().waiting.map(item => item.queuedAt), [
      first.queuedAt,
      second.queuedAt
    ]);

    queue.setPaused(false);
    assert.equal(queue.snapshot().paused, false);
    assert.equal(queue.takeNext(), first);
    queue.finish(first);
    assert.equal(queue.takeNext(), second);
    queue.finish(second);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('cancelling a waiting chat removes it from the FIFO queue but cannot cancel the active chat', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-chat-queue-cancel-'));
  const queue = new IncomingChatQueue(path.join(temporaryDirectory, 'queue.json'));
  const first = {
    jid: '1001@s.whatsapp.net',
    pushName: 'Ali',
    texts: ['first'],
    images: [],
    queuedAt: '2026-01-01T00:00:00.000Z',
    process: async () => {}
  };
  const second = {
    jid: '1002@s.whatsapp.net',
    pushName: 'Sara',
    texts: ['second'],
    images: [],
    queuedAt: '2026-01-01T00:00:01.000Z',
    process: async () => {}
  };

  try {
    queue.enqueue(first);
    queue.enqueue(second);
    queue.markReady(first);
    queue.markReady(second);
    assert.equal(queue.takeNext(), first);
    assert.equal(queue.cancelWaiting(first.jid), null);
    assert.equal(queue.cancelWaiting(second.jid), second);
    assert.deepEqual(queue.snapshot().waiting, []);
    assert.equal(queue.snapshot().active.name, 'Ali');
    assert.equal(readIncomingChatQueue(queue.filePath).waiting.length, 0);
    queue.finish(first);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
