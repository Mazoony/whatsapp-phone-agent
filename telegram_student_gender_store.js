import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT_DIR, 'data');
export const TELEGRAM_STUDENT_GENDER_FILE = path.join(DATA_DIR, 'telegram_student_gender.json');
const GENDER_VALUES = new Set(['female', 'male', 'unknown']);

export function createTelegramStudentGenderStore(filePath = TELEGRAM_STUDENT_GENDER_FILE) {
  function read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.entries(parsed).some(([studentKey, gender]) =>
          !/^telegram:-?\d+:\d+$/.test(studentKey) || !GENDER_VALUES.has(gender))) {
      throw new Error(`Invalid Telegram student addressing file: ${filePath}`);
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
        console.error('[Telegram Student Gender] Could not remove temporary file:', cleanupError.message);
      }
      throw error;
    }
  }

  return {
    list: read,
    set(studentKey, gender) {
      if (typeof studentKey !== 'string' || !/^telegram:-?\d+:\d+$/.test(studentKey)) {
        throw new Error('A valid Telegram student identifier is required.');
      }
      const genders = read();
      if (gender === 'auto') delete genders[studentKey];
      else if (GENDER_VALUES.has(gender)) genders[studentKey] = gender;
      else throw new Error('Gender must be female, male, unknown, or auto.');
      write(genders);
      return gender === 'auto' ? null : gender;
    }
  };
}
