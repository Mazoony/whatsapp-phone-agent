import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBlockedContactsStore,
  normalizePhoneNumber
} from './blocked_contacts.js';

test('blocked contact store normalizes, persists, updates, and unblocks phone numbers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-contacts-test-'));
  const filePath = path.join(directory, 'blocked.json');
  try {
    const store = createBlockedContactsStore(filePath);
    assert.equal(normalizePhoneNumber('+249 123-456-789'), '249123456789');
    assert.deepEqual(store.list(), []);

    store.block('+249 123-456-789', 'banned', 'Test Student');
    assert.equal(store.has('249123456789'), true);
    assert.equal(createBlockedContactsStore(filePath).has('249123456789'), true);
    assert.equal(store.list()[0].name, 'Test Student');

    store.block('249123456789', 'deleted');
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].reason, 'deleted');
    assert.equal(store.list()[0].name, 'Test Student');
    assert.equal(store.unblock('249123456789'), true);
    assert.equal(store.unblock('249123456789'), false);
    assert.deepEqual(store.list(), []);

    assert.throws(() => store.block('123', 'banned'), /5 to 15 digits/);
    assert.throws(() => store.block('249123456789', 'other'), /reason/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('blocked contact store reloads updates written by another process', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-contacts-reload-test-'));
  const filePath = path.join(directory, 'blocked.json');
  try {
    const reader = createBlockedContactsStore(filePath);
    const writer = createBlockedContactsStore(filePath);
    assert.equal(reader.has('249123456789'), false);
    writer.block('249123456789', 'banned');
    assert.equal(reader.has('249123456789'), true);
    writer.unblock('249123456789');
    assert.equal(reader.has('249123456789'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
