import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import {
  getEligibleFollowUpContacts,
  isFollowUpOptOutRequest
} from './followup_manager.js';

test('selects only the most recent eligible Es chats with direct-message history', () => {
  const previousAllowedNumbers = config.allowedNumbers;
  const previousBlockedNumbers = config.blockedNumbers;
  config.allowedNumbers = 'all';
  config.blockedNumbers = [];

  try {
    const contacts = {
      recent: { jid: '249111111111@s.whatsapp.net', name: 'Es Sara', isEs: true },
      older: { jid: '249222222222@s.whatsapp.net', name: 'Es Ali', isEs: true },
      regular: { jid: '249333333333@s.whatsapp.net', name: 'Sara', isEs: false },
      group: { jid: '249444444444@g.us', name: 'Es Group', isEs: true },
      noHistory: { jid: '249555555555@s.whatsapp.net', name: 'Es New', isEs: true }
    };
    const history = {
      [contacts.recent.jid]: [{ role: 'client', text: 'Help with grammar', timestamp: 300 }],
      [contacts.older.jid]: [{ role: 'client', text: 'Exam result', timestamp: 100 }],
      [contacts.regular.jid]: [{ role: 'client', text: 'Hello', timestamp: 500 }],
      [contacts.group.jid]: [{ role: 'client', text: 'Hello', timestamp: 600 }]
    };

    assert.deepEqual(
      getEligibleFollowUpContacts(contacts, history, 1).map(contact => contact.jid),
      [contacts.recent.jid]
    );
    assert.deepEqual(
      getEligibleFollowUpContacts(contacts, history, 10).map(contact => contact.jid),
      [contacts.recent.jid, contacts.older.jid]
    );
    assert.deepEqual(
      getEligibleFollowUpContacts(contacts, history, 1, [], [contacts.older.jid]).map(contact => contact.jid),
      [contacts.older.jid]
    );
  } finally {
    config.allowedNumbers = previousAllowedNumbers;
    config.blockedNumbers = previousBlockedNumbers;
  }
});

test('recognizes explicit English and Arabic follow-up opt-out requests', () => {
  assert.equal(isFollowUpOptOutRequest('Stop sending me messages'), true);
  assert.equal(isFollowUpOptOutRequest('إيقاف'), true);
  assert.equal(isFollowUpOptOutRequest('أوقف الرسائل من فضلك'), true);
  assert.equal(isFollowUpOptOutRequest('كيف أوقف الرسائل؟'), true);
  assert.equal(isFollowUpOptOutRequest('cancel'), true);
  assert.equal(isFollowUpOptOutRequest('كيف حالك اليوم؟'), false);
  assert.equal(isFollowUpOptOutRequest('What does stop mean?'), false);
});

test('limits the initial cohort to the latest 700 eligible chats', () => {
  const previousAllowedNumbers = config.allowedNumbers;
  const previousBlockedNumbers = config.blockedNumbers;
  config.allowedNumbers = 'all';
  config.blockedNumbers = [];

  try {
    const contacts = {};
    const history = {};
    for (let index = 0; index < 705; index += 1) {
      const jid = `249${String(index).padStart(9, '0')}@s.whatsapp.net`;
      contacts[jid] = { jid, name: `Es Student ${index}`, isEs: true };
      history[jid] = [{ role: 'client', text: 'Hello', timestamp: index + 1 }];
    }

    const selected = getEligibleFollowUpContacts(contacts, history, 700);
    assert.equal(selected.length, 700);
    assert.equal(selected[0].jid, '249000000704@s.whatsapp.net');
    assert.equal(selected.at(-1).jid, '249000000005@s.whatsapp.net');
  } finally {
    config.allowedNumbers = previousAllowedNumbers;
    config.blockedNumbers = previousBlockedNumbers;
  }
});
