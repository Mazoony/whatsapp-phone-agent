import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from './config.js';
import {
  getEligibleBroadcastContacts,
  listEligibleBroadcastContacts,
  validateBroadcastRequest
} from './broadcast_utils.js';

test('broadcast recipients include all saved Es contacts except opted-out, owner-blocked, or configured blocked numbers', () => {
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
      }
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
