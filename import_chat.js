import fs from 'fs';
import path from 'path';
import { historyManager } from './history.js';
import { config } from './config.js';

/**
 * Script to import exported WhatsApp chats (.txt) into the agent's memory.
 * 
 * Usage:
 *   node import_chat.js <path_to_exported_chat.txt> <client_phone_number>
 * 
 * Example:
 *   node import_chat.js "./exports/mazin.txt" "254808095240332"
 */

const args = process.argv.slice(2);

if (args.length < 2) {
  console.log(`
=============================================================================
  WhatsApp Chat History Importer
=============================================================================
Usage:
  node import_chat.js "<path_to_txt_file>" "<client_phone_number>"

Example:
  node import_chat.js "./exports/chat.txt" "254808095240332"

How to export a chat from WhatsApp:
  1. Open WhatsApp on your phone and open the client's chat.
  2. Tap 3 dots (top right) > More > "Export chat" > Select "Without media".
  3. Send or copy that .txt file to your computer/phone.
  4. Run this script with the path to the file and the client's phone number!
=============================================================================
`);
  process.exit(1);
}

const filePath = path.resolve(args[0]);
const phoneNumber = args[1].replace(/[^0-9]/g, '');
const contactName = args[2] || 'Es Student';
const jid = `${phoneNumber}@s.whatsapp.net`;

if (!fs.existsSync(filePath)) {
  console.error(`[Error] File not found: ${filePath}`);
  process.exit(1);
}

historyManager.saveContact(jid, contactName);
const isEs = historyManager.isEsContact(jid, contactName);

console.log(`Reading chat file: ${filePath}`);
console.log(`Target Client: ${contactName} (${phoneNumber})`);
console.log(`Permanent Memory: ${isEs ? '✅ Enabled (Es Contact)' : 'Standard (20 messages)'}`);

const content = fs.readFileSync(filePath, 'utf-8');
const lines = content.split('\n');

// WhatsApp format regex patterns:
// 12/10/26, 14:30 - Sender Name: Message
// [12/10/2026, 2:30:15 PM] Sender Name: Message
const regexDash = /^\d{1,4}[-/.]\d{1,4}[-/.]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s+[APMapm]{2})?\s*-\s*([^:]+):\s*(.*)$/;
const regexBracket = /^\[\d{1,4}[-/.]\d{1,4}[-/.]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s+[APMapm]{2})?\]\s*([^:]+):\s*(.*)$/;

let importedCount = 0;
const ownerKeywords = [
  config.ownerName.toLowerCase(),
  'you',
  'أنت',
  'مستر مازن',
  'mazen'
];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let match = trimmed.match(regexDash) || trimmed.match(regexBracket);
  if (match) {
    const sender = match[1].trim();
    const message = match[2].trim();

    if (!message || message.includes('<Media omitted>') || message.includes('<تم استبعاد الوسائط>')) {
      continue;
    }

    // Determine role: if sender matches owner name, it's 'agent', otherwise 'client'
    const isOwner = ownerKeywords.some(k => sender.toLowerCase().includes(k));
    const role = isOwner ? 'agent' : 'client';

    historyManager.addMessage(jid, role, message, undefined, contactName);
    importedCount++;
  }
}

// Force immediate save
historyManager.scheduleSave();

console.log(`\n[SUCCESS] Imported ${importedCount} messages for ${phoneNumber}!`);
console.log(`The agent will now use this context whenever replying to this client.`);
