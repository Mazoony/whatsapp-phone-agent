import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { config } from './config.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(APP_DIR, 'data');
export const TELEGRAM_USER_SESSION_FILE = path.join(DATA_DIR, 'telegram_user_session.txt');
export const TELEGRAM_USER_BROADCAST_REQUESTS_FILE = path.join(DATA_DIR, 'telegram_user_broadcasts.json');
export const TELEGRAM_USER_BROADCAST_STATE_FILE = path.join(DATA_DIR, 'telegram_user_broadcast_state.json');
const SEND_INTERVAL_MS = 3_000;
const MAX_GROUP_PARTICIPANTS = 10_000;

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

function getOptedInRecipientIds(progress, groupId) {
  return new Set(Object.values(progress || {})
    .filter(student =>
      student?.telegramAnnouncementsOptIn === true &&
      Number.isSafeInteger(student.telegramUserId) &&
      student.telegramPrivateChatId &&
      String(student.telegramChatId) === String(groupId))
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

  async getOptedInGroupParticipants(groupEntity, recipientIds) {
    const participants = new Map();
    let inspected = 0;
    for await (const participant of this.client.iterParticipants(groupEntity, {
      limit: MAX_GROUP_PARTICIPANTS
    })) {
      inspected += 1;
      const userId = getEntityId(participant);
      if (recipientIds.has(userId)) participants.set(userId, participant);
    }
    this.logger.info(`[Telegram broadcast] Checked ${inspected} group members for current opt-ins.`);
    return participants;
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
        createdAt: job.createdAt
      };
      if (!Number.isInteger(current.nextIndex) ||
          current.nextIndex < 0 ||
          current.nextIndex > job.recipients.length) {
        throw new Error(`Invalid recipient position for Telegram broadcast ${job.id}.`);
      }
      const currentProgress = this.getProgress();
      const optedInIds = getOptedInRecipientIds(currentProgress, this.groupId);
      const requestedIds = new Set(job.recipients.map(recipient => String(recipient.userId)));
      const targetIds = new Set([...optedInIds].filter(id => requestedIds.has(id)));
      const dialogs = await this.client.getDialogs({});
      const groupEntity = this.getGroupEntity(dialogs);
      const participantEntities = await this.getOptedInGroupParticipants(groupEntity, targetIds);
      let sent = current.sent || 0;
      let skipped = current.skipped || 0;
      let uncertain = current.uncertain || 0;
      let nextIndex = current.nextIndex;
      this.saveJobState(state, job.id, {
        ...current,
        status: 'running',
        total: job.recipients.length,
        sent,
        skipped,
        uncertain,
        nextIndex
      });

      while (nextIndex < job.recipients.length) {
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
        const stillOptedIn = getOptedInRecipientIds(latestProgress, this.groupId).has(userId);
        const participant = participantEntities.get(userId);
        if (!stillOptedIn || !participant) {
          skipped += 1;
          nextIndex += 1;
          this.saveJobState(latestState, job.id, {
            status: 'running',
            total: job.recipients.length,
            sent,
            skipped,
            uncertain,
            nextIndex: nextIndex + 1,
            createdAt: job.createdAt
          });
          continue;
        }

        try {
          await this.client.sendMessage(participant, { message: job.text });
          sent += 1;
          nextIndex += 1;
          this.saveJobState(latestState, job.id, {
            status: nextIndex >= job.recipients.length ? 'completed' : 'running',
            total: job.recipients.length,
            sent,
            skipped,
            uncertain,
            nextIndex,
            createdAt: job.createdAt,
            ...(nextIndex >= job.recipients.length ? { completedAt: new Date().toISOString() } : {})
          });
          if (nextIndex < job.recipients.length) {
            await new Promise(resolve => setTimeout(resolve, this.sendIntervalMs));
          }
        } catch (error) {
          uncertain += 1;
          this.saveJobState(latestState, job.id, {
            status: 'failed',
            total: job.recipients.length,
            sent,
            skipped,
            uncertain,
            nextIndex,
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
