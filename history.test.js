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
