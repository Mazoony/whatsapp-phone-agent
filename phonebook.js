import { execFile } from 'node:child_process';
import fs from 'node:fs';

const CONTACTS_INSERT_ACTION = 'android.intent.action.INSERT';
const CONTACTS_DIRECTORY_TYPE = 'vnd.android.cursor.dir/contact';

export function getPhoneJid(...jids) {
  return jids.find(jid => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')) || null;
}

export function buildContactInsertArgs(phoneJid, name) {
  if (!phoneJid || !phoneJid.endsWith('@s.whatsapp.net')) return null;

  const phoneNumber = phoneJid.slice(0, -'@s.whatsapp.net'.length);
  if (!/^\d+$/.test(phoneNumber) || !name?.trim()) return null;

  return [
    'start',
    '-a', CONTACTS_INSERT_ACTION,
    '-t', CONTACTS_DIRECTORY_TYPE,
    '--es', 'name', name.trim(),
    '--es', 'phone', phoneNumber
  ];
}

export function isTermuxAndroid() {
  return fs.existsSync('/system/bin/am') && Boolean(process.env.PREFIX?.includes('com.termux'));
}

export function openContactInsert(phoneJid, name) {
  const args = buildContactInsertArgs(phoneJid, name);
  if (!args) {
    return Promise.reject(new Error('Cannot open contact form without a valid WhatsApp phone number and contact name.'));
  }
  if (!isTermuxAndroid()) {
    return Promise.reject(new Error('Adding a phone contact is available only when the agent runs in Termux on Android.'));
  }

  return new Promise((resolve, reject) => {
    execFile('/system/bin/am', args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Could not open the Android contact form: ${(stderr || error.message).trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
