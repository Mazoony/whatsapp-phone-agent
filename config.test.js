import assert from 'node:assert/strict';
import test from 'node:test';
import { getGeminiApiKeys } from './config.js';

test('Gemini API keys include distinct numbered fallbacks in order', () => {
  assert.deepEqual(getGeminiApiKeys({
    GEMINI_API_KEY: ' primary ',
    GEMINI_API_KEY_FALLBACK: 'fallback one',
    GEMINI_API_KEY_FALLBACK_2: 'fallback two',
    GEMINI_API_KEY_FALLBACK_3: 'fallback three',
    GEMINI_API_KEY_FALLBACK_4: 'fallback four',
    GEMINI_API_KEY_FALLBACK_10: 'fallback ten'
  }), [
    'primary',
    'fallback one',
    'fallback two',
    'fallback three',
    'fallback four',
    'fallback ten'
  ]);
});

test('Gemini API key loading removes blank, duplicate, and template values', () => {
  assert.deepEqual(getGeminiApiKeys({
    GEMINI_API_KEY: 'same',
    GEMINI_API_KEY_FALLBACK: 'same',
    GEMINI_API_KEY_FALLBACK_2: '',
    GEMINI_API_KEY_FALLBACK_3: 'your_gemini_api_key_here'
  }), ['same']);
});
