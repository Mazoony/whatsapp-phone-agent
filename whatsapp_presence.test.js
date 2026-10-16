import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WhatsAppPresenceManager } from './whatsapp_presence.js';

function createManager(directory, options = {}) {
  return new WhatsAppPresenceManager({
    presenceFile: path.join(directory, 'presence.json'),
    requestsFile: path.join(directory, 'requests.json'),
    ...options
  });
}

test('WhatsApp presence records online and last-seen updates for direct chat IDs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-presence-'));
  try {
    const manager = createManager(directory);
    const updatedAt = Date.now();
    const changed = manager.recordPresenceUpdate({
      id: '249123456789@s.whatsapp.net',
      presences: {
        '249123456789@s.whatsapp.net': { lastKnownPresence: 'available' }
      }
    }, updatedAt);

    assert.equal(changed, 1);
    assert.equal(manager.getPresence('249123456789@s.whatsapp.net').status, 'online');

    manager.recordPresenceUpdate({
      id: '249123456789@s.whatsapp.net',
      presences: {
        '249123456789@s.whatsapp.net': {
          lastKnownPresence: 'unavailable',
          lastSeen: Math.floor((updatedAt - 60_000) / 1000)
        }
      }
    }, updatedAt + 1000);
    const presence = manager.getPresence('249123456789@s.whatsapp.net');
    assert.equal(presence.status, 'offline');
    assert.equal(Date.parse(presence.lastSeenAt), Math.floor((updatedAt - 60_000) / 1000) * 1000);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale or hidden WhatsApp presence is never reported as confirmed online', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-presence-stale-'));
  try {
    const manager = createManager(directory, { maxAgeMs: 1 });
    const updatedAt = Date.now() - 60_000;
    manager.recordPresenceUpdate({
      id: '249123456789@s.whatsapp.net',
      presences: {
        '249123456789@s.whatsapp.net': { lastKnownPresence: 'available' }
      }
    }, updatedAt);

    assert.equal(manager.getPresence('249123456789@s.whatsapp.net').status, 'unknown');
    assert.equal(manager.getPresence('missing@s.whatsapp.net'), null);
    assert.equal(manager.recordPresenceUpdate({
      id: '249123456789@g.us',
      presences: { '249123456789@s.whatsapp.net': { lastKnownPresence: 'available' } }
    }), 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('presence subscriptions are queued once per chat during the cooldown window', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-presence-requests-'));
  try {
    const manager = createManager(directory);
    const now = Date.now();
    assert.equal(manager.requestSubscription('249123456789@s.whatsapp.net', now).status, 'queued');
    assert.equal(
      manager.requestSubscription('249123456789@s.whatsapp.net', now + 1000).status,
      'already-requested'
    );
    assert.equal(manager.requestSubscription('249123456789@lid', now + 1000).status, 'queued');
    assert.throws(() => manager.requestSubscription('123@g.us'), /direct WhatsApp chat ID/);

    const queued = JSON.parse(fs.readFileSync(path.join(directory, 'requests.json'), 'utf8'));
    assert.equal(queued.length, 2);
    assert.deepEqual(queued.map(request => request.jid), [
      '249123456789@s.whatsapp.net',
      '249123456789@lid'
    ]);
    assert.deepEqual(
      manager.requestSubscriptions([
        '249123456789@s.whatsapp.net',
        '249123456789@lid'
      ], now + 2000).map(request => request.status),
      ['already-requested', 'already-requested']
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('connected WhatsApp socket processes presence subscription requests one at a time', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-presence-worker-'));
  const manager = createManager(directory, { pollIntervalMs: 60_000 });
  try {
    manager.requestSubscriptions([
      '249123456789@s.whatsapp.net',
      '249123456780@s.whatsapp.net'
    ]);
    const subscriptions = [];
    let resolveFirst;
    const firstSubscription = new Promise(resolve => { resolveFirst = resolve; });
    const calls = [];
    const socket = {
      async presenceSubscribe(jid) {
        calls.push(jid);
        if (calls.length === 1) resolveFirst();
      }
    };
    manager.start(socket);
    await firstSubscription;
    assert.deepEqual(calls, ['249123456789@s.whatsapp.net']);
    await manager.processRequests(socket);
    assert.deepEqual(calls, [
      '249123456789@s.whatsapp.net',
      '249123456780@s.whatsapp.net'
    ]);
  } finally {
    manager.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
