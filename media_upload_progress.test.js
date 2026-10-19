import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaUploadProgress } from './media_upload_progress.js';

function createSocket(progress, onSend) {
  return {
    sendMessage: async (jid, content) => onSend(jid, content, progress)
  };
}

test('shows a live progress bar and serializes concurrent media sends', async () => {
  const output = [];
  const sentTypes = [];
  const activities = [];
  const progress = createMediaUploadProgress({
    isTTY: () => true,
    write: chunk => output.push(chunk),
    onActivity: activity => activities.push(activity)
  });
  const sock = createSocket(progress, async (_jid, content, reporter) => {
    const mediaType = ['image', 'video'].find(type => type in content);
    sentTypes.push(mediaType);
    reporter.report({ loaded: 5, total: 10 });
    await new Promise(resolve => setTimeout(resolve, 5));
    return mediaType;
  });
  progress.wrapSocket(sock);

  const results = await Promise.all([
    sock.sendMessage('student@s.whatsapp.net', { video: Buffer.alloc(10) }),
    sock.sendMessage('student@s.whatsapp.net', { image: Buffer.alloc(10) })
  ]);

  assert.deepEqual(results, ['video', 'image']);
  assert.deepEqual(sentTypes, ['video', 'image']);
  assert.match(output.join(''), /\[Video upload\].*50%/);
  assert.match(output.join(''), /\[Video upload\] Complete/);
  assert.match(output.join(''), /\[Image upload\] Complete/);
  assert.deepEqual(activities.map(activity => activity.status), [
    'queued', 'queued', 'uploading', 'uploading', 'sent', 'uploading', 'uploading', 'sent'
  ]);
  const videoProgressIndex = activities.findIndex(activity =>
    activity.mediaType === 'video' && activity.percent === 50);
  const videoSentIndex = activities.findIndex(activity =>
    activity.mediaType === 'video' && activity.status === 'sent');
  assert.ok(videoProgressIndex >= 0 && videoProgressIndex < videoSentIndex);
  assert.equal(activities[videoProgressIndex].recipientJid, 'student@s.whatsapp.net');
  assert.equal(activities.find(activity => activity.mediaType === 'video' && activity.status === 'sent')?.percent, 100);
});

test('reports completion in non-interactive terminals', async () => {
  const messages = [];
  const progress = createMediaUploadProgress({
    isTTY: () => false,
    log: message => messages.push(message),
    onActivity: () => {}
  });
  const sock = createSocket(progress, async (_jid, content) => content.document.length);
  progress.wrapSocket(sock);

  assert.equal(await sock.sendMessage('student@s.whatsapp.net', {
    document: Buffer.alloc(1024)
  }), 1024);
  assert.deepEqual(messages, ['[Media upload] Document upload complete (0.0 MB).']);
});

test('reports failed uploads and propagates the send error', async () => {
  const messages = [];
  const activities = [];
  const progress = createMediaUploadProgress({
    isTTY: () => false,
    log: message => messages.push(message),
    onActivity: activity => activities.push(activity)
  });
  const failure = new Error('WhatsApp upload failed');
  const sock = createSocket(progress, async () => {
    throw failure;
  });
  progress.wrapSocket(sock);

  await assert.rejects(
    sock.sendMessage('student@s.whatsapp.net', { audio: Buffer.alloc(4) }),
    error => error === failure
  );
  assert.deepEqual(messages, ['[Media upload] Audio upload failed (0.0 MB).']);
  assert.equal(activities.at(-1).status, 'failed');
});

test('keeps the activity ID and lesson source when retrying a failed video', async () => {
  const activities = [];
  const progress = createMediaUploadProgress({
    isTTY: () => false,
    log: () => {},
    onActivity: activity => activities.push(activity)
  });
  const sock = createSocket(progress, async () => 'sent');
  progress.wrapSocket(sock);

  await sock.sendMessage('student@s.whatsapp.net', {
    video: Buffer.alloc(4),
    caption: 'Lesson 1'
  }, undefined, {
    activityId: 'failed-activity',
    retry: { gradeKey: 'grade_3_secondary', lessonId: 'lesson_1' }
  });

  assert.equal(activities[0].id, 'failed-activity');
  assert.deepEqual(activities[0].retry, {
    gradeKey: 'grade_3_secondary',
    lessonId: 'lesson_1'
  });
  assert.equal(activities.at(-1).status, 'sent');
});

test('leaves text sends unqueued and does not display media progress', async () => {
  const output = [];
  const progress = createMediaUploadProgress({
    isTTY: () => true,
    write: chunk => output.push(chunk),
    onActivity: () => {}
  });
  const sock = createSocket(progress, async (_jid, content) => content.text);
  progress.wrapSocket(sock);

  assert.equal(await sock.sendMessage('student@s.whatsapp.net', { text: 'Hello' }), 'Hello');
  assert.deepEqual(output, []);
});
