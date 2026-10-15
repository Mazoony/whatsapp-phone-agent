import assert from 'node:assert/strict';
import test from 'node:test';
import { historyManager } from './history.js';

test('saved-contact lookup recognizes either WhatsApp JID alias', () => {
  const phoneJid = '249000000001@s.whatsapp.net';
  const lidJid = '100000000000001@lid';
  const previousPhoneEntry = historyManager.contacts[phoneJid];
  const previousLidEntry = historyManager.contacts[lidJid];

  try {
    historyManager.contacts[phoneJid] = { jid: phoneJid, savedInAddressBook: true };
    delete historyManager.contacts[lidJid];

    assert.equal(historyManager.isSavedContact(phoneJid), true);
    assert.equal(historyManager.isSavedContact(lidJid, phoneJid), true);
    assert.equal(historyManager.isSavedContact(lidJid), false);
  } finally {
    if (previousPhoneEntry) historyManager.contacts[phoneJid] = previousPhoneEntry;
    else delete historyManager.contacts[phoneJid];
    if (previousLidEntry) historyManager.contacts[lidJid] = previousLidEntry;
    else delete historyManager.contacts[lidJid];
  }
});

test('owner-blocked status is recognized across WhatsApp JID aliases', () => {
  const lidJid = '100000000000002@lid';
  const phoneJid = '249000000002@s.whatsapp.net';
  const previousLidEntry = historyManager.contacts[lidJid];
  const previousPhoneEntry = historyManager.contacts[phoneJid];

  try {
    historyManager.contacts[lidJid] = { jid: lidJid, name: 'Blocked test' };
    historyManager.blockContactForOwner(lidJid, phoneJid);

    assert.equal(historyManager.isOwnerBlockedContact(lidJid), true);
    assert.equal(historyManager.isOwnerBlockedContact(phoneJid, lidJid), true);
    assert.equal(historyManager.isOwnerBlockedContact('100000000000003@lid'), false);
  } finally {
    if (previousLidEntry) historyManager.contacts[lidJid] = previousLidEntry;
    else delete historyManager.contacts[lidJid];
    if (previousPhoneEntry) historyManager.contacts[phoneJid] = previousPhoneEntry;
    else delete historyManager.contacts[phoneJid];
  }
});

test('owner allowlist is recognized across WhatsApp JID aliases', () => {
  const lidJid = '100000000000004@lid';
  const phoneJid = '249000000004@s.whatsapp.net';
  const previousLidEntry = historyManager.contacts[lidJid];
  const previousPhoneEntry = historyManager.contacts[phoneJid];

  try {
    historyManager.contacts[lidJid] = { jid: lidJid, name: 'Allowed test', savedInAddressBook: true };
    delete historyManager.contacts[phoneJid];
    historyManager.allowContactForOwner(lidJid, phoneJid);

    assert.equal(historyManager.isOwnerAllowedContact(lidJid), true);
    assert.equal(historyManager.isOwnerAllowedContact(phoneJid, lidJid), true);
    assert.equal(historyManager.isOwnerAllowedContact('100000000000005@lid'), false);
    assert.equal(historyManager.isSavedContact(phoneJid), false);
  } finally {
    if (previousLidEntry) historyManager.contacts[lidJid] = previousLidEntry;
    else delete historyManager.contacts[lidJid];
    if (previousPhoneEntry) historyManager.contacts[phoneJid] = previousPhoneEntry;
    else delete historyManager.contacts[phoneJid];
  }
});
