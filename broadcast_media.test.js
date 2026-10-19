import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAdminDashboardServer } from './admin_dashboard.js';
import {
  MAX_BROADCAST_MEDIA_BYTES,
  readBroadcastMedia,
  saveBroadcastMedia,
  validateBroadcastMedia
} from './broadcast_media.js';
import {
  sendBroadcastContent,
  sendLessonBroadcastVideo
} from './broadcast_manager.js';

const testAuthManager = {
  status: () => ({ setupRequired: false, authenticated: true }),
  isAuthenticated: () => true,
  isConfigured: () => true,
  setup: async () => ({ ok: true }),
  login: async () => ({ ok: true, token: 'test-session', maxAge: 60 }),
  logout: () => {},
  setCookie: () => {},
  clearCookie: () => {}
};

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('broadcast media validates, stores, and reads supported files', () => {
  const directory = temporaryDirectory('broadcast-media-test-');
  try {
    assert.equal(MAX_BROADCAST_MEDIA_BYTES, 300 * 1024 * 1024);
    assert.throws(() => validateBroadcastMedia({
      fileName: 'voice.webm',
      mimeType: 'image/png',
      size: 10
    }), /file type is not supported/);
    assert.throws(() => validateBroadcastMedia({
      fileName: 'voice.webm',
      mimeType: 'audio/webm',
      size: MAX_BROADCAST_MEDIA_BYTES + 1
    }), /300 MB/);
    assert.doesNotThrow(() => validateBroadcastMedia({
      fileName: 'large-video.mp4',
      mimeType: 'video/mp4',
      size: MAX_BROADCAST_MEDIA_BYTES
    }));
    assert.throws(() => validateBroadcastMedia({
      fileName: 'image.png',
      mimeType: 'image/png',
      size: 10,
      voiceNote: true
    }), /must be an audio recording/);

    const attachment = saveBroadcastMedia(Buffer.from('voice'), {
      fileName: 'voice-note.webm',
      mimeType: 'audio/webm;codecs=opus',
      voiceNote: true
    }, directory);
    assert.equal(attachment.voiceNote, true);
    assert.deepEqual(readBroadcastMedia(attachment.id, directory), {
      id: attachment.id,
      fileName: 'voice-note.webm',
      mimeType: 'audio/webm',
      size: 5,
      voiceNote: true,
      buffer: Buffer.from('voice')
    });

    test('lesson video broadcast sends the configured clip and rejects paths outside lesson media', async () => {
      const directory = temporaryDirectory('lesson-broadcast-video-');
      const videoPath = path.join(directory, 'grade_1_primary', 'lesson.mp4');
      fs.mkdirSync(path.dirname(videoPath), { recursive: true });
      fs.writeFileSync(videoPath, Buffer.from('lesson-video'));
      const sent = [];
      const socket = {
        sendPresenceUpdate: async () => {},
        sendMessage: async (jid, content) => sent.push({ jid, content })
      };

      try {
        await sendLessonBroadcastVideo(socket, '1001@s.whatsapp.net', {
          videoFile: 'grade_1_primary/lesson.mp4',
          title: 'Lesson 1',
          caption: 'Watch this lesson'
        }, directory);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].jid, '1001@s.whatsapp.net');
        assert.equal(sent[0].content.video.toString(), 'lesson-video');
        assert.equal(sent[0].content.caption, 'Watch this lesson');
        assert.equal(sent[0].content.mimetype, 'video/mp4');

        await assert.rejects(sendLessonBroadcastVideo(socket, '1001@s.whatsapp.net', {
          videoFile: '..\\outside.mp4'
        }, directory));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('broadcast media API rejects foreign origins and queues validated attachment metadata', async () => {
  const directory = temporaryDirectory('broadcast-media-api-test-');
  const server = createAdminDashboardServer({
    authManager: testAuthManager,
    readData: () => ({
      history: { '1001@s.whatsapp.net': [{ role: 'client', text: 'Hello', timestamp: 1 }] },
      contacts: {
        '1001@s.whatsapp.net': { name: 'Es Student', isEs: true, savedInAddressBook: true }
      }
    }),
    broadcastMediaDirectory: path.join(directory, 'media'),
    broadcastFiles: {
      requests: path.join(directory, 'requests.json'),
      state: path.join(directory, 'state.json')
    },
    blockedContactsFile: path.join(directory, 'blocked.json'),
    contactGenderFile: path.join(directory, 'genders.json'),
    contactSyncRequestsFile: path.join(directory, 'contact-sync.json'),
    contactSyncStatusFile: path.join(directory, 'contact-sync-status.json')
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const uploadUrl = `${origin}/api/admin/broadcast-media`;
    const foreignOriginResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Origin: 'http://example.com',
        'Content-Type': 'audio/webm',
        'X-File-Name': 'voice.webm'
      },
      body: Buffer.from('voice')
    });
    assert.equal(foreignOriginResponse.status, 403);

    const oversizedResponse = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/admin/broadcast-media',
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'video/mp4',
          'X-File-Name': 'large-video.mp4',
          'Content-Length': String(MAX_BROADCAST_MEDIA_BYTES + 1)
        }
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({
          status: response.statusCode,
          body: JSON.parse(body)
        }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(oversizedResponse.status, 413);
    assert.match(oversizedResponse.body.error, /300 MB/);

    const malformedAttachmentsResponse = await fetch(`${origin}/api/admin/broadcasts`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Lesson details',
        jids: ['1001@s.whatsapp.net'],
        attachments: 'not-an-array'
      })
    });
    assert.equal(malformedAttachmentsResponse.status, 400);

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'audio/webm;codecs=opus',
        'X-File-Name': encodeURIComponent('voice-note.webm'),
        'X-Voice-Note': 'true'
      },
      body: Buffer.from('voice')
    });
    assert.equal(uploadResponse.status, 201);
    const attachment = await uploadResponse.json();

    const broadcastsUrl = `${origin}/api/admin/broadcasts`;
    const missingAttachmentResponse = await fetch(broadcastsUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '',
        jids: ['1001@s.whatsapp.net'],
        attachments: ['00000000-0000-0000-0000-000000000000']
      })
    });
    assert.equal(missingAttachmentResponse.status, 400);

    const queueResponse = await fetch(broadcastsUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '',
        jids: ['1001@s.whatsapp.net'],
        attachments: [attachment.id]
      })
    });
    assert.equal(queueResponse.status, 202);
    const queued = JSON.parse(fs.readFileSync(path.join(directory, 'requests.json'), 'utf8'));
    assert.equal(queued[0].id, (await queueResponse.json()).id);
    assert.deepEqual(queued[0].attachments.map(({ id, fileName, mimeType, voiceNote }) => ({
      id, fileName, mimeType, voiceNote
    })), [{
      id: attachment.id,
      fileName: 'voice-note.webm',
      mimeType: 'audio/webm',
      voiceNote: true
    }]);

    const invalidTypeResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'image/png',
        'X-File-Name': encodeURIComponent('voice.webm')
      },
      body: Buffer.from('invalid')
    });
    assert.equal(invalidTypeResponse.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('broadcast delivery sends voice notes, images with captions, video, and documents', async () => {
  const directory = temporaryDirectory('broadcast-media-send-test-');
  const sent = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content) => sent.push({ jid, content })
  };
  try {
    const attachments = [
      saveBroadcastMedia(Buffer.from('voice'), {
        fileName: 'voice.webm',
        mimeType: 'audio/webm',
        voiceNote: true
      }, directory),
      saveBroadcastMedia(Buffer.from('image'), {
        fileName: 'image.png',
        mimeType: 'image/png'
      }, directory),
      saveBroadcastMedia(Buffer.from('video'), {
        fileName: 'video.mp4',
        mimeType: 'video/mp4'
      }, directory),
      saveBroadcastMedia(Buffer.from('document'), {
        fileName: 'handout.pdf',
        mimeType: 'application/pdf'
      }, directory)
    ];

    await sendBroadcastContent(socket, '1001@s.whatsapp.net', '', [attachments[0]], directory);
    await sendBroadcastContent(socket, '1001@s.whatsapp.net', 'Lesson details', [attachments[1]], directory);
    await sendBroadcastContent(socket, '1001@s.whatsapp.net', '', [attachments[2], attachments[3]], directory);

    assert.deepEqual(sent.map(({ content }) => Object.keys(content).sort()), [
      ['audio', 'mimetype', 'ptt'],
      ['caption', 'image', 'mimetype'],
      ['mimetype', 'video'],
      ['document', 'fileName', 'mimetype']
    ]);
    assert.equal(sent[0].content.ptt, true);
    assert.equal(sent[1].content.caption, 'Lesson details');
    assert.equal(sent[3].content.fileName, 'handout.pdf');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
