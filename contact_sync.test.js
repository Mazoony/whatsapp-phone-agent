import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContactSyncManager } from './contact_sync.js';

test('queues a WhatsApp contact sync and records completion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-sync-test-'));
  const manager = new ContactSyncManager({
    requestsFile: path.join(directory, 'requests.json'),
    statusFile: path.join(directory, 'status.json'),
    settleDelayMs: 0
  });
  const request = manager.queueRequest();
  const socket = { resyncAppState: async collections => {
    assert.deepEqual(collections, ['critical_unblock_low']);
  } };

  try {
    assert.equal(request.status, 'queued');
    manager.socket = socket;
    await manager.processNext(socket);
    assert.equal(manager.getStatus(request.id).status, 'completed');
  } finally {
    manager.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('records a failed contact sync and exposes its error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-sync-failure-test-'));
  const manager = new ContactSyncManager({
    requestsFile: path.join(directory, 'requests.json'),
    statusFile: path.join(directory, 'status.json'),
    settleDelayMs: 0
  });
  const request = manager.queueRequest();
  const socket = {
    resyncAppState: async () => {
      throw new Error('WhatsApp unavailable');
    }
  };

  try {
    manager.socket = socket;
    await manager.processNext(socket);
    const status = manager.getStatus(request.id);
    assert.equal(status.id, request.id);
    assert.equal(status.status, 'failed');
    assert.equal(status.createdAt, request.createdAt);
    assert.equal(status.error, 'WhatsApp unavailable');
    assert.ok(status.startedAt);
    assert.ok(status.completedAt);
  } finally {
    manager.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
