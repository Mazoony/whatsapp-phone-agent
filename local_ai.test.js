import assert from 'node:assert/strict';
import test from 'node:test';
import { generateLocalResponse } from './local_ai.js';
import { config } from './config.js';

test('local model requests use the configured Ollama model and system context', async () => {
  let request;
  const result = await generateLocalResponse('Answer briefly.', {
    systemInstruction: 'You are a helpful English tutor.',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ message: { content: 'Hello.' } })
      };
    }
  });

  assert.equal(result, 'Hello.');
  assert.equal(request.url, `${config.ollamaBaseUrl}/api/chat`);
  assert.equal(request.body.model, config.ollamaModel);
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: 'You are a helpful English tutor.' },
    { role: 'user', content: 'Answer briefly.' }
  ]);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.think, false);
});

test('local model supports constrained JSON responses', async () => {
  let requestBody;
  const result = await generateLocalResponse('Return JSON.', {
    format: 'json',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ message: { content: '{"ok":true}' } })
      };
    }
  });

  assert.deepEqual(JSON.parse(result), { ok: true });
  assert.equal(requestBody.format, 'json');
});

test('local model connection and HTTP failures have actionable errors', async () => {
  await assert.rejects(
    generateLocalResponse('Hello', {
      fetchImpl: async () => { throw new TypeError('fetch failed'); }
    }),
    /Could not connect to Ollama/
  );
  await assert.rejects(
    generateLocalResponse('Hello', {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => 'model unavailable'
      })
    }),
    /Ollama returned HTTP 503: model unavailable/
  );
});
