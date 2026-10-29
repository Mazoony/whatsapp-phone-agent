import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TelegramUserBroadcastWorker } from './telegram_user_broadcast.js';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test('Telegram user broadcasts send only to group participants who remain opted in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-user-broadcast-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const progressFile = path.join(directory, 'progress.json');
  const requestsFile = path.join(directory, 'requests.json');
  const stateFile = path.join(directory, 'state.json');
  writeJson(progressFile, {
    'telegram:-100123:11': {
      telegramChatId: '-100123',
      telegramUserId: 11,
      telegramPrivateChatId: '11',
      telegramAnnouncementsOptIn: true
    },
    'telegram:-100123:12': {
      telegramChatId: '-100123',
      telegramUserId: 12,
      telegramPrivateChatId: '12',
      telegramAnnouncementsOptIn: true
    },
    'telegram:-100123:13': {
      telegramChatId: '-100123',
      telegramUserId: 13,
      telegramPrivateChatId: '13',
      telegramAnnouncementsOptIn: false
    },
    'telegram:-100123:14': {
      telegramChatId: '-100123',
      telegramUserId: 14,
      telegramPrivateChatId: '14',
      currentLessonId: 'lesson_2'
    }
  });
  writeJson(requestsFile, [{
    id: 'job-1',
    text: 'Announcement',
    recipients: [
      { userId: '11' },
      { userId: '12' },
      { userId: '13' },
      { userId: '14' }
    ],
    createdAt: new Date().toISOString(),
    cancelled: false
  }]);

  const sent = [];
  const client = {
    getDialogs: async () => [{ entity: { id: 123 } }],
    async *iterParticipants() {
      yield { id: 11 };
      yield { id: 12 };
      yield { id: 14 };
    },
    async sendMessage(participant, options) {
      sent.push({ userId: participant.id, ...options });
      if (participant.id === 11) {
        const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        progress['telegram:-100123:12'].telegramAnnouncementsOptIn = false;
        writeJson(progressFile, progress);
      }
    }
  };
  const worker = new TelegramUserBroadcastWorker({
    client,
    progressFile,
    requestsFile,
    stateFile,
    groupId: '-100123',
    sendIntervalMs: 0,
    logger: { info() {}, error() {} }
  });

  await worker.processNextJob();

  assert.deepEqual(sent, [
    { userId: 11, message: 'Announcement' },
    { userId: 14, message: 'Announcement' }
  ]);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.jobs['job-1'].status, 'completed');
  assert.equal(state.jobs['job-1'].sent, 2);
  assert.equal(state.jobs['job-1'].skipped, 2);
  assert.equal(state.jobs['job-1'].nextIndex, 4);
});

test('Telegram user broadcasts stop after a send error and mark delivery uncertain', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-user-broadcast-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const progressFile = path.join(directory, 'progress.json');
  const requestsFile = path.join(directory, 'requests.json');
  const stateFile = path.join(directory, 'state.json');
  writeJson(progressFile, {
    'telegram:-100123:11': {
      telegramChatId: '-100123',
      telegramUserId: 11,
      telegramPrivateChatId: '11',
      telegramAnnouncementsOptIn: true
    }
  });
  writeJson(requestsFile, [{
    id: 'job-error',
    text: 'Announcement',
    recipients: [{ userId: '11' }],
    createdAt: new Date().toISOString(),
    cancelled: false
  }]);

  const worker = new TelegramUserBroadcastWorker({
    client: {
      getDialogs: async () => [{ entity: { id: 123 } }],
      async *iterParticipants() {
        yield { id: 11 };
      },
      async sendMessage() {
        throw new Error('Telegram send failed');
      }
    },
    progressFile,
    requestsFile,
    stateFile,
    groupId: '-100123',
    logger: { info() {}, error() {} }
  });

  await worker.processNextJob();

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.jobs['job-error'].status, 'failed');
  assert.equal(state.jobs['job-error'].uncertain, 1);
  assert.equal(state.jobs['job-error'].nextIndex, 0);
});
