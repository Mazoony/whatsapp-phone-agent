import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient, utils as telegramUtils } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { config } from './config.js';
import { isTelegramAnnouncementRecipient } from './telegram_announcement_recipients.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(APP_DIR, 'data');
export const TELEGRAM_USER_SESSION_FILE = path.join(DATA_DIR, 'telegram_user_session.txt');
export const TELEGRAM_USER_BROADCAST_REQUESTS_FILE = path.join(DATA_DIR, 'telegram_user_broadcasts.json');
export const TELEGRAM_USER_BROADCAST_STATE_FILE = path.join(DATA_DIR, 'telegram_user_broadcast_state.json');
const SEND_INTERVAL_MS = 10_000;
const MAX_GROUP_PARTICIPANTS = 10_000;
const GROUP_ROSTER_SYNC_INTERVAL_MS = 30_000;

function getTelegramPresenceStatus(member) {
  switch (member?.status?.className) {
    case 'UserStatusOnline':
      return 'online';
    case 'UserStatusOffline':
      return 'offline';
    default:
      return 'unknown';
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function normalizeTelegramGroupId(value) {
  const normalized = String(value ?? '');
  return normalized.startsWith('-100') ? normalized.slice(4) : normalized;
}

function getEntityId(entity) {
  const id = entity?.id ?? entity?.entity?.id;
  return id === undefined || id === null ? '' : String(id);
}

function getGroupEntityId(entity) {
  return normalizeTelegramGroupId(getEntityId(entity));
}

function getGroupMemberName(member) {
  const firstName = typeof member?.firstName === 'string' ? member.firstName.trim() : '';
  const lastName = typeof member?.lastName === 'string' ? member.lastName.trim() : '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  if (fullName) return fullName;
  const username = typeof member?.username === 'string' ? member.username.trim() : '';
  return username ? `@${username}` : `Telegram user ${getEntityId(member)}`;
}

function getOptedInRecipientIds(progress, groupId) {
  return new Set(Object.values(progress || {})
    .filter(student => isTelegramAnnouncementRecipient(student, groupId))
    .map(student => String(student.telegramUserId)));
}

export class TelegramUserBroadcastWorker {
  constructor({
    client,
    progressFile = path.join(DATA_DIR, 'telegram_progress.json'),
    requestsFile = TELEGRAM_USER_BROADCAST_REQUESTS_FILE,
    stateFile = TELEGRAM_USER_BROADCAST_STATE_FILE,
    groupId = process.env.TELEGRAM_GROUP_ID,
    sendIntervalMs = SEND_INTERVAL_MS,
    logger = console
  }) {
    if (!client || typeof client.getDialogs !== 'function' ||
        typeof client.iterParticipants !== 'function' ||
        typeof client.sendMessage !== 'function') {
      throw new Error('An authorized Telegram user client is required for account broadcasts.');
    }
    if (!groupId || !/^-100\d+$/.test(String(groupId))) {
      throw new Error('Set TELEGRAM_GROUP_ID to the configured Telegram supergroup ID.');
    }
    this.client = client;
    this.progressFile = progressFile;
    this.requestsFile = requestsFile;
    this.stateFile = stateFile;
    this.groupId = String(groupId);
    this.sendIntervalMs = sendIntervalMs;
    this.logger = logger;
    this.processing = false;
    this.lastGroupRosterSyncAttemptAt = 0;
    this.accountUserId = null;
    this.accountUserIdLoaded = false;
  }

  getProgress() {
    const progress = readJsonFile(this.progressFile, {});
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
      throw new Error(`Invalid Telegram student progress in ${this.progressFile}.`);
    }
    return progress;
  }

  getQueue() {
    const requests = readJsonFile(this.requestsFile, []);
    if (!Array.isArray(requests)) {
      throw new Error(`Invalid Telegram user broadcast queue in ${this.requestsFile}.`);
    }
    return requests;
  }

  getState() {
    const state = readJsonFile(this.stateFile, { jobs: {} });
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        !state.jobs || typeof state.jobs !== 'object' || Array.isArray(state.jobs)) {
      throw new Error(`Invalid Telegram user broadcast state in ${this.stateFile}.`);
    }
    return state;
  }

  getGroupEntity(dialogs) {
    const dialog = dialogs.find(item =>
      getGroupEntityId(item?.entity || item) === normalizeTelegramGroupId(this.groupId));
    if (!dialog) {
      throw new Error('The Telegram account could not find the configured group in its dialogs.');
    }
    return dialog.entity || dialog;
  }

  async getGroupParticipants(groupEntity, recipientIds = null) {
    if (!this.accountUserIdLoaded) {
      if (typeof this.client.getMe === 'function') {
        this.accountUserId = getEntityId(await this.client.getMe());
      }
      this.accountUserIdLoaded = true;
    }
    const participants = new Map();
    let inspected = 0;
    for await (const participant of this.client.iterParticipants(groupEntity, {
      limit: MAX_GROUP_PARTICIPANTS,
      showTotal: false
    })) {
      inspected += 1;
      const userId = getEntityId(participant);
      if ((!recipientIds || recipientIds.has(userId)) &&
          userId !== this.accountUserId &&
          participant?.bot !== true) {
        participants.set(userId, participant);
      }
    }
    this.logger.info(`[Telegram broadcast] Checked ${inspected} current group members.`);
    return participants;
  }

  async syncGroupRoster() {
    this.lastGroupRosterSyncAttemptAt = Date.now();
    const dialogs = await this.client.getDialogs({});
    const groupEntity = this.getGroupEntity(dialogs);
    const participants = await this.getGroupParticipants(groupEntity);
    let onlineGroupMembersCount = null;
    if (typeof this.client.getInputEntity === 'function' &&
        typeof this.client.api?.channels?.getFullChannel === 'function') {
      try {
        const channel = telegramUtils.getInputChannel(
          await this.client.getInputEntity(groupEntity)
        );
        const fullChannel = await this.client.api.channels.getFullChannel({ channel });
        if (Number.isInteger(fullChannel?.fullChat?.onlineCount) &&
            fullChannel.fullChat.onlineCount >= 0) {
          onlineGroupMembersCount = fullChannel.fullChat.onlineCount;
        }
      } catch (error) {
        this.logger.error(
          `[Telegram broadcast] Could not fetch the group's online member count: ${error.message}`
        );
      }
    }
    const groupRoster = [...participants.entries()]
      .map(([userId, member]) => ({
        userId,
        name: getGroupMemberName(member),
        presence: getTelegramPresenceStatus(member),
        ...(typeof member.username === 'string' && member.username.trim()
          ? { username: member.username.trim() }
          : {})
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.userId.localeCompare(right.userId));
    const state = this.getState();
    const previousRoster = Array.isArray(state.groupRoster) ? state.groupRoster : [];
    const rosterChanged = JSON.stringify(previousRoster) !== JSON.stringify(groupRoster);
    const now = new Date().toISOString();
    writeJsonFile(this.stateFile, {
      ...state,
      groupRoster,
      onlineGroupMembersCount,
      onlineGroupMembersUpdatedAt: onlineGroupMembersCount === null ? null : now,
      groupRosterSyncedAt: now,
      ...(rosterChanged ? { groupRosterUpdatedAt: now } : {})
    });
    return groupRoster;
  }

  saveJobState(state, jobId, jobState) {
    writeJsonFile(this.stateFile, {
      ...state,
      jobs: { ...state.jobs, [jobId]: jobState }
    });
  }

  async processNextJob() {
    if (this.processing) return false;
    this.processing = true;
    try {
      const requests = this.getQueue();
      const state = this.getState();
      const job = requests.find(request => {
        const status = state.jobs[request.id]?.status;
        return !request.cancelled && (!status || ['queued', 'running'].includes(status));
      });
      if (!job) return false;
      if (!Array.isArray(job.recipients) || !job.recipients.length ||
          typeof job.text !== 'string' || !job.text.trim()) {
        this.saveJobState(state, job.id, {
          status: 'failed',
          total: Array.isArray(job.recipients) ? job.recipients.length : 0,
          sent: 0,
          skipped: 0,
          uncertain: 0,
          nextIndex: 0,
          error: 'Broadcast request has invalid content or recipients.',
          createdAt: job.createdAt,
          completedAt: new Date().toISOString()
        });
        return true;
      }

      const current = state.jobs[job.id] || {
        status: 'queued',
        total: job.recipients.length,
        sent: 0,
        skipped: 0,
        uncertain: 0,
        nextIndex: 0,
        recipientResults: [],
        createdAt: job.createdAt
      };
      if (!Number.isInteger(current.nextIndex) ||
          current.nextIndex < 0 ||
          current.nextIndex > job.recipients.length) {
        throw new Error(`Invalid recipient position for Telegram broadcast ${job.id}.`);
      }
      const currentProgress = this.getProgress();
      const requestedIds = new Set(job.recipients.map(recipient => String(recipient.userId)));
      const targetIds = job.audience === 'group-members'
        ? requestedIds
        : new Set([...getOptedInRecipientIds(currentProgress, this.groupId)]
          .filter(id => requestedIds.has(id)));
      const dialogs = await this.client.getDialogs({});
      const groupEntity = this.getGroupEntity(dialogs);
      const participantEntities = await this.getGroupParticipants(groupEntity, targetIds);
      let sent = current.sent || 0;
      let skipped = current.skipped || 0;
      let uncertain = current.uncertain || 0;
      let nextIndex = current.nextIndex;
      const recipientResults = Array.isArray(current.recipientResults)
        ? [...current.recipientResults]
        : [];
      const recordRecipientResult = result => {
        const existingIndex = recipientResults.findIndex(item => item.index === result.index);
        if (existingIndex >= 0) recipientResults[existingIndex] = result;
        else recipientResults.push(result);
        recipientResults.sort((left, right) => left.index - right.index);
      };
      this.saveJobState(state, job.id, {
        ...current,
        status: 'running',
        total: job.recipients.length,
        sent,
        skipped,
        uncertain,
        nextIndex,
        recipientResults
      });

      while (nextIndex < job.recipients.length) {
        if (Date.now() - this.lastGroupRosterSyncAttemptAt >= GROUP_ROSTER_SYNC_INTERVAL_MS) {
          await this.syncGroupRoster();
        }
        const queued = this.getQueue().find(item => item.id === job.id);
        const latestState = this.getState();
        if (queued?.cancelled || latestState.jobs[job.id]?.status === 'cancellation_requested') {
          this.saveJobState(latestState, job.id, {
            ...latestState.jobs[job.id],
            status: 'cancelled',
            sent,
            skipped,
            uncertain,
            nextIndex,
            completedAt: new Date().toISOString()
          });
          return true;
        }

        const recipient = job.recipients[nextIndex];
        const userId = String(recipient.userId);
        const latestProgress = this.getProgress();
        const knownStudent = Object.values(latestProgress).find(student =>
          String(student.telegramUserId) === userId &&
          String(student.telegramChatId) === this.groupId);
        const currentStudent = knownStudent &&
          (job.audience === 'group-members' ||
            isTelegramAnnouncementRecipient(knownStudent, this.groupId))
          ? knownStudent
          : null;
        const participant = participantEntities.get(userId);
        const recipientName = knownStudent?.name || knownStudent?.telegramUsername ||
          recipient.name || (participant ? getGroupMemberName(participant) : `Telegram user ${userId}`);
        if ((job.audience !== 'group-members' && !currentStudent) || !participant) {
          const reason = !participant
            ? 'No longer a current group member.'
            : 'No longer eligible for private announcements.';
          skipped += 1;
          recordRecipientResult({
            index: nextIndex,
            userId,
            name: recipientName,
            status: 'skipped',
            reason
          });
          nextIndex += 1;
          const stateBeforeSave = this.getState();
          this.saveJobState(stateBeforeSave, job.id, {
            ...stateBeforeSave.jobs[job.id],
            status: 'running',
            total: job.recipients.length,
            sent,
            skipped,
            uncertain,
            nextIndex,
            recipientResults: [...recipientResults],
            createdAt: job.createdAt
          });
          continue;
        }

        try {
          const message = job.personalized === true
            ? job.text.replaceAll('{{name}}', recipientName)
            : job.text;
          await this.client.sendMessage(participant, { message });
          sent += 1;
          recordRecipientResult({
            index: nextIndex,
            userId,
            name: recipientName,
            status: 'sent'
          });
          nextIndex += 1;
          const stateBeforeSave = this.getState();
          const latestJobState = stateBeforeSave.jobs[job.id] || {};
          this.saveJobState(stateBeforeSave, job.id, {
            ...latestJobState,
            status: nextIndex >= job.recipients.length
              ? 'completed'
              : latestJobState.status === 'cancellation_requested'
                ? 'cancellation_requested'
                : 'running',
            total: job.recipients.length,
            sent,
            skipped,
            uncertain,
            nextIndex,
            recipientResults: [...recipientResults],
            createdAt: job.createdAt,
            ...(nextIndex >= job.recipients.length ? { completedAt: new Date().toISOString() } : {})
          });
          if (nextIndex < job.recipients.length) {
            await new Promise(resolve => setTimeout(resolve, this.sendIntervalMs));
          }
        } catch (error) {
          uncertain += 1;
          recordRecipientResult({
            index: nextIndex,
            userId,
            name: recipientName,
            status: 'uncertain',
            reason: error.message
          });
          const stateBeforeSave = this.getState();
          this.saveJobState(stateBeforeSave, job.id, {
            ...stateBeforeSave.jobs[job.id],
            status: 'failed',
            total: job.recipients.length,
            sent,
            skipped,
            uncertain,
            nextIndex,
            recipientResults: [...recipientResults],
            error: error.message,
            createdAt: job.createdAt,
            completedAt: new Date().toISOString()
          });
          this.logger.error(
            `[Telegram broadcast] Stopped job ${job.id} after a send error; the current recipient may have received the message.`
          );
          return true;
        }
      }
      if (nextIndex >= job.recipients.length) {
        this.saveJobState(this.getState(), job.id, {
          status: 'completed',
          total: job.recipients.length,
          sent,
          skipped,
          uncertain,
          nextIndex,
          recipientResults: [...recipientResults],
          createdAt: job.createdAt,
          completedAt: new Date().toISOString()
        });
      }
      return true;
    } finally {
      this.processing = false;
    }
  }

  async run({ intervalMs = 2_000, signal } = {}) {
    let lastHeartbeatAt = 0;
    const writeWorkerStatus = (connected, error = null, force = false) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < 10_000) return;
    const state = this.getState();
    writeJsonFile(this.stateFile, {
      ...state,
      worker: {
        connected,
        lastHeartbeatAt: new Date(now).toISOString(),
        error
      }
    });
    lastHeartbeatAt = now;
    };
    writeWorkerStatus(true, null, true);
    try {
    while (!signal?.aborted) {
      try {
        if (Date.now() - this.lastGroupRosterSyncAttemptAt >= GROUP_ROSTER_SYNC_INTERVAL_MS) {
          await this.syncGroupRoster();
        }
        await this.processNextJob();
        writeWorkerStatus(true, null);
      } catch (error) {
        this.logger.error(`[Telegram broadcast] Could not process the queue: ${error.message}`);
        writeWorkerStatus(true, error.message);
      }
      if (!signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    } finally {
    writeWorkerStatus(false, null, true);
    }
  }
}

async function authorizeTelegramAccount({ sessionFile = TELEGRAM_USER_SESSION_FILE } = {}) {
  const apiId = Number(process.env.TELEGRAM_CLIENT_API_ID);
  const apiHash = process.env.TELEGRAM_CLIENT_API_HASH?.trim();
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error('Set TELEGRAM_CLIENT_API_ID and TELEGRAM_CLIENT_API_HASH in .env before starting account broadcasts.');
  }
  const savedSession = fs.existsSync(sessionFile)
    ? fs.readFileSync(sessionFile, 'utf8').trim()
    : '';
  const client = new TelegramClient(new StringSession(savedSession), apiId, apiHash, {
    connectionRetries: 5
  });
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await client.start({
      phoneNumber: () => rl.question('Telegram account phone number: '),
      password: () => rl.question('Telegram two-step verification password: '),
      phoneCode: () => rl.question('Telegram login code: '),
      onError: error => console.error(`[Telegram account login] ${error.message}`)
    });
  } finally {
    rl.close();
  }
  const session = client.session.save();
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${session}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log('[Telegram broadcast] Account authorized; session saved locally in the ignored data directory.');
  return client;
}

export async function startTelegramUserBroadcastWorker({
  workerOptions = {},
  authorize = authorizeTelegramAccount,
  signal
} = {}) {
  const client = await authorize();
  const worker = new TelegramUserBroadcastWorker({ client, ...workerOptions });
  await worker.run({ signal });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  startTelegramUserBroadcastWorker({ signal: controller.signal }).catch(error => {
    console.error(`[Telegram broadcast] Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
