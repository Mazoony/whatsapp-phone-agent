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

function writeQueuedJobState(filePath, jobId, total) {
  writeJson(filePath, {
    jobs: {
      [jobId]: {
        status: 'queued',
        total,
        sent: 0,
        skipped: 0,
        uncertain: 0,
        nextIndex: 0,
        recipientResults: []
      }
    }
  });
}

test('Telegram user broadcasts wait ten seconds between messages by default', () => {
  const worker = new TelegramUserBroadcastWorker({
    client: {
      getDialogs: async () => [],
      async *iterParticipants() {},
      sendMessage: async () => {}
    },
    groupId: '-100123',
    logger: { info() {}, error() {} }
  });

  assert.equal(worker.sendIntervalMs, 10_000);
});

test('Telegram account worker runs dashboard-requested presence syncs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-presence-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const progressFile = path.join(directory, 'progress.json');
  const requestsFile = path.join(directory, 'requests.json');
  const stateFile = path.join(directory, 'state.json');
  writeJson(progressFile, {});
  writeJson(requestsFile, []);
  writeJson(stateFile, { jobs: {} });

  let syncCount = 0;
  const worker = new TelegramUserBroadcastWorker({
    client: {
      async getDialogs() {
        syncCount += 1;
        return [{ entity: { id: 123 } }];
      },
      async *iterParticipants() {},
      async sendMessage() {}
    },
    progressFile,
    requestsFile,
    stateFile,
    groupId: '-100123',
    logger: { info() {}, error() {} }
  });
  const controller = new AbortController();
  const running = worker.run({ intervalMs: 5, signal: controller.signal });
  const waitForSyncCount = async count => {
    const deadline = Date.now() + 1_000;
    while (syncCount < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(syncCount >= count, `expected at least ${count} syncs; received ${syncCount}`);
  };

  try {
    await waitForSyncCount(1);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    writeJson(stateFile, {
      ...state,
      groupRosterSyncRequestId: 'dashboard-retry',
      groupRosterSyncRequestedAt: new Date().toISOString()
    });
    await waitForSyncCount(2);
  } finally {
    controller.abort();
    await running;
  }
  assert.equal(syncCount, 2);
});

test('Telegram user broadcasts resume after the server-requested flood wait', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-user-broadcast-flood-wait-'));
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
    id: 'flood-wait-job',
    text: 'Announcement',
    recipients: [{ userId: '11' }],
    createdAt: new Date().toISOString(),
    cancelled: false
  }]);
  writeQueuedJobState(stateFile, 'flood-wait-job', 1);

  let now = 1_000_000;
  let sendAttempts = 0;
  const worker = new TelegramUserBroadcastWorker({
    client: {
      getDialogs: async () => [{ entity: { id: 123 } }],
      async *iterParticipants() {
        yield { id: 11 };
      },
      async sendMessage() {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          const error = new Error('Please wait 3 seconds before repeating the action.');
          error.seconds = 3;
          throw error;
        }
      }
    },
    progressFile,
    requestsFile,
    stateFile,
    groupId: '-100123',
    sendIntervalMs: 0,
    now: () => now,
    logger: { info() {}, warn() {}, error() {} }
  });

  await worker.processNextJob();
  let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.jobs['flood-wait-job'].status, 'waiting');
  assert.equal(state.jobs['flood-wait-job'].retryAt, new Date(now + 3_000).toISOString());
  assert.equal(state.jobs['flood-wait-job'].nextIndex, 0);
  assert.equal(state.jobs['flood-wait-job'].uncertain, 0);
  assert.equal(await worker.processNextJob(), false);
  assert.equal(sendAttempts, 1);

  now += 3_000;
  await worker.processNextJob();
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.jobs['flood-wait-job'].status, 'completed');
  assert.equal(state.jobs['flood-wait-job'].sent, 1);
  assert.equal(state.jobs['flood-wait-job'].uncertain, 0);
  assert.equal(sendAttempts, 2);
});

test('Telegram user broadcasts do not automatically send untracked legacy requests', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-user-broadcast-legacy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requestsFile = path.join(directory, 'requests.json');
  writeJson(requestsFile, [{
    id: 'legacy-job',
    text: 'Old announcement',
    recipients: [{ userId: '11' }],
    createdAt: '2026-11-01T00:00:00.000Z',
    cancelled: false
  }]);
  let sendAttempts = 0;
  const worker = new TelegramUserBroadcastWorker({
    client: {
      getDialogs: async () => [{ entity: { id: 123 } }],
      async *iterParticipants() {
        yield { id: 11 };
      },
      async sendMessage() {
        sendAttempts += 1;
      }
    },
    requestsFile,
    stateFile: path.join(directory, 'state.json'),
    groupId: '-100123',
    logger: { info() {}, error() {} }
  });

  assert.equal(await worker.processNextJob(), false);
  assert.equal(sendAttempts, 0);
});

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
  writeQueuedJobState(stateFile, 'job-1', 4);

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
  assert.deepEqual(state.jobs['job-1'].recipientResults, [
    { index: 0, userId: '11', name: 'Telegram user 11', status: 'sent' },
    {
      index: 1,
      userId: '12',
      name: 'Telegram user 12',
      status: 'skipped',
      reason: 'No longer eligible for private announcements.'
    },
    {
      index: 2,
      userId: '13',
      name: 'Telegram user 13',
      status: 'skipped',
      reason: 'No longer a current group member.'
    },
    { index: 3, userId: '14', name: 'Telegram user 14', status: 'sent' }
  ]);
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
  writeQueuedJobState(stateFile, 'personalized-job', 1);

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
  writeQueuedJobState(stateFile, 'group-member-offer', 2);

  const sent = [];
  const members = [
    {
      id: 11,
      firstName: 'No Private Bot Chat',
      participant: { date: Math.floor(Date.parse('2026-10-10T12:00:00.000Z') / 1000) },
      status: new Api.UserStatusOnline({ expires: Math.floor(Date.now() / 1000) + 60 })
    },
    {
      id: 12,
      firstName: 'Opted-out member',
      participant: { date: Math.floor(Date.parse('2026-10-11T12:00:00.000Z') / 1000) },
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
  assert.equal(
    state.groupRoster.find(member => member.userId === '11').joinedAt,
    '2026-10-10T12:00:00.000Z'
  );
  assert.equal(
    state.groupRoster.find(member => member.userId === '14').joinedAt,
    null
  );
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
  writeQueuedJobState(stateFile, 'job-error', 1);

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
  assert.deepEqual(state.jobs['job-error'].recipientResults, [{
    index: 0,
    userId: '11',
    name: 'Telegram user 11',
    status: 'uncertain',
    reason: 'Telegram send failed'
  }]);
});
