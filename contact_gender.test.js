import assert from 'node:assert/strict';
import test from 'node:test';
import { inferContactGender } from './contact_gender.js';

test('infers gender only from a client self-description in English or Sudanese Arabic', () => {
  assert.deepEqual(inferContactGender([
    { role: 'client', text: 'أنا طالبة في الصف الثالث' }
  ]), { value: 'female', confidence: 'inferred from self-description' });
  assert.deepEqual(inferContactGender([
    { role: 'client', text: 'أنا خايف من الامتحان' }
  ]), { value: 'male', confidence: 'inferred from self-description' });
  assert.deepEqual(inferContactGender([
    { role: 'client', text: "I'm a woman and I study English" }
  ]), { value: 'female', confidence: 'inferred from self-description' });
});

test('does not guess from names, third-person mentions, or the agent response', () => {
  assert.equal(inferContactGender([
    { role: 'client', text: 'سارة عندها امتحان بكرة' },
    { role: 'agent', text: 'أنا طالبة، كيف أساعدك؟' }
  ]).value, 'unknown');
  assert.equal(inferContactGender([
    { role: 'client', text: 'أنا طالب، وأختي خايفة من الامتحان' }
  ]).value, 'male');
  assert.equal(inferContactGender([]).value, 'unknown');
});

test('reports unknown when client messages contain conflicting self-descriptions', () => {
  assert.equal(inferContactGender([
    { role: 'client', text: 'أنا طالبة' },
    { role: 'client', text: 'أنا طالب' }
  ]).value, 'unknown');
});
