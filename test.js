import { config } from './config.js';
import { historyManager } from './history.js';

console.log('Testing Config, History & Permanent Es Contact Access...');

// 1. Test Config
console.log('Bot Role:', config.botRole);
console.log('Should reply to 1234567890:', config.shouldReplyTo('1234567890'));

// 2. Test Es Detection
console.log('\n--- Testing Es Contact Name Matching ---');
const testNames = [
  { name: 'Es - Ahmed', expected: true },
  { name: 'Esraa', expected: true },
  { name: 'ES Student', expected: true },
  { name: 'eSchool Mazen', expected: true },
  { name: 'student_es', expected: true },
  { name: 'Ali Mohamed', expected: false },
  { name: 'Fatima', expected: false }
];

for (const { name, expected } of testNames) {
  const result = config.isEsContact(name);
  console.log(`Checking "${name}": ${result === expected ? '✅ PASS' : '❌ FAIL'} (got ${result})`);
  if (result !== expected) {
    throw new Error(`Failed Es check for ${name}`);
  }
}

// 3. Test Permanent Retention for Es vs Non-Es
console.log('\n--- Testing Permanent History Retention ---');
const nonEsJid = '99990001@s.whatsapp.net';
const esJid = '99990002@s.whatsapp.net';

// Add 30 messages to non-Es contact
for (let i = 1; i <= 30; i++) {
  historyManager.addMessage(nonEsJid, 'client', `Regular message ${i}`, Date.now() + i, 'Ali');
}
const nonEsCount = historyManager.history[nonEsJid].length;
console.log(`Non-Es contact message count: ${nonEsCount} (Expected: 20) -> ${nonEsCount === 20 ? '✅ PASS' : '❌ FAIL'}`);
if (nonEsCount !== 20) throw new Error('Non-Es contact was not capped to 20 messages');

// Add 30 messages to Es contact
for (let i = 1; i <= 30; i++) {
  historyManager.addMessage(esJid, 'client', `Es student message ${i}`, Date.now() + i, 'Es Mohamed');
}
const esCount = historyManager.history[esJid].length;
console.log(`Es contact message count: ${esCount} (Expected: 30 permanent) -> ${esCount === 30 ? '✅ PASS' : '❌ FAIL'}`);
if (esCount !== 30) throw new Error('Es contact was truncated; expected permanent retention of all 30 messages');

// 4. Test Dialogue output for Agent
const esDialogue = historyManager.getDialogueForAgent(esJid, 'Es Mohamed');
console.log('\n--- Dialogue for Es Contact Sample Output ---');
console.log(esDialogue.substring(0, 200) + '...');
const hasNotice = esDialogue.includes('PERMANENT CHAT MEMORY ACTIVE - ES CONTACT');
console.log(`Contains Permanent Memory Notice: ${hasNotice ? '✅ PASS' : '❌ FAIL'}`);
if (!hasNotice) throw new Error('Es dialogue did not contain permanent memory notice');

console.log('\n[PASS] All local tests for permanent Es contact access passed successfully!');
