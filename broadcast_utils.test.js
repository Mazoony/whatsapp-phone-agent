import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import {
  getEligibleBroadcastContacts,
  listEligibleBroadcastContacts,
  validateBroadcastRequest
} from './broadcast_utils.js';

test('broadcast recipients exclude opted-out, owner-blocked, configured, and dashboard-blocked numbers', () => {
  const previousAllowedNumbers = config.allowedNumbers;
  const previousBlockedNumbers = config.blockedNumbers;
  config.allowedNumbers = 'all';
  config.blockedNumbers = [];

  try {
    const data = {
      contacts: {
        '249111111111@s.whatsapp.net': {
          name: 'Es Student',
          isEs: true,
          savedInAddressBook: true
        },
        '249222222222@s.whatsapp.net': {
          name: 'Es Opted Out',
          isEs: true,
          savedInAddressBook: true
        },
        '249333333333@s.whatsapp.net': {
          name: 'Es No Chat',
          isEs: true,
          savedInAddressBook: true
        },
        '249444444444@s.whatsapp.net': {
          name: 'Es Blocked',
          isEs: true,
          savedInAddressBook: true,
          ownerBlocked: true
        },
        '249555555555@s.whatsapp.net': {
          name: 'Regular Contact',
          isEs: false,
          savedInAddressBook: true
        },
        '249666666666@s.whatsapp.net': {
          name: 'Es Blocked by config',
          isEs: true,
          savedInAddressBook: true
        },
        '249777777777@s.whatsapp.net': {
          name: 'Es Blocked by dashboard',
          isEs: true,
          savedInAddressBook: true
        },
        '249111111111@lid': {
          jid: '249111111111@s.whatsapp.net',
          name: 'Es Student Alias',
          isEs: true,
          savedInAddressBook: true
        }
      },
      history: {
        '249111111111@lid': [{ role: 'client', text: 'Hello' }],
        '249222222222@s.whatsapp.net': [{ role: 'client', text: 'Hello' }],
        '249444444444@s.whatsapp.net': [{ role: 'client', text: 'Hello' }],
        '249555555555@s.whatsapp.net': [{ role: 'client', text: 'Hello' }]
      },
      blockedNumbers: [{ number: '249777777777', reason: 'banned' }]
    };

    config.blockedNumbers = ['249666666666'];
    const recipients = getEligibleBroadcastContacts(data, ['249222222222@s.whatsapp.net']);
    assert.deepEqual(recipients, [
      {
        jid: '249333333333@s.whatsapp.net',
        name: 'Es No Chat',
        phoneNumber: '249333333333'
      },
      {
        jid: '249111111111@s.whatsapp.net',
        name: 'Es Student',
        phoneNumber: '249111111111'
      }
    ]);
    assert.equal(listEligibleBroadcastContacts(data, [], '111').total, 1);
    assert.equal(
      getEligibleBroadcastContacts(data, ['249111111111@lid'])
        .some(contact => contact.phoneNumber === '249111111111'),
      false
    );
  } finally {
    config.allowedNumbers = previousAllowedNumbers;
    config.blockedNumbers = previousBlockedNumbers;
  }
});

