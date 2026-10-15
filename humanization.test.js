import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTypingDelayMs } from './humanization.js';

test('estimates typing delay at the configured words-per-minute rate', () => {
  assert.equal(calculateTypingDelayMs('hello', 40), 1500);
  assert.equal(calculateTypingDelayMs('a'.repeat(100), 40), 30000);
});

test('applies a one-second minimum to short messages', () => {
  assert.equal(calculateTypingDelayMs('ok', 40), 1000);
});

test('counts Unicode code points when estimating typing time', () => {
  assert.equal(calculateTypingDelayMs('😀'.repeat(10), 40), 3000);
});

test('rejects invalid typing speeds and minimum delays', () => {
  assert.throws(() => calculateTypingDelayMs('hello', 0), RangeError);
  assert.throws(() => calculateTypingDelayMs('hello', 40, -1), RangeError);
});
