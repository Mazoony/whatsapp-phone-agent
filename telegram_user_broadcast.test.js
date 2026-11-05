import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Api } from 'teleproto';
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

test('Telegram user broadcasts replace every personalized name with the current student name', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-user-broadcast-personalized-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const progressFile = path.join(directory, 'progress.json');
  const requestsFile = path.join(directory, 'requests.json');
  const stateFile = path.join(directory, 'state.json');
  writeJson(progressFile, {
    'telegram:-100123:11': {
      name: 'Updated Student Name',
      telegramChatId: '-100123',
      telegramUserId: 11,
      telegramPrivateChatId: '11',
      telegramAnnouncementsOptIn: true
    }
  });
  writeJson(requestsFile, [{
    id: 'personalized-job',
    text: 'Hello {{name}}. Dear {{name}}, enjoy your offer.',
    personalized: true,
    recipients: [{ userId: '11' }],
    createdAt: new Date().toISOString(),
    cancelled: false
  }]);

  const sent = [];
  const worker = new TelegramUserBroadcastWorker({
    client: {
      getDialogs: async () => [{ entity: { id: 123 } }],
      async *iterParticipants() {
        yield { id: 11 };
      },
      async sendMessage(participant, options) {
        sent.push({ userId: participant.id, ...options });
      }
    },
    progressFile,
    requestsFile,
    stateFile,
    groupId: '-100123',
    sendIntervalMs: 0,
    logger: { info() {}, error() {} }
  });

  await worker.processNextJob();

  assert.deepEqual(sent, [{
    userId: 11,
    message: 'Hello Updated Student Name. Dear Updated Student Name, enjoy your offer.'
  }]);
});

test('Telegram discount offers can reach all current group members without private bot opt-in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-group-member-offer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const progressFile = path.join(directory, 'progress.json');
  const requestsFile = path.join(directory, 'requests.json');
  const stateFile = path.join(directory, 'state.json');
  writeJson(progressFile, {
    'telegram:-100123:12': {
      name: 'Opted-out member',
      telegramChatId: '-100123',
      telegramUserId: 12,
      telegramAnnouncementsOptIn: false
    }
  });
  writeJson(requestsFile, [{
    id: 'group-member-offer',
    text: 'Hello {{name}}, your offer is ready.',
    personalized: true,
    audience: 'group-members',
    recipients: [
      { userId: '11', name: 'No Private Bot Chat' },
      { userId: '12', name: 'Opted-out member' }
    ],
    createdAt: new Date().toISOString(),
    cancelled: false
  }]);

  const sent = [];
  const members = [
    {
      id: 11,
      firstName: 'No Private Bot Chat',
      status: new Api.UserStatusOnline({ expires: Math.floor(Date.now() / 1000) + 60 })
    },
    {
      id: 12,
      firstName: 'Opted-out member',
      status: new Api.UserStatusOffline({ wasOnline: Math.floor(Date.now() / 1000) - 60 })
    },
    { id: 99, firstName: 'Sender account' },
    { id: 13, firstName: 'Bot account', bot: true }
  ];
  const worker = new TelegramUserBroadcastWorker({
    client: {
      getDialogs: async () => [{ entity: { id: 123 } }],
      getInputEntity: async () => new Api.InputChannel({ channelId: 123, accessHash: 0 }),
      api: {
        channels: {
          getFullChannel: async ({ channel }) => {
            assert.equal(channel.className, 'InputChannel');
            return { fullChat: { onlineCount: 7 } };
          }
        }
      },
      getMe: async () => ({ id: 99 }),
      async *iterParticipants() {
        yield* members;
      },
      async sendMessage(participant, options) {
        sent.push({ userId: participant.id, ...options });
      }
    },
    progressFile,
    requestsFile,
    stateFile,
    groupId: '-100123',
    sendIntervalMs: 0,
    logger: { info() {}, error() {} }
  });

  await worker.syncGroupRoster();
  members.push({
    id: 14,
    firstName: 'New Joiner',
    status: new Api.UserStatusRecently({})
  });
  await worker.syncGroupRoster();
  await worker.processNextJob();

  assert.deepEqual(sent, [
    { userId: 11, message: 'Hello No Private Bot Chat, your offer is ready.' },
    { userId: 12, message: 'Hello Opted-out member, your offer is ready.' }
  ]);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(state.groupRoster.map(member => member.userId), ['14', '11', '12']);
  assert.equal(state.groupRoster.find(member => member.userId === '11').name, 'No Private Bot Chat');
  assert.equal(state.groupRoster.find(member => member.userId === '11').presence, 'online');
  assert.equal(state.groupRoster.find(member => member.userId === '12').presence, 'offline');
  assert.equal(state.groupRoster.find(member => member.userId === '14').presence, 'unknown');
  assert.equal(state.onlineGroupMembersCount, 7);
  assert.equal(typeof state.onlineGroupMembersUpdatedAt, 'string');
  assert.equal(state.groupRosterUpdatedAt, state.groupRosterSyncedAt);
  assert.equal(state.jobs['group-member-offer'].status, 'completed');
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
