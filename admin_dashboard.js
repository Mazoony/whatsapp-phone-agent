import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPhoneJid } from './phonebook.js';
import { config } from './config.js';
import {
  AGENT_QR_FILE,
  AGENT_STATUS_FILE,
  readAgentQr,
  renderAgentQrSvg
} from './agent_status.js';
import { AGENT_LOG_FILE, readRecentAgentLogs } from './agent_runtime.js';
import {
  getEligibleBroadcastContacts,
  listEligibleBroadcastContacts,
  validateBroadcastRequest
} from './broadcast_utils.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(ROOT_DIR, 'data', 'chat_history.json');
const CONTACTS_FILE = path.join(ROOT_DIR, 'data', 'contacts.json');
const PROGRESS_FILE = path.join(ROOT_DIR, 'data', 'student_progress.json');
const LESSONS_FILE = path.join(ROOT_DIR, 'lessons.json');
const FOLLOWUP_STATE_FILE = path.join(ROOT_DIR, 'data', 'followup_state.json');
const BROADCAST_REQUESTS_FILE = path.join(ROOT_DIR, 'data', 'broadcast_requests.json');
const BROADCAST_STATE_FILE = path.join(ROOT_DIR, 'data', 'broadcast_state.json');
const MESSAGE_REQUESTS_FILE = path.join(ROOT_DIR, 'data', 'message_requests.json');
const AGENT_HEARTBEAT_MAX_AGE_MS = 30_000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 120;
const MAX_CONVERSATION_MESSAGES = 100;
const DEFAULT_CONTACT_PAGE_SIZE = 50;
const ACTIVITY_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonFileOr(filePath, fallback) {
  return fs.existsSync(filePath) ? readJsonFile(filePath) : fallback;
}

