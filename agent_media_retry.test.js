import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  consumeAgentMediaRetryRequests,
  enqueueAgentMediaRetry
} from './agent_media_retry.js';

test('queues each failed media activity once and consumes retry requests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-retry-queue-test-'));
  const filePath = path.join(directory, 'retries.json');
  try {
    assert.deepEqual(enqueueAgentMediaRetry('video-1', filePath), {
      activityId: 'video-1',
      queued: true
    });
    assert.deepEqual(enqueueAgentMediaRetry('video-1', filePath), {
      activityId: 'video-1',
      queued: false
    });
    const requests = consumeAgentMediaRetryRequests(filePath);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].activityId, 'video-1');
    assert.deepEqual(consumeAgentMediaRetryRequests(filePath), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects invalid retry activity IDs', () => {
  assert.throws(() => enqueueAgentMediaRetry('../video', path.join(os.tmpdir(), 'invalid-retry.json')), {
    name: 'TypeError'
  });
});
