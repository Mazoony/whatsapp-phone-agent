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

test('restored history combines linked phone and LID messages in chronological order', () => {
  const phoneJid = '249000000020@s.whatsapp.net';
  const lidJid = '100000000000020@lid';
  const previousPhoneContact = historyManager.contacts[phoneJid];
  const previousLidContact = historyManager.contacts[lidJid];
  const previousPhoneHistory = historyManager.history[phoneJid];
  const previousLidHistory = historyManager.history[lidJid];

  try {
    historyManager.contacts[phoneJid] = { jid: phoneJid, phoneJid, isEs: true };
    historyManager.contacts[lidJid] = { jid: lidJid, phoneJid, isEs: true };
    historyManager.history[phoneJid] = [
      { id: 'first', role: 'client', text: 'Hello', timestamp: 1_700_000_000_000 },
      { id: 'shared', role: 'agent', text: 'Welcome back', timestamp: 1_700_000_002_000 }
    ];
    historyManager.history[lidJid] = [
      { id: 'shared', role: 'agent', text: 'Welcome back', timestamp: 1_700_000_002_000 },
      { id: 'latest', role: 'client', text: 'I am ready for lesson two', timestamp: 1_700_000_003_000 }
    ];

    const messages = historyManager.getConversationMessages(lidJid);
    assert.deepEqual(messages.map(message => message.id), ['first', 'shared', 'latest']);

    const dialogue = historyManager.getDialogueForAgent(lidJid, 'Student');
    assert.ok(dialogue.indexOf('Hello') < dialogue.indexOf('Welcome back'));
    assert.ok(dialogue.indexOf('Welcome back') < dialogue.indexOf('I am ready for lesson two'));
    assert.match(dialogue, /Total stored messages across linked WhatsApp IDs: 3/);
  } finally {
    if (previousPhoneContact) historyManager.contacts[phoneJid] = previousPhoneContact;
    else delete historyManager.contacts[phoneJid];
    if (previousLidContact) historyManager.contacts[lidJid] = previousLidContact;
    else delete historyManager.contacts[lidJid];
    if (previousPhoneHistory) historyManager.history[phoneJid] = previousPhoneHistory;
    else delete historyManager.history[phoneJid];
    if (previousLidHistory) historyManager.history[lidJid] = previousLidHistory;
    else delete historyManager.history[lidJid];
  }
});

test('history retains up to 5000 messages for every contact and ignores repeated sync IDs', () => {
  const jid = '249000000021@s.whatsapp.net';
  const previousHistory = historyManager.history[jid];
  const previousSave = historyManager.scheduleSave;
  historyManager.scheduleSave = () => {};

  try {
    historyManager.history[jid] = Array.from({ length: 5000 }, (_, index) => ({
      role: 'client',
      text: `Message ${index}`,
      timestamp: index
    }));
    historyManager.addMessage(jid, 'client', 'Latest message', 5001, '', 'latest-id');
    historyManager.addMessage(jid, 'client', 'Duplicate latest message', 5002, '', 'latest-id');

    assert.equal(historyManager.history[jid].length, 5000);
    assert.equal(historyManager.history[jid][0].text, 'Message 1');
    assert.equal(historyManager.history[jid].at(-1).text, 'Latest message');
  } finally {
    historyManager.scheduleSave = previousSave;
    if (previousHistory) historyManager.history[jid] = previousHistory;
    else delete historyManager.history[jid];
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
