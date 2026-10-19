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

test('local task grading can cap generated tokens', async () => {
  let requestBody;
  await generateLocalResponse('Mark this answer.', {
    format: 'json',
    numPredict: 256,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ message: { content: '{"ok":true}' } })
      };
    }
  });

  assert.deepEqual(requestBody.options, { num_predict: 256 });
});

test('local image requests use the configured vision model and attach image data', async () => {
  const previousVisionModel = config.ollamaVisionModel;
  config.ollamaVisionModel = 'test-vision-model';
  let requestBody;
  try {
    await generateLocalResponse('Describe the image.', {
      images: [{ data: Buffer.from('image-bytes'), mimeType: 'image/jpeg' }],
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ message: { content: 'A picture.' } })
        };
      }
    });
  } finally {
    config.ollamaVisionModel = previousVisionModel;
  }

  assert.equal(requestBody.model, 'test-vision-model');
  assert.deepEqual(requestBody.messages.at(-1), {
    role: 'user',
    content: 'Describe the image.',
    images: [Buffer.from('image-bytes').toString('base64')]
  });
});

test('local image requests explain when no vision model is configured', async () => {
  const previousVisionModel = config.ollamaVisionModel;
  config.ollamaVisionModel = '';
  try {
    await assert.rejects(
      generateLocalResponse('Describe the image.', {
        images: [{ data: Buffer.from('image-bytes'), mimeType: 'image/jpeg' }],
        fetchImpl: async () => { throw new Error('Ollama should not be called'); }
      }),
      /OLLAMA_VISION_MODEL.*vision-capable model/
    );
  } finally {
    config.ollamaVisionModel = previousVisionModel;
  }
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
