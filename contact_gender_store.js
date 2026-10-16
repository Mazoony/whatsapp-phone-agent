import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CONTACT_GENDER_FILE = path.join(ROOT_DIR, 'data', 'contact_gender.json');
const GENDER_VALUES = new Set(['female', 'male', 'unknown']);

export function createContactGenderStore(filePath = CONTACT_GENDER_FILE) {
  function read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.entries(parsed).some(([number, gender]) =>
          !/^\d{5,15}$/.test(number) || !GENDER_VALUES.has(gender))) {
      throw new Error(`Invalid contact gender file: ${filePath}`);
    }
    return parsed;
  }

  function write(genders) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(genders, null, 2), 'utf8');
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Contact Gender] Could not remove temporary file:', cleanupError.message);
      }
      throw error;
    }
  }

  return {
    list: read,
    set(number, gender) {
      const normalizedNumber = typeof number === 'string'
        ? number.replace(/[^0-9]/g, '')
        : '';
      if (!/^\d{5,15}$/.test(normalizedNumber)) {
        throw new Error('Enter a valid phone number with 5 to 15 digits.');
      }
      const genders = read();
      if (gender === 'auto') {
        delete genders[normalizedNumber];
      } else if (GENDER_VALUES.has(gender)) {
        genders[normalizedNumber] = gender;
      } else {
        throw new Error('Gender must be female, male, unknown, or auto.');
      }
      write(genders);
      return gender === 'auto' ? null : gender;
    }
  };
}