function writeJsonFile(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

export function readDashboardData() {
  return {
    history: readJsonFile(HISTORY_FILE),
    contacts: readJsonFile(CONTACTS_FILE),
    progress: readJsonFile(PROGRESS_FILE),
    lessons: readJsonFile(LESSONS_FILE),
    optedOutJids: readJsonFileOr(FOLLOWUP_STATE_FILE, { optedOutJids: [] }).optedOutJids || []
  };
}

function isDirectChat(jid) {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function timestampMs(timestamp) {
  const value = Number(timestamp) || 0;
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function latestMessage(messages = []) {
  return messages.reduce((latest, message) =>
    timestampMs(message.timestamp) > timestampMs(latest?.timestamp) ? message : latest, null);
}

function displayName(contact, jid) {
  return contact?.name || jid.split('@')[0];
}

function validateDashboardMessage(data, jid, text) {
  if (typeof jid !== 'string' || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)) {
    throw new Error('Select a valid direct chat.');
  }
  if (!Array.isArray(data.history[jid]) || data.history[jid].length === 0) {
    throw new Error('This chat is no longer available. Refresh the dashboard and select it again.');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new Error('Message must be between 1 and 4,000 characters.');
  }

  const phoneJid = getPhoneJid(jid, data.contacts[jid]?.jid);
  if (!phoneJid) {
    throw new Error("Cannot verify this chat's phone number for messaging.");
  }
  const phoneNumber = phoneJid.slice(0, -'@s.whatsapp.net'.length).split(':')[0];
  if (!config.shouldReplyTo(phoneNumber)) {
    throw new Error('This number is blocked or is not allowed by the configured number rules.');
  }

  const optedOutJids = new Set(data.optedOutJids || []);
  const aliases = Object.entries(data.contacts)
    .filter(([contactJid, contact]) =>
      contactJid === jid ||
      getPhoneJid(contactJid, contact.jid) === phoneJid);
  if (aliases.some(([, contact]) => contact.ownerBlocked)) {
    throw new Error('This contact is blocked by the owner and cannot be messaged.');
  }
  if (optedOutJids.has(jid) || optedOutJids.has(phoneJid) ||
      aliases.some(([alias]) => optedOutJids.has(alias))) {
    throw new Error('This contact opted out and cannot be messaged.');
  }

  return { jid, text: text.trim(), phoneNumber };
}

async function handleDirectMessagePost(req, res, readData, messageRequestsFile) {
  if (!isSameOriginLoopbackRequest(req)) {
    sendJson(res, 403, { error: 'Messages can only be sent from this local dashboard.' });
    return;
  }

  try {
    const body = await readRequestBody(req);
    const data = readData();
    const message = validateDashboardMessage(data, body.jid, body.text);
    const requests = readJsonFileOr(messageRequestsFile, []);
    if (!Array.isArray(requests)) throw new Error('Invalid direct message queue.');

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const request = { id, ...message, createdAt: new Date().toISOString() };
    requests.push(request);
    fs.mkdirSync(path.dirname(messageRequestsFile), { recursive: true });
    writeJsonFile(messageRequestsFile, requests);
    sendJson(res, 202, { id, status: 'queued', createdAt: request.createdAt });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function lessonForStudent(student, lessons) {
  return lessons[student.grade]?.lessons?.[student.currentLessonIndex] || null;
}

export function listDashboardEsContacts(data, search = '', offset = 0, limit = DEFAULT_CONTACT_PAGE_SIZE) {
  const normalizedSearch = search.trim().toLocaleLowerCase().slice(0, MAX_SEARCH_LENGTH);
  const contactsByPhone = new Map();
  const messageEligibleJids = new Set(
    getEligibleBroadcastContacts(data, data.optedOutJids || []).map(contact => contact.jid)
  );

  for (const [jid, contact] of Object.entries(data.contacts)) {
    if (!contact.isEs || contact.savedInAddressBook !== true) continue;

    const phoneJid = getPhoneJid(jid, contact.jid);
    if (!phoneJid) continue;

    const phoneNumber = phoneJid.slice(0, -'@s.whatsapp.net'.length).split(':')[0];
    const name = displayName(contact, phoneJid);
    if (normalizedSearch &&
        !name.toLocaleLowerCase().includes(normalizedSearch) &&
        !phoneNumber.includes(normalizedSearch)) continue;

    if (!contactsByPhone.has(phoneNumber)) {
      contactsByPhone.set(phoneNumber, {
        jid: `${phoneNumber}@s.whatsapp.net`,
        name,
        phoneNumber
      });
    }
  }

  const contacts = [...contactsByPhone.values()]
    .map(contact => ({ ...contact, canMessage: messageEligibleJids.has(contact.jid) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));

  return {
    total: contacts.length,
    offset: safeOffset,
    limit: safeLimit,
    contacts: contacts.slice(safeOffset, safeOffset + safeLimit)
  };
}

export function getDashboardOverview(data, now = Date.now()) {
  const directChats = Object.entries(data.history)
    .filter(([jid, messages]) => isDirectChat(jid) && messages.length > 0);
  const handledChats = directChats.filter(([, messages]) =>
    messages.some(message => message.role === 'agent')).length;
  const recentWindow = now - 24 * 60 * 60 * 1000;
  const activeToday = directChats.filter(([, messages]) =>
    timestampMs(latestMessage(messages)?.timestamp) >= recentWindow).length;
  const progressRecords = Object.values(data.progress);
  const configuredLessonCount = Object.values(data.lessons)
    .reduce((total, grade) => total + (grade.lessons?.length || 0), 0);
  const esContactCount = listDashboardEsContacts(data).total;

  return {
    totalChats: directChats.length,
    activeToday,
    handledChats,
    esContacts: esContactCount,
    studentsWithProgress: progressRecords.length,
    awaitingTask: progressRecords.filter(student => student.status === 'awaiting_task').length,
    awaitingReattempt: progressRecords.filter(student => student.status === 'awaiting_reattempt').length,
    completed: progressRecords.filter(student => student.status === 'completed').length,
    configuredLessons: configuredLessonCount
  };
}

export function getDashboardAgentStatus(status, handledChats, now = Date.now()) {
  const updatedAt = Date.parse(status?.updatedAt || '');
  const heartbeatAge = now - updatedAt;
  const hasFreshHeartbeat = Number.isFinite(updatedAt) &&
    heartbeatAge >= 0 &&
    heartbeatAge <= AGENT_HEARTBEAT_MAX_AGE_MS;
  const connectionState = !hasFreshHeartbeat
    ? status?.connectionState ? 'disconnected' : 'unknown'
    : status.connectionState === 'connected'
      ? 'connected'
      : status.connectionState === 'connecting' || status.connectionState === 'starting'
        ? 'connecting'
        : 'disconnected';

  return {
    connectionState,
    connected: connectionState === 'connected',
    lastConnectedAt: status?.lastConnectedAt || null,
    lastHeartbeatAt: Number.isFinite(updatedAt) ? status.updatedAt : null,
    account: status?.account && typeof status.account === 'object'
      ? {
        name: typeof status.account.name === 'string' ? status.account.name : '',
        phoneNumber: typeof status.account.phoneNumber === 'string' &&
          /^\d+$/.test(status.account.phoneNumber) ? status.account.phoneNumber : null
      }
      : null,
    handledChats
  };
}

export function listDashboardChats(
  data,
  search = '',
  offset = 0,
  limit = DEFAULT_PAGE_SIZE,
  { activeSince = null, handledOnly = false } = {}
) {
  const normalizedSearch = search.trim().toLocaleLowerCase().slice(0, MAX_SEARCH_LENGTH);
  const chats = [];

  for (const [jid, messages] of Object.entries(data.history)) {
    if (!isDirectChat(jid) || !messages.length) continue;

    const contact = data.contacts[jid];
    const name = displayName(contact, jid);
    const latest = latestMessage(messages);
    const latestAgentMessage = latestMessage(messages.filter(message => message.role === 'agent'));
    const lastActivity = timestampMs(latest?.timestamp);
    if (activeSince !== null && lastActivity < activeSince) continue;
    if (handledOnly && !latestAgentMessage) continue;
    const matchesSearch = !normalizedSearch ||
      name.toLocaleLowerCase().includes(normalizedSearch) ||
      jid.split('@')[0].includes(normalizedSearch) ||
      messages.some(message => message.text?.toLocaleLowerCase().includes(normalizedSearch));

    if (!matchesSearch) continue;

    const student = data.progress[jid] || null;
    const lesson = student ? lessonForStudent(student, data.lessons) : null;
    chats.push({
      jid,
      name,
      lastMessage: latest?.text || '',
      lastMessageRole: latest?.role || '',
      lastActivity,
      lastHandledAt: latestAgentMessage ? timestampMs(latestAgentMessage.timestamp) : null,
      isEs: Boolean(contact?.isEs),
      progress: student ? {
        gradeName: data.lessons[student.grade]?.name || student.grade,
        status: student.status,
        lessonTitle: lesson?.title || student.currentLessonId || ''
      } : null
    });
  }

  chats.sort((left, right) => handledOnly
    ? right.lastHandledAt - left.lastHandledAt
    : right.lastActivity - left.lastActivity);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));

  return {
    total: chats.length,
    offset: safeOffset,
    limit: safeLimit,
    chats: chats.slice(safeOffset, safeOffset + safeLimit)
  };
}

export function getDashboardConversation(data, jid) {
  if (!jid || !isDirectChat(jid)) return null;
  const messages = data.history[jid];
  if (!messages) return null;

  const contact = data.contacts[jid];
  const student = data.progress[jid] || null;
  const lesson = student ? lessonForStudent(student, data.lessons) : null;
  const recentMessages = messages.slice(-MAX_CONVERSATION_MESSAGES);

  return {
    jid,
    name: displayName(contact, jid),
    isEs: Boolean(contact?.isEs),
    progress: student ? {
      gradeName: data.lessons[student.grade]?.name || student.grade,
      status: student.status,
      lessonTitle: lesson?.title || student.currentLessonId || '',
      deliveredAt: student.deliveredAt || null
    } : null,
    totalMessages: messages.length,
    messages: recentMessages.map(message => ({
      role: message.role,
      text: message.text,
      timestamp: timestampMs(message.timestamp)
    }))
  };
}

export function getDashboardStudentActivity(data, jid, days, timeZone, now = Date.now()) {
  if (!jid || !isDirectChat(jid)) return null;
  if (![30, 90].includes(days)) throw new Error('Activity range must be 30 or 90 days.');
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 100) {
    throw new Error('A valid timezone is required.');
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    });
  } catch {
    throw new Error('The requested timezone is invalid.');
  }

  const phoneJid = getPhoneJid(jid, data.contacts[jid]?.jid);
  const aliases = Object.entries(data.contacts).filter(([contactJid, contact]) =>
    contactJid === jid ||
    (phoneJid && getPhoneJid(contactJid, contact.jid) === phoneJid));
  const historyJid = [jid, ...aliases.map(([contactJid]) => contactJid),
    ...Object.keys(data.history).filter(historyId =>
      phoneJid && getPhoneJid(historyId, data.contacts[historyId]?.jid) === phoneJid)]
    .find(candidate => Array.isArray(data.history[candidate]));
  const messages = historyJid ? data.history[historyJid] : null;
  if (!messages && aliases.length === 0) return null;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const counts = ACTIVITY_WEEKDAYS.map(day => ({ day, hours: Array(24).fill(0) }));
  const hourlyTotals = Array(24).fill(0);
  const activeDates = new Set();
  let totalMessages = 0;

  for (const message of messages || []) {
    if (message.role !== 'client') continue;
    const timestamp = timestampMs(message.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now) continue;

    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value])
    );
    const weekday = ACTIVITY_WEEKDAYS.indexOf(parts.weekday);
    const hour = Number(parts.hour);
    if (weekday < 0 || hour < 0 || hour > 23) continue;

    counts[weekday].hours[hour] += 1;
    hourlyTotals[hour] += 1;
    activeDates.add(`${parts.year}-${parts.month}-${parts.day}`);
    totalMessages += 1;
  }

  return {
    jid,
    days,
    timeZone,
    totalMessages,
    activeDays: activeDates.size,
    hourlyTotals,
    weekdays: counts
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function isSameOriginLoopbackRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.protocol === 'http:' &&
      parsedOrigin.host === host &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

function readRequestBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        body = '';
        tooLarge = true;
        return;
      }
      if (!tooLarge) body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body is too large.'));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must contain valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleBroadcastPost(req, res, readData, broadcastFiles) {
  if (!isSameOriginLoopbackRequest(req)) {
    sendJson(res, 403, { error: 'Broadcast actions are only accepted from this local dashboard.' });
    return;
  }

  try {
    const body = await readRequestBody(req);
    const requests = readJsonFileOr(broadcastFiles.requests, []);
    if (!Array.isArray(requests)) throw new Error('Invalid broadcast request queue.');

    if (body.action === 'cancel') {
      const job = requests.find(request => request.id === body.id);
      if (!job) {
        sendJson(res, 404, { error: 'Broadcast job not found.' });
        return;
      }
      const state = readJsonFileOr(broadcastFiles.state, { jobs: {} });
      const jobState = state.jobs?.[job.id];
      if (jobState && !['queued', 'running'].includes(jobState.status)) {
        sendJson(res, 409, { error: 'This broadcast can no longer be cancelled.' });
        return;
      }
      if (!jobState) {
        fs.mkdirSync(path.dirname(broadcastFiles.state), { recursive: true });
        writeJsonFile(broadcastFiles.state, {
          ...state,
          jobs: {
            ...state.jobs,
            [job.id]: {
              status: 'cancelled',
              total: job.jids.length,
              sent: 0,
              skipped: 0,
              uncertain: 0,
              nextIndex: 0,
              createdAt: job.createdAt,
              completedAt: new Date().toISOString()
            }
          }
        });
      }
      job.cancelled = true;
      writeJsonFile(broadcastFiles.requests, requests);
      sendJson(res, 200, { id: job.id, status: 'cancellation_requested' });
      return;
    }

    const data = readData();
    const eligibleJids = new Set(
      getEligibleBroadcastContacts(data, data.optedOutJids || []).map(contact => contact.jid)
    );
    const requestedJids = Array.isArray(body.jids) ? body.jids : [];
    const uniqueJids = [...new Set(requestedJids)];
    if (uniqueJids.length !== requestedJids.length) {
      throw new Error('The selected recipient list contains duplicates. Refresh and select contacts again.');
    }
    const selectedJids = uniqueJids;
    if (selectedJids.some(jid => !eligibleJids.has(jid))) {
      throw new Error('Some selected contacts are no longer eligible. Refresh and select contacts again.');
    }
    const validRequest = validateBroadcastRequest({ text: body.text, jids: selectedJids });

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const job = {
      id,
      text: validRequest.text,
      jids: validRequest.jids,
      createdAt: new Date().toISOString(),
      cancelled: false
    };
    requests.push(job);
    fs.mkdirSync(path.dirname(broadcastFiles.requests), { recursive: true });
    writeJsonFile(broadcastFiles.requests, requests);
    sendJson(res, 202, { id, status: 'queued', total: job.jids.length, createdAt: job.createdAt });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

export function createAdminDashboardServer({
  readData = readDashboardData,
  broadcastFiles = {
    requests: BROADCAST_REQUESTS_FILE,
    state: BROADCAST_STATE_FILE
  },
  messageRequestsFile = MESSAGE_REQUESTS_FILE,
  agentStatusFile = AGENT_STATUS_FILE,
  agentQrFile = AGENT_QR_FILE,
  agentLogFile = AGENT_LOG_FILE
} = {}) {
  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/admin')) {
      const htmlPath = path.join(ROOT_DIR, 'public', 'admin.html');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/broadcasts') {
      handleBroadcastPost(req, res, readData, broadcastFiles);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/admin/messages') {
      handleDirectMessagePost(req, res, readData, messageRequestsFile);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/messages') {
      try {
        const jid = requestUrl.searchParams.get('jid');
        const requests = readJsonFileOr(messageRequestsFile, []);
        const state = readJsonFileOr(broadcastFiles.state, { jobs: {} });
        const messages = requests.filter(request => request.jid === jid).slice(-10).reverse()
          .map(request => ({
            id: request.id,
            status: state.jobs?.[request.id]?.status || 'queued',
            createdAt: request.createdAt
          }));
        sendJson(res, 200, { messages });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load direct message status:', error.message);
        sendJson(res, 500, { error: 'Could not read direct message status.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/broadcasts') {
      try {
        const requests = readJsonFileOr(broadcastFiles.requests, []);
        const state = readJsonFileOr(broadcastFiles.state, { jobs: {} });
        const jobs = requests.slice(-20).reverse().map(request => {
          const jobState = state.jobs?.[request.id] || {
            status: request.cancelled ? 'cancelled' : 'queued',
            total: request.jids.length,
            sent: 0,
            skipped: 0,
            uncertain: 0
          };
          return {
            id: request.id,
            status: request.cancelled && jobState.status === 'running'
              ? 'cancellation_requested'
              : jobState.status,
            total: jobState.total,
            sent: jobState.sent,
            skipped: jobState.skipped,
            uncertain: jobState.uncertain,
            createdAt: request.createdAt,
            completedAt: jobState.completedAt || null
          };
        });
        sendJson(res, 200, { jobs });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load broadcast status:', error.message);
        sendJson(res, 500, { error: 'Could not read broadcast status.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/agent-status') {
      try {
        const data = readData();
        const status = readJsonFileOr(agentStatusFile, null);
        const handledChats = Object.entries(data.history)
          .filter(([jid, messages]) =>
            isDirectChat(jid) && messages.some(message => message.role === 'agent'))
          .length;
        sendJson(res, 200, getDashboardAgentStatus(status, handledChats));
      } catch (error) {
        console.error('[Admin Dashboard] Could not load WhatsApp agent status:', error.message);
        sendJson(res, 500, { error: 'Could not read WhatsApp agent status.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/agent-logs') {
      try {
        const limitValue = requestUrl.searchParams.get('limit') || '250';
        if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 500) {
          sendJson(res, 400, { error: 'Log line limit must be between 1 and 500.' });
          return;
        }
        sendJson(res, 200, readRecentAgentLogs(agentLogFile, Number(limitValue)));
      } catch (error) {
        console.error('[Admin Dashboard] Could not load WhatsApp agent logs:', error.message);
        sendJson(res, 500, { error: 'Could not read WhatsApp agent logs.' });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/admin/agent-qr') {
      try {
        const qr = readAgentQr(agentQrFile);
        sendJson(res, 200, {
          qrSvg: qr ? renderAgentQrSvg(qr.value) : null,
          updatedAt: qr?.updatedAt || null
        });
      } catch (error) {
        console.error('[Admin Dashboard] Could not load WhatsApp pairing QR:', error.message);
        sendJson(res, 500, { error: 'Could not read WhatsApp pairing QR.' });
      }
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    try {
      const data = readData();
      if (requestUrl.pathname === '/api/admin/overview') {
        sendJson(res, 200, getDashboardOverview(data));
        return;
      }

      if (requestUrl.pathname === '/api/admin/chats') {
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || String(DEFAULT_PAGE_SIZE), 10);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) {
          sendJson(res, 400, { error: 'Invalid pagination parameters' });
          return;
        }
        const activityFilter = requestUrl.searchParams.get('active');
        if (activityFilter && activityFilter !== '24h') {
          sendJson(res, 400, { error: 'Invalid activity filter' });
          return;
        }
        const handledFilter = requestUrl.searchParams.get('handled');
        if (handledFilter && handledFilter !== '1') {
          sendJson(res, 400, { error: 'Invalid handled-chat filter' });
          return;
        }
        if (activityFilter && handledFilter) {
          sendJson(res, 400, { error: 'Chat filters cannot be combined' });
          return;
        }
        sendJson(res, 200, listDashboardChats(
          data,
          requestUrl.searchParams.get('q') || '',
          offset,
          limit,
          {
            ...(activityFilter === '24h' ? { activeSince: Date.now() - 24 * 60 * 60 * 1000 } : {}),
            handledOnly: handledFilter === '1'
          }
        ));
        return;
      }

      if (requestUrl.pathname === '/api/admin/es-contacts') {
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || String(DEFAULT_CONTACT_PAGE_SIZE), 10);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) {
          sendJson(res, 400, { error: 'Invalid pagination parameters' });
          return;
        }
        sendJson(res, 200, listDashboardEsContacts(
          data,
          requestUrl.searchParams.get('q') || '',
          offset,
          limit
        ));
        return;
      }

      if (requestUrl.pathname === '/api/admin/broadcast-recipients') {
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || String(DEFAULT_CONTACT_PAGE_SIZE), 10);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) {
          sendJson(res, 400, { error: 'Invalid pagination parameters' });
          return;
        }
        sendJson(res, 200, listEligibleBroadcastContacts(
          data,
          data.optedOutJids || [],
          requestUrl.searchParams.get('q') || '',
          offset,
          limit
        ));
        return;
      }

      if (requestUrl.pathname === '/api/admin/conversation') {
        const conversation = getDashboardConversation(data, requestUrl.searchParams.get('jid'));
        if (!conversation) {
          sendJson(res, 404, { error: 'Chat not found' });
          return;
        }
        sendJson(res, 200, conversation);
        return;
      }

      if (requestUrl.pathname === '/api/admin/student-activity') {
        const daysValue = requestUrl.searchParams.get('days') || '30';
        if (!/^(30|90)$/.test(daysValue)) {
          sendJson(res, 400, { error: 'Activity range must be 30 or 90 days.' });
          return;
        }
        const timeZone = requestUrl.searchParams.get('timeZone');
        try {
          new Intl.DateTimeFormat('en-US', { timeZone });
        } catch {
          sendJson(res, 400, { error: 'The requested timezone is invalid.' });
          return;
        }
        const activity = getDashboardStudentActivity(
          data,
          requestUrl.searchParams.get('jid'),
          Number(daysValue),
          timeZone
        );
        if (!activity) {
          sendJson(res, 404, { error: 'Chat not found.' });
          return;
        }
        sendJson(res, 200, activity);
        return;
      }

      if (requestUrl.pathname === '/api/admin/progress') {
        const students = Object.entries(data.progress).map(([jid, student]) => {
          const contact = data.contacts[jid];
          const lesson = lessonForStudent(student, data.lessons);
          return {
            jid,
            name: displayName(contact, jid),
            gradeName: data.lessons[student.grade]?.name || student.grade,
            status: student.status,
            lessonTitle: lesson?.title || student.currentLessonId || '',
            deliveredAt: student.deliveredAt || null
          };
        });
        students.sort((left, right) =>
          timestampMs(right.deliveredAt) - timestampMs(left.deliveredAt));
        sendJson(res, 200, { total: students.length, students });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[Admin Dashboard] Could not load local data:', error.message);
      sendJson(res, 500, { error: 'Could not read dashboard data. Check the local data files.' });
    }
  });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const port = Number.parseInt(process.env.ADMIN_PORT || '3001', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ADMIN_PORT must be a valid TCP port.');
  }

  const server = createAdminDashboardServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`[Admin Dashboard] Running locally at http://127.0.0.1:${port}`);
  });
}