test('non-Es recipients include tracked unsaved chats but exclude Es aliases and untracked contacts', () => {
  const previousAllowedNumbers = config.allowedNumbers;
  const previousBlockedNumbers = config.blockedNumbers;
  config.allowedNumbers = 'all';
  config.blockedNumbers = [];
  const data = {
    contacts: {
      '249111111111@lid': {
        phoneJid: '249111111111@s.whatsapp.net',
        name: 'Amina',
        isEs: false,
        savedInAddressBook: false
      },
      '249222222222@s.whatsapp.net': {
        name: 'Es Student',
        isEs: true,
        savedInAddressBook: true
      },
      '249222222222@lid': {
        jid: '249222222222@s.whatsapp.net',
        name: 'Amina Alias',
        isEs: false
      },
      '249333333333@s.whatsapp.net': {
        name: 'Not Yet Chatted',
        isEs: false,
        savedInAddressBook: true
      },
      '249444444444@s.whatsapp.net': {
        name: 'Owner Blocked',
        isEs: false,
        ownerBlocked: true
      },
      '249555555555@s.whatsapp.net': {
        name: 'Dashboard Blocked',
        isEs: false
      },
      '249666666666@s.whatsapp.net': {
        name: 'Opted Out',
        isEs: false
      }
    },
    history: {
      '249111111111@lid': [{ role: 'client', text: 'Hello' }],
      '249222222222@s.whatsapp.net': [{ role: 'client', text: 'Hello' }],
      '249444444444@s.whatsapp.net': [{ role: 'client', text: 'Hello' }],
      '249555555555@s.whatsapp.net': [{ role: 'client', text: 'Hello' }],
      '249666666666@s.whatsapp.net': [{ role: 'client', text: 'Hello' }],
      '249777777777@s.whatsapp.net': [{ role: 'client', text: 'Hello' }]
    },
    blockedNumbers: [{ number: '249555555555', reason: 'banned' }]
  };

  try {
    const eligible = getEligibleBroadcastContacts(
      data,
      ['249666666666@s.whatsapp.net'],
      'non-es'
    );
    assert.equal(eligible.length, 2);
    assert.ok(eligible.some(contact =>
      contact.jid === '249111111111@s.whatsapp.net' && contact.name === 'Amina'));
    assert.ok(eligible.some(contact =>
      contact.jid === '249777777777@s.whatsapp.net' && contact.name === '249777777777'));
    assert.equal(listEligibleBroadcastContacts(data, ['249666666666@s.whatsapp.net'], '', 0, 50, {
      recipientType: 'non-es'
    }).total, 2);
    assert.throws(() =>
      getEligibleBroadcastContacts(data, [], 'other'),
    /Recipient type/);
    assert.throws(() => validateBroadcastRequest({
      text: 'Hello',
      jids: ['249111111111@s.whatsapp.net'],
      recipientType: 'other'
    }), /Recipient type/);
  } finally {
    config.allowedNumbers = previousAllowedNumbers;
    config.blockedNumbers = previousBlockedNumbers;
  }
});

test('eligible broadcast contacts can be filtered by incoming-message date and timezone', () => {
  const previousAllowedNumbers = config.allowedNumbers;
  const previousBlockedNumbers = config.blockedNumbers;
  config.allowedNumbers = 'all';
  config.blockedNumbers = [];
  const phoneJid = '249111111111@s.whatsapp.net';
  const data = {
    contacts: {
      [phoneJid]: {
        name: 'Es Student',
        isEs: true,
        savedInAddressBook: true
      }
    },
    history: {
      [phoneJid]: [
        {
          role: 'client',
          text: 'Late lesson question',
          timestamp: Date.parse('2026-10-15T23:30:00.000Z') / 1000
        },
        {
          role: 'agent',
          text: 'Agent response',
          timestamp: Date.parse('2026-10-15T23:35:00.000Z') / 1000
        }
      ]
    }
  };

  try {
    const result = listEligibleBroadcastContacts(data, [], '', 0, 50, {
      date: '2026-10-16',
      timeZone: 'Asia/Riyadh'
    });
    assert.equal(result.total, 1);
    assert.equal(result.contacts[0].jid, phoneJid);
    assert.equal(result.contacts[0].lastIncomingMessage, 'Late lesson question');
    assert.equal(result.contacts[0].lastIncomingAt, Date.parse('2026-10-15T23:30:00.000Z'));
    assert.equal(listEligibleBroadcastContacts(data, [], '', 0, 50, {
      date: '2026-10-15',
      timeZone: 'Asia/Riyadh'
    }).total, 0);
    assert.throws(() => listEligibleBroadcastContacts(data, [], '', 0, 50, {
      date: '2026-02-30',
      timeZone: 'UTC'
    }), /valid calendar day/);
    assert.throws(() => listEligibleBroadcastContacts(data, [], '', 0, 50, {
      date: '2026-10-16',
      timeZone: 'Not/A_Timezone'
    }), /timezone is invalid/);
  } finally {
    config.allowedNumbers = previousAllowedNumbers;
    config.blockedNumbers = previousBlockedNumbers;
  }
});

