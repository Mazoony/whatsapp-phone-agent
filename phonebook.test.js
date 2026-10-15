import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContactInsertArgs, getPhoneJid } from './phonebook.js';

test('prefers the WhatsApp phone-number JID over an LID', () => {
  assert.equal(
    getPhoneJid('123456789@lid', '249123456789@s.whatsapp.net'),
    '249123456789@s.whatsapp.net'
  );
});

test('builds an Android contact form intent with the Es-prefixed profile name', () => {
  assert.deepEqual(
    buildContactInsertArgs('249123456789@s.whatsapp.net', 'Es - Student Name'),
    [
      'start',
      '-a', 'android.intent.action.INSERT',
      '-t', 'vnd.android.cursor.dir/contact',
      '--es', 'name', 'Es - Student Name',
      '--es', 'phone', '249123456789'
    ]
  );
});

test('does not build a contact intent for a LID or malformed phone number', () => {
  assert.equal(buildContactInsertArgs('123456789@lid', 'Es - Student'), null);
  assert.equal(buildContactInsertArgs('abc@s.whatsapp.net', 'Es - Student'), null);
  assert.equal(buildContactInsertArgs('249123456789@s.whatsapp.net', ''), null);
});
