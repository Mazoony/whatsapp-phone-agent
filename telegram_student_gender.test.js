import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTelegramStudentGender,
  inferTelegramGenderFromMessage,
  inferTelegramGenderFromName,
  personalizeTelegramMessage
} from './telegram_student_gender.js';

test('Telegram gender inference uses only recognized names and explicit self-description', () => {
  assert.equal(inferTelegramGenderFromName('فاطمة أحمد'), 'female');
  assert.equal(inferTelegramGenderFromName('Amina Ali'), 'female');
  assert.equal(inferTelegramGenderFromName('Nour Ahmed'), 'unknown');
  assert.equal(inferTelegramGenderFromMessage('أنا طالبة في الصف الثالث'), 'female');
  assert.equal(inferTelegramGenderFromMessage('أنا طالب في الصف الثالث'), 'male');
});

test('Telegram form of address respects manual overrides and uses neutral wording when uncertain', () => {
  assert.deepEqual(getTelegramStudentGender({ name: 'مريم صالح' }), {
    value: 'female',
    source: 'inferred from name'
  });
  assert.deepEqual(getTelegramStudentGender({ name: 'نور صالح' }), {
    value: 'unknown',
    source: 'unknown'
  });
  assert.deepEqual(getTelegramStudentGender({ name: 'مريم صالح' }, 'male'), {
    value: 'male',
    source: 'manual'
  });
  assert.equal(personalizeTelegramMessage('إنت مسجل معانا، أرسلها هسي.', 'unknown'),
    'حسابك مسجل معانا، يمكن إعادة إرسالها هسي.');
});

test('Telegram feminine message variants change address and imperative wording', () => {
  assert.equal(personalizeTelegramMessage('إنت مسجل معانا، أرسلها هسي.', 'female'),
    'إنتي مسجلة معانا، أرسليها هسي.');
  assert.equal(personalizeTelegramMessage('برافو عليك، واصل بالوتيرة المناسبة ليك.', 'female'),
    'برافو عليكي، واصلي بالوتيرة المناسبة ليكي.');
  assert.equal(personalizeTelegramMessage('ممتازة، أرسلي الإجابة.', 'female'),
    'ممتازة، أرسلي الإجابة.');
  assert.equal(personalizeTelegramMessage('إجابتك «أرسل» صحيحة. أرسل الإجابة.', 'female'),
    'إجابتك «أرسل» صحيحة. أرسلي الإجابة.');
});