test('WhatsApp chat timestamps are exposed for every eligible recipient and support date filtering', () => {
  const previousAllowedNumbers = config.allowedNumbers;
  const previousBlockedNumbers = config.blockedNumbers;
  config.allowedNumbers = 'all';
  config.blockedNumbers = [];
  const phoneJid = '249111111111@s.whatsapp.net';
  const aliasJid = '249111111111@lid';
  const unavailableJid = '249222222222@s.whatsapp.net';
  const localHistoryJid = '249333333333@s.whatsapp.net';
  const timestamp = Date.parse('2026-10-16T09:45:00.000Z');
  const localHistoryTimestamp = Date.parse('2026-10-15T11:00:00.000Z');
  const data = {
    contacts: {
      [phoneJid]: { name: 'Es Student', isEs: true, savedInAddressBook: true },
      [aliasJid]: { jid: phoneJid },
      [unavailableJid]: { name: 'Es Unavailable', isEs: true, savedInAddressBook: true },
      [localHistoryJid]: { name: 'Es Local History', isEs: true, savedInAddressBook: true }
    },
    history: {
      [localHistoryJid]: [{
        role: 'client',
        text: 'Earlier message',
        timestamp: localHistoryTimestamp
      }]
    },
    whatsappChatActivity: {
      [aliasJid]: timestamp / 1000
    }
  };

  try {
    const allRecipients = listEligibleBroadcastContacts(data, [], '', 0, 50);
    assert.equal(allRecipients.total, 3);
    assert.equal(
      allRecipients.contacts.find(contact => contact.jid === phoneJid).lastActivityAt,
      timestamp
    );
    assert.equal(
      allRecipients.contacts.find(contact => contact.jid === phoneJid).activitySource,
      'whatsapp'
    );
    assert.equal(
      allRecipients.contacts.find(contact => contact.jid === unavailableJid).lastActivityAt,
      null
    );
    assert.equal(
      allRecipients.contacts.find(contact => contact.jid === unavailableJid).activitySource,
      null
    );
    assert.equal(
      allRecipients.contacts.find(contact => contact.jid === localHistoryJid).lastActivityAt,
      localHistoryTimestamp
    );
    assert.equal(
      allRecipients.contacts.find(contact => contact.jid === localHistoryJid).activitySource,
      'history'
    );

    const datedRecipients = listEligibleBroadcastContacts(data, [], '', 0, 50, {
      date: '2026-10-16',
      timeZone: 'UTC'
    });
    assert.deepEqual(datedRecipients.contacts.map(contact => contact.jid), [phoneJid]);
    assert.equal(datedRecipients.contacts[0].lastActivityAt, timestamp);
    assert.equal(datedRecipients.contacts[0].lastIncomingAt, undefined);
  } finally {
    config.allowedNumbers = previousAllowedNumbers;
    config.blockedNumbers = previousBlockedNumbers;
  }
});

test('broadcast requests require non-empty text and unique valid recipient JIDs', () => {
  assert.deepEqual(validateBroadcastRequest({
    text: '  Hello students  ',
    jids: ['249111111111@s.whatsapp.net']
  }), {
    text: 'Hello students',
    jids: ['249111111111@s.whatsapp.net']
  });
  assert.throws(() => validateBroadcastRequest({ text: ' ', jids: ['249111111111@s.whatsapp.net'] }));
  assert.throws(() => validateBroadcastRequest({
    text: 'Hello',
    jids: ['249111111111@s.whatsapp.net', '249111111111@s.whatsapp.net']
  }));
  assert.throws(() => validateBroadcastRequest({ text: 'Hello', jids: ['123@lid'] }));
});
