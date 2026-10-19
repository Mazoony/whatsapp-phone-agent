import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BLOCKED_CONTACTS_FILE = path.join(ROOT_DIR, 'data', 'blocked_contacts.json');

export function normalizePhoneNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[^0-9]/g, '');
}

export function createBlockedContactsStore(filePath = BLOCKED_CONTACTS_FILE) {
  let cachedSignature = null;
  let cachedRecords = [];

  function read() {
    let signature = null;
    try {
      const stats = fs.statSync(filePath);
      signature = `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (signature === cachedSignature) return cachedRecords.map(record => ({ ...record }));
    if (signature === null) {
      cachedSignature = null;
      cachedRecords = [];
      return [];
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed.blockedNumbers) || parsed.blockedNumbers.some(record =>
      !record || typeof record.number !== 'string' || !/^\d{5,15}$/.test(record.number) ||
      (record.name != null && typeof record.name !== 'string') ||
      !['banned', 'deleted'].includes(record.reason))) {
      throw new Error(`Invalid blocked contacts file: ${filePath}`);
    }

    cachedSignature = signature;
    cachedRecords = parsed.blockedNumbers;
    return cachedRecords.map(record => ({ ...record }));
  }

  function write(records) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify({ blockedNumbers: records }, null, 2), 'utf8');
      fs.renameSync(temporaryPath, filePath);
      cachedSignature = null;
      cachedRecords = [];
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Blocked Contacts] Could not remove temporary file:', cleanupError.message);
      }
      throw error;
    }
  }

  function block(number, reason, name = '') {
    const normalized = normalizePhoneNumber(number);
    if (!/^\d{5,15}$/.test(normalized)) {
      throw new Error('Enter a valid phone number with 5 to 15 digits.');
    }
    if (!['banned', 'deleted'].includes(reason)) {
      throw new Error('Blocked contact reason must be banned or deleted.');
    }
    if (typeof name !== 'string') {
      throw new Error('Blocked contact name must be text.');
    }
    const records = read();
    const existingIndex = records.findIndex(record => record.number === normalized);
    const existingRecord = existingIndex === -1 ? null : records[existingIndex];
    const cleanName = name.trim().slice(0, 200);
    const record = {
      number: normalized,
      ...(cleanName || existingRecord?.name ? { name: cleanName || existingRecord.name } : {}),
      reason,
      blockedAt: new Date().toISOString()
    };
    if (existingIndex === -1) records.push(record);
    else records[existingIndex] = record;
    write(records);
    return record;
  }

  function unblock(number) {
    const normalized = normalizePhoneNumber(number);
    const records = read();
    const remaining = records.filter(record => record.number !== normalized);
    if (remaining.length !== records.length) write(remaining);
    return remaining.length !== records.length;
  }

  return {
    list: read,
    has(number) {
      const normalized = normalizePhoneNumber(number);
      return read().some(record => record.number === normalized);
    },
    block,
    unblock
  };
}

export const blockedContactsStore = createBlockedContactsStore();
