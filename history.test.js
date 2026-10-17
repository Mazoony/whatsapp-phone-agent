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

test('conversation lookup recognizes linked WhatsApp IDs and ignores empty history', () => {
  const phoneJid = '249000000010@s.whatsapp.net';
  const lidJid = '100000000000010@lid';
  const previousPhoneContact = historyManager.contacts[phoneJid];
  const previousLidContact = historyManager.contacts[lidJid];
  const previousPhoneHistory = historyManager.history[phoneJid];

  try {
    historyManager.contacts[phoneJid] = { jid: phoneJid, phoneJid };
    historyManager.contacts[lidJid] = { jid: lidJid, phoneJid };
    historyManager.history[phoneJid] = [{ role: 'client', text: 'Existing chat' }];

    assert.equal(historyManager.hasConversation(lidJid), true);
    historyManager.history[phoneJid] = [];
    assert.equal(historyManager.hasConversation(lidJid), false);
  } finally {
    if (previousPhoneContact) historyManager.contacts[phoneJid] = previousPhoneContact;
    else delete historyManager.contacts[phoneJid];
    if (previousLidContact) historyManager.contacts[lidJid] = previousLidContact;
    else delete historyManager.contacts[lidJid];
    if (previousPhoneHistory) historyManager.history[phoneJid] = previousPhoneHistory;
    else delete historyManager.history[phoneJid];
  }
});

test('synced WhatsApp contacts preserve phone-number links for LID aliases', () => {
  const phoneJid = '249000000009@s.whatsapp.net';
  const lidJid = '100000000000009@lid';
  const previousPhoneEntry = historyManager.contacts[phoneJid];
  const previousLidEntry = historyManager.contacts[lidJid];

  try {
    historyManager.saveWhatsAppContact({
      id: lidJid,
      jid: phoneJid,
      lid: lidJid,
      name: 'New student Es'
    });

    assert.equal(historyManager.contacts[phoneJid].phoneJid, phoneJid);
    assert.equal(historyManager.contacts[lidJid].phoneJid, phoneJid);
    assert.equal(historyManager.contacts[lidJid].savedInAddressBook, true);
    assert.equal(historyManager.contacts[lidJid].isEs, true);
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

test('lesson delivery consent is saved and recognized across WhatsApp JID aliases', () => {
  const lidJid = '100000000000006@lid';
  const phoneJid = '249000000006@s.whatsapp.net';
  const previousLidEntry = historyManager.contacts[lidJid];
  const previousPhoneEntry = historyManager.contacts[phoneJid];
  const previousSave = historyManager.scheduleSaveContacts;
  historyManager.scheduleSaveContacts = () => {};

  try {
    historyManager.setLessonDeliveryConsent(true, lidJid, phoneJid);
    assert.equal(historyManager.hasLessonDeliveryConsent(lidJid), true);
    assert.equal(historyManager.hasLessonDeliveryConsent(phoneJid), true);

    historyManager.setLessonDeliveryConsent(false, lidJid, phoneJid);
    assert.equal(historyManager.hasLessonDeliveryConsent(lidJid, phoneJid), false);
  } finally {
    historyManager.scheduleSaveContacts = previousSave;
    if (previousLidEntry) historyManager.contacts[lidJid] = previousLidEntry;
    else delete historyManager.contacts[lidJid];
    if (previousPhoneEntry) historyManager.contacts[phoneJid] = previousPhoneEntry;
    else delete historyManager.contacts[phoneJid];
  }
});

test('welcome sample state is stored and recognized across WhatsApp aliases', () => {
  const lidJid = '100000000000011@lid';
  const phoneJid = '249000000011@s.whatsapp.net';
  const previousLidEntry = historyManager.contacts[lidJid];
  const previousPhoneEntry = historyManager.contacts[phoneJid];
  const previousSave = historyManager.scheduleSaveContacts;
  historyManager.scheduleSaveContacts = () => {};

  try {
    historyManager.contacts[lidJid] = { jid: lidJid, phoneJid };
    historyManager.setWelcomeSampleState('pending_grade', lidJid, phoneJid);
    assert.equal(historyManager.getWelcomeSampleState(phoneJid), 'pending_grade');
    historyManager.setWelcomeSampleState('sent', phoneJid);
    assert.equal(historyManager.getWelcomeSampleState(lidJid), 'sent');
    historyManager.setWelcomeSampleState(null, lidJid, phoneJid);
    assert.equal(historyManager.getWelcomeSampleState(lidJid, phoneJid), null);
  } finally {
    historyManager.scheduleSaveContacts = previousSave;
    if (previousLidEntry) historyManager.contacts[lidJid] = previousLidEntry;
    else delete historyManager.contacts[lidJid];
    if (previousPhoneEntry) historyManager.contacts[phoneJid] = previousPhoneEntry;
    else delete historyManager.contacts[phoneJid];
  }
});
