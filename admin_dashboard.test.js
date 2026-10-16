import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeAgentMediaActivity } from './agent_media_activity.js';
import { appendAgentLog } from './agent_runtime.js';
import { writeAgentQr, writeAgentStatus } from './agent_status.js';
import {
  createAdminDashboardServer as createAuthenticatedDashboardServer,
  getDashboardAgentStatus,
  getDashboardConversation,
  getDashboardOverview,
  listDashboardStudentProgress,
  getDashboardStudentActivity,
  getDashboardWeeklyChatActivity,
  listRecentAgentMessages,
  listDashboardChats,
  listDashboardEsContacts
} from './admin_dashboard.js';
import { createContactPaymentLabelsStore } from './contact_payment_labels.js';
import { WhatsAppPresenceManager } from './whatsapp_presence.js';

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

function createAdminDashboardServer(options = {}) {
  return createAuthenticatedDashboardServer({ ...options, authManager: testAuthManager });
}

const sampleData = {
  history: {
    '1001@s.whatsapp.net': [
      { role: 'client', text: 'I need help with grammar', timestamp: 1_700_000_000 },
      { role: 'agent', text: 'We can practice together.', timestamp: 1_700_000_100 }
    ],
    '1002@lid': [
      { role: 'client', text: 'My answer is ready', timestamp: 1_700_000_200 }
    ],
    '1003@g.us': [{ role: 'client', text: 'Group message', timestamp: 1_700_000_300 }],
    'status@broadcast': [{ role: 'client', text: 'Status update', timestamp: 1_700_000_400 }]
  },
  contacts: {
    '1001@s.whatsapp.net': { name: 'Ali', isEs: true, savedInAddressBook: true },
    '1002@lid': { name: 'Sara', isEs: false, savedInAddressBook: true },
    '1003@s.whatsapp.net': { name: 'Es New', isEs: true },
    '1004@lid': {
      jid: '1001@s.whatsapp.net',
      name: 'Ali',
      isEs: true,
      savedInAddressBook: true
    },
    '1005@s.whatsapp.net': { name: 'Regular Saved', isEs: false, savedInAddressBook: true }
  },
  progress: {
    '1001@s.whatsapp.net': { grade: 'grade_3_secondary', currentLessonIndex: 0, status: 'awaiting_task', deliveredAt: '2026-10-15T10:00:00.000Z' }
  },
  lessons: {
    grade_3_secondary: { name: 'Third Secondary', lessons: [{ title: 'Lesson One' }] }
  }
};

test('recent agent message feed combines direct chats chronologically and resolves linked LID names', () => {
  const messages = listRecentAgentMessages({
    history: {
      '1001@s.whatsapp.net': [
        { role: 'agent', text: 'Recent response', timestamp: 1_700_000_040 }
      ],
      '1006@lid': [
        { role: 'client', text: 'Hello from a linked chat', timestamp: 1_700_000_050 },
        { role: 'agent', text: 'Hello back', timestamp: 1_700_000_060 }
      ],
      '1007@g.us': [{ role: 'client', text: 'Ignore group', timestamp: 1_700_000_070 }]
    },
    contacts: {
      ...sampleData.contacts,
      '1006@lid': {
        phoneJid: '1006@s.whatsapp.net',
        name: 'Amina'
      },
      '1001@s.whatsapp.net': { name: 'Ali' }
    }
  }, 3);

  assert.deepEqual(messages.map(({ name, role, text, phoneNumber }) => ({
    name,
    role,
    text,
    phoneNumber
  })), [
    { name: 'Ali', role: 'agent', text: 'Recent response', phoneNumber: '1001' },
    { name: 'Amina', role: 'client', text: 'Hello from a linked chat', phoneNumber: '1006' },
    { name: 'Amina', role: 'agent', text: 'Hello back', phoneNumber: '1006' }
  ]);
  assert.equal(listRecentAgentMessages(sampleData, 1).length, 1);
});

test('agent conversation API returns the latest saved incoming messages and replies', async () => {
  const server = createAdminDashboardServer({ readData: () => sampleData });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/admin/agent-conversation?limit=10`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(result.messages.some(message =>
      message.role === 'client' && message.text === 'I need help with grammar'));
    assert.ok(result.messages.some(message =>
      message.role === 'agent' && message.text === 'We can practice together.'));

    const invalidLimit = await fetch(`${origin}/api/admin/agent-conversation?limit=201`);
    assert.equal(invalidLimit.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('overview gender statistics count only saved Es phone-book contacts', () => {
  assert.deepEqual(getDashboardOverview({
    ...sampleData,
    genderOverrides: { '1001': 'female' }
  }, 1_700_000_500), {
    totalChats: 2,
    activeToday: 2,
    handledChats: 1,
    esContacts: 1,
    permanentHistoryContacts: 3,
    genderStatistics: {
      female: 1,
      male: 0,
      unknown: 0,
      manual: 1,
      inferred: 0,
      total: 1
    },
    weeklyChatActivity: {
      timeZone: 'UTC',
      days: [
        { date: '2023-11-08', day: 'Wed', chats: 0 },
        { date: '2023-11-09', day: 'Thu', chats: 0 },
        { date: '2023-11-10', day: 'Fri', chats: 0 },
        { date: '2023-11-11', day: 'Sat', chats: 0 },
        { date: '2023-11-12', day: 'Sun', chats: 0 },
        { date: '2023-11-13', day: 'Mon', chats: 0 },
        { date: '2023-11-14', day: 'Tue', chats: 2 }
      ]
    },
    studentsWithProgress: 1,
    awaitingTask: 1,
    awaitingReattempt: 0,
    completed: 0,
    configuredLessons: 1
  });
});

test('weekly dashboard activity counts distinct direct chats for the local calendar days', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const activity = getDashboardWeeklyChatActivity({
    ...sampleData,
    history: {
      '1001@s.whatsapp.net': [
        { role: 'client', text: 'Saturday one', timestamp: Date.parse('2026-10-10T09:00:00.000Z') },
        { role: 'client', text: 'Saturday again', timestamp: Date.parse('2026-10-10T10:00:00.000Z') },
        { role: 'client', text: 'Friday', timestamp: Date.parse('2026-10-16T11:00:00.000Z') }
      ],
      '1002@s.whatsapp.net': [
        { role: 'client', text: 'Saturday other chat', timestamp: Date.parse('2026-10-10T12:00:00.000Z') },
        { role: 'client', text: 'Monday', timestamp: Date.parse('2026-10-12T12:00:00.000Z') },
        { role: 'agent', text: 'Agent reply', timestamp: Date.parse('2026-10-13T12:00:00.000Z') }
      ],
      '1003@g.us': [
        { role: 'client', text: 'Group', timestamp: Date.parse('2026-10-16T11:00:00.000Z') }
      ]
    }
  }, 'UTC', now);

  assert.deepEqual(activity, {
    timeZone: 'UTC',
    days: [
      { date: '2026-10-10', day: 'Sat', chats: 2 },
      { date: '2026-10-11', day: 'Sun', chats: 0 },
      { date: '2026-10-12', day: 'Mon', chats: 1 },
      { date: '2026-10-13', day: 'Tue', chats: 0 },
      { date: '2026-10-14', day: 'Wed', chats: 0 },
      { date: '2026-10-15', day: 'Thu', chats: 0 },
      { date: '2026-10-16', day: 'Fri', chats: 1 }
    ]
  });
});

test('weekly dashboard activity uses the requested timezone and rejects invalid zones', () => {
  const now = Date.parse('2026-10-11T01:00:00.000Z');
  const data = {
    ...sampleData,
    history: {
      '1001@s.whatsapp.net': [
        { role: 'client', text: 'Late message', timestamp: now }
      ]
    }
  };
  const losAngeles = getDashboardWeeklyChatActivity(data, 'America/Los_Angeles', now);
  assert.equal(losAngeles.days.at(-1).date, '2026-10-10');
  assert.equal(losAngeles.days.at(-1).day, 'Sat');
  assert.equal(losAngeles.days.at(-1).chats, 1);
  assert.throws(() => getDashboardWeeklyChatActivity(data, 'Not/A_Timezone', now), /timezone is invalid/);
});

test('chat search includes names and message text, excludes groups, and paginates', () => {
  const byMessage = listDashboardChats(sampleData, 'grammar');
  assert.equal(byMessage.total, 1);
  assert.equal(byMessage.chats[0].name, 'Ali');
  assert.equal(byMessage.chats[0].progress.lessonTitle, 'Lesson One');

  const page = listDashboardChats(sampleData, '', 1, 1);
  assert.equal(page.total, 2);
  assert.equal(page.chats.length, 1);
  assert.equal(page.chats[0].name, 'Ali');
});

test('chat list supports date ordering and read/unread sorting and filtering', () => {
  const readState = {
    '1001@s.whatsapp.net': 1_700_000_000_000,
    '1002@lid': 0
  };
  const oldestFirst = listDashboardChats(sampleData, '', 0, 30, {
    readState,
    sort: 'date-asc'
  });
  assert.deepEqual(oldestFirst.chats.map(chat => chat.jid), ['1001@s.whatsapp.net', '1002@lid']);
  assert.equal(oldestFirst.chats[0].unread, false);
  assert.equal(oldestFirst.chats[1].unread, true);

  const unreadFirst = listDashboardChats(sampleData, '', 0, 30, {
    readState,
    sort: 'unread-first'
  });
  assert.equal(unreadFirst.chats[0].jid, '1002@lid');
  assert.deepEqual(listDashboardChats(sampleData, '', 0, 30, {
    readState,
    readFilter: 'unread'
  }).chats.map(chat => chat.jid), ['1002@lid']);
  assert.deepEqual(listDashboardChats(sampleData, '', 0, 30, {
    readState,
    readFilter: 'read'
  }).chats.map(chat => chat.jid), ['1001@s.whatsapp.net']);
});

test('student progress shows incoming-message volume and frequency across linked WhatsApp IDs', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  const result = listDashboardStudentProgress({
    ...sampleData,
    contacts: {
      ...sampleData.contacts,
      '1001@lid': {
        jid: '1001@s.whatsapp.net',
        phoneJid: '1001@s.whatsapp.net',
        name: 'Ali LID'
      }
    },
    history: {
      ...sampleData.history,
      '1001@lid': [
        { role: 'client', text: 'Recent question', timestamp: now / 1000 - 2 * 24 * 60 * 60 },
        { role: 'client', text: 'Another question', timestamp: now / 1000 - 6 * 24 * 60 * 60 },
        { role: 'agent', text: 'Reply', timestamp: now / 1000 - 24 * 60 * 60 }
      ],
      '1001@s.whatsapp.net': [
        { role: 'client', text: 'Older question', timestamp: now / 1000 - 15 * 24 * 60 * 60 },
        { role: 'client', text: 'Old question', timestamp: now / 1000 - 40 * 24 * 60 * 60 }
      ]
    }
  }, now);

  assert.equal(result.total, 1);
  assert.equal(result.students[0].jid, '1001@s.whatsapp.net');
  assert.equal(result.students[0].lastStudentActivityAt, now - 2 * 24 * 60 * 60 * 1000);
  assert.equal(result.students[0].totalIncomingMessages, 4);
  assert.equal(result.students[0].incomingMessagesLast7Days, 2);
  assert.equal(result.students[0].incomingMessagesLast30Days, 3);
  assert.equal(result.students[0].activeDaysLast30Days, 3);
});

test('chat list and conversation show the manually selected contact gender', () => {
  const data = {
    ...sampleData,
    genderOverrides: { '1001': 'female' }
  };
  const chat = listDashboardChats(data).chats.find(item => item.jid === '1001@s.whatsapp.net');
  const conversation = getDashboardConversation(data, '1001@s.whatsapp.net');

  assert.deepEqual(chat.gender, { value: 'female', source: 'manual' });
  assert.deepEqual(conversation.gender, { value: 'female', source: 'manual' });
});

test('chat activity filter only includes chats active on or after the supplied cutoff', () => {
  const filtered = listDashboardChats(sampleData, '', 0, 30, {
    activeSince: 1_700_000_150_000
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.chats[0].name, 'Sara');
});

test('handled chat filter returns direct chats ordered by their latest agent reply', () => {
  const data = {
    ...sampleData,
    history: {
      ...sampleData.history,
      '1001@s.whatsapp.net': [
        { role: 'agent', text: 'Older reply', timestamp: 1_700_000_100 },
        { role: 'client', text: 'Recent incoming message', timestamp: 1_700_000_500 }
      ],
      '1002@lid': [
        { role: 'client', text: 'Question', timestamp: 1_700_000_300 },
        { role: 'agent', text: 'Recent agent reply', timestamp: 1_700_000_400 }
      ],
      '1003@g.us': [
        { role: 'agent', text: 'Group reply', timestamp: 1_700_000_600 }
      ]
    }
  };
  const result = listDashboardChats(data, '', 0, 30, { handledOnly: true });

  assert.equal(result.total, 2);
  assert.equal(result.chats[0].jid, '1002@lid');
  assert.equal(result.chats[0].lastHandledAt, 1_700_000_400_000);
  assert.equal(result.chats[1].jid, '1001@s.whatsapp.net');
  assert.equal(result.chats[1].lastActivity, 1_700_000_500_000);
});

test('chats API validates the agent-handled filter and returns handled chats', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-chats-api-test-'));
  const chatReadStateFile = path.join(temporaryDirectory, 'chat_read_state.json');
  fs.writeFileSync(chatReadStateFile, JSON.stringify({
    '1001@s.whatsapp.net': 1_700_000_000_000,
    '1002@lid': 0
  }));
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    chatReadStateFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/chats`;
    const response = await fetch(`${baseUrl}?handled=1`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.total, 1);
    assert.equal(result.chats[0].jid, '1001@s.whatsapp.net');
    assert.equal(result.chats[0].lastHandledAt, 1_700_000_100_000);

    const invalidFilter = await fetch(`${baseUrl}?handled=true`);
    assert.equal(invalidFilter.status, 400);
    const combinedFilters = await fetch(`${baseUrl}?handled=1&active=24h`);
    assert.equal(combinedFilters.status, 400);
    const invalidSort = await fetch(`${baseUrl}?sort=unknown`);
    assert.equal(invalidSort.status, 400);
    const invalidReadFilter = await fetch(`${baseUrl}?read=unknown`);
    assert.equal(invalidReadFilter.status, 400);
    const unreadChats = await (await fetch(`${baseUrl}?read=unread&sort=unread-first`)).json();
    assert.deepEqual(unreadChats.chats.map(chat => chat.jid), ['1002@lid']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('chat read API records the latest incoming message as read', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-chat-read-test-'));
  const chatReadStateFile = path.join(temporaryDirectory, 'chat_read_state.json');
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    chatReadStateFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/admin/chat-read`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: '1001@s.whatsapp.net' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      jid: '1001@s.whatsapp.net',
      lastIncomingAt: 1_700_000_000_000,
      unread: false
    });
    assert.equal(JSON.parse(fs.readFileSync(chatReadStateFile, 'utf8'))['1001@s.whatsapp.net'], 1_700_000_000_000);

    const invalid = await fetch(`${baseUrl}/api/admin/chat-read`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: '1003@g.us' })
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('conversation detail returns recent messages and rejects non-direct chat IDs', () => {
  const conversation = getDashboardConversation(sampleData, '1001@s.whatsapp.net');
  assert.equal(conversation.name, 'Ali');
  assert.equal(conversation.messages.length, 2);
  assert.equal(getDashboardConversation(sampleData, '1003@g.us'), null);
  assert.equal(getDashboardConversation(sampleData, 'missing@s.whatsapp.net'), null);
});

test('dashboard exposes WhatsApp presence and queues subscriptions for an opened chat', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-whatsapp-presence-'));
  const presenceFile = path.join(temporaryDirectory, 'presence.json');
  const presenceRequestsFile = path.join(temporaryDirectory, 'presence-requests.json');
  const presenceManager = new WhatsAppPresenceManager({ presenceFile, requestsFile: presenceRequestsFile });
  presenceManager.recordPresenceUpdate({
    id: '1001@s.whatsapp.net',
    presences: {
      '1001@s.whatsapp.net': { lastKnownPresence: 'available' }
    }
  });
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    whatsappPresenceFile: presenceFile,
    whatsappPresenceRequestsFile: presenceRequestsFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const chatsResponse = await fetch(`${baseUrl}/api/admin/chats?limit=10`);
    const chats = await chatsResponse.json();
    assert.equal(chats.chats.find(chat => chat.jid === '1001@s.whatsapp.net').presence.status, 'online');
    assert.equal(chats.chats.find(chat => chat.jid === '1002@lid').presence.status, 'unknown');

    const conversationResponse = await fetch(
      `${baseUrl}/api/admin/conversation?jid=${encodeURIComponent('1001@s.whatsapp.net')}`
    );
    const conversation = await conversationResponse.json();
    assert.equal(conversation.presence.status, 'online');

    const subscriptionResponse = await fetch(`${baseUrl}/api/admin/presence-subscribe`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jids: ['1001@s.whatsapp.net', '1002@lid'] })
    });
    assert.equal(subscriptionResponse.status, 202);
    assert.deepEqual(
      (await subscriptionResponse.json()).subscriptions.map(subscription => subscription.status),
      ['queued', 'queued']
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(presenceRequestsFile, 'utf8')).map(request => request.jid),
      ['1001@s.whatsapp.net', '1002@lid']
    );

    const invalidSubscription = await fetch(`${baseUrl}/api/admin/presence-subscribe`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jids: ['1003@g.us'] })
    });
    assert.equal(invalidSubscription.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('student activity counts incoming messages by local weekday and hour for the selected period', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  const data = {
    ...sampleData,
    history: {
      ...sampleData.history,
      '1001@s.whatsapp.net': [
        { role: 'client', text: 'Morning', timestamp: Date.UTC(2026, 9, 15, 9) / 1000 },
        { role: 'client', text: 'Evening', timestamp: Date.UTC(2026, 9, 14, 23) / 1000 },
        { role: 'client', text: 'Older', timestamp: Date.UTC(2026, 7, 1, 12) / 1000 },
        { role: 'agent', text: 'Agent message', timestamp: Date.UTC(2026, 9, 15, 10) / 1000 },
        { role: 'client', text: 'Future', timestamp: Date.UTC(2026, 9, 16, 9) / 1000 }
      ]
    }
  };

  const recent = getDashboardStudentActivity(data, '1001@s.whatsapp.net', 30, 'America/New_York', now);
  assert.equal(recent.totalMessages, 2);
  assert.equal(recent.activeDays, 2);
  assert.equal(recent.timeZone, 'America/New_York');
  assert.equal(recent.hourlyTotals[5], 1);
  assert.equal(recent.hourlyTotals[19], 1);
  assert.equal(recent.hourlyTotals.reduce((total, count) => total + count, 0), 2);
  assert.equal(recent.weekdays.find(day => day.day === 'Thursday').hours[5], 1);
  assert.equal(recent.weekdays.find(day => day.day === 'Wednesday').hours[19], 1);

  const extended = getDashboardStudentActivity(data, '1001@s.whatsapp.net', 90, 'America/New_York', now);
  assert.equal(extended.totalMessages, 3);
  assert.equal(extended.activeDays, 3);
  assert.throws(
    () => getDashboardStudentActivity(data, '1001@s.whatsapp.net', 30, 'Invalid/Timezone', now),
    /timezone is invalid/
  );
  assert.equal(getDashboardStudentActivity(data, '1003@g.us', 30, 'UTC', now), null);
});

test('student activity resolves phone-book contacts to LID history and handles contacts with no messages', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  const phoneJid = '2001@s.whatsapp.net';
  const data = {
    ...sampleData,
    history: {
      '2001@lid': [
        { role: 'client', text: 'Question', timestamp: Date.UTC(2026, 9, 15, 9) / 1000 },
        { role: 'agent', text: 'Answer', timestamp: Date.UTC(2026, 9, 15, 10) / 1000 }
      ]
    },
    contacts: {
      [phoneJid]: { name: 'Student with LID history', isEs: true, savedInAddressBook: true },
      '2001@lid': { jid: phoneJid, name: 'Student with LID history', isEs: true }
    }
  };

  const activity = getDashboardStudentActivity(data, phoneJid, 30, 'UTC', now);
  assert.equal(activity.totalMessages, 1);
  assert.equal(activity.jid, phoneJid);
  assert.equal(activity.weekdays.find(day => day.day === 'Thursday').hours[9], 1);

  const noHistory = getDashboardStudentActivity({
    ...data,
    history: {},
    contacts: { [phoneJid]: { name: 'New Es student', isEs: true, savedInAddressBook: true } }
  }, phoneJid, 30, 'UTC', now);
  assert.equal(noHistory.totalMessages, 0);
  assert.equal(noHistory.activeDays, 0);
  assert.equal(noHistory.hourlyTotals.length, 24);
  assert.equal(noHistory.hourlyTotals.reduce((total, count) => total + count, 0), 0);
});

test('student activity API validates chat, range, and timezone', async () => {
  const server = createAdminDashboardServer({ readData: () => sampleData });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/student-activity`;
    const validQuery = new URLSearchParams({
      jid: '1001@s.whatsapp.net',
      days: '30',
      timeZone: 'Africa/Khartoum'
    });
    const validResponse = await fetch(`${baseUrl}?${validQuery}`);
    assert.equal(validResponse.status, 200);
    assert.equal((await validResponse.json()).timeZone, 'Africa/Khartoum');

    const invalidRange = await fetch(`${baseUrl}?jid=1001%40s.whatsapp.net&days=60&timeZone=UTC`);
    assert.equal(invalidRange.status, 400);
    const invalidTimezone = await fetch(`${baseUrl}?jid=1001%40s.whatsapp.net&days=30&timeZone=invalid`);
    assert.equal(invalidTimezone.status, 400);
    const unknownChat = await fetch(`${baseUrl}?jid=9999%40s.whatsapp.net&days=30&timeZone=UTC`);
    assert.equal(unknownChat.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Es phone-book contacts include saved Es numbers, filter by search, and deduplicate aliases', () => {
  const allContacts = listDashboardEsContacts(sampleData);
  assert.equal(allContacts.total, 1);
  assert.deepEqual(allContacts.contacts[0], {
    jid: '1001@s.whatsapp.net',
    name: 'Ali',
    phoneNumber: '1001',
    gender: { value: 'unknown', confidence: 'not clearly stated', source: 'inferred' },
    paid: null,
    canMessage: true
  });

  assert.equal(listDashboardEsContacts(sampleData, '1001').total, 1);
  assert.equal(listDashboardEsContacts(sampleData, 'not found').total, 0);
});

test('Es contact gender is inferred from linked client messages, not agent replies', () => {
  const phoneJid = '249000000008@s.whatsapp.net';
  const lidJid = '100000000000008@lid';
  const data = {
    ...sampleData,
    contacts: {
      ...sampleData.contacts,
      [phoneJid]: { name: 'Es Student', isEs: true, savedInAddressBook: true },
      [lidJid]: { jid: phoneJid, name: 'Es Student', isEs: true }
    },
    history: {
      ...sampleData.history,
      [lidJid]: [
        { role: 'client', text: 'أنا طالبة في الصف الثالث' },
        { role: 'agent', text: 'هل إنتِ طالبة؟' }
      ]
    }
  };

  const contact = listDashboardEsContacts(data).contacts
    .find(item => item.phoneNumber === '249000000008');
  assert.deepEqual(contact.gender, {
    value: 'female',
    confidence: 'inferred from self-description',
    source: 'inferred'
  });
});

test('manual gender selection persists and can switch back to inference', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-contact-gender-test-'));
  const contactGenderFile = path.join(temporaryDirectory, 'contact_gender.json');
  const phoneJid = '249000000009@s.whatsapp.net';
  const data = {
    ...sampleData,
    contacts: {
      ...sampleData.contacts,
      [phoneJid]: { name: 'Es Student', isEs: true, savedInAddressBook: true }
    },
    history: {
      ...sampleData.history,
      [phoneJid]: [{ role: 'client', text: 'أنا طالبة' }]
    }
  };
  const server = createAdminDashboardServer({
    readData: () => data,
    contactGenderFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const origin = baseUrl;
    const contactsUrl = `${baseUrl}/api/admin/es-contacts`;
    const genderUrl = `${baseUrl}/api/admin/contact-gender/249000000009`;

    let contact = (await (await fetch(contactsUrl)).json()).contacts
      .find(item => item.phoneNumber === '249000000009');
    assert.deepEqual(contact.gender, {
      value: 'female',
      confidence: 'inferred from self-description',
      source: 'inferred'
    });
    let genderStatistics = (await (await fetch(`${baseUrl}/api/admin/overview`)).json()).genderStatistics;
    assert.deepEqual(genderStatistics, {
      female: 1,
      male: 0,
      unknown: 1,
      manual: 0,
      inferred: 2,
      total: 2
    });
    const overviewResponse = await fetch(`${baseUrl}/api/admin/overview?timeZone=America%2FLos_Angeles`);
    const overview = await overviewResponse.json();
    assert.equal(overviewResponse.status, 200);
    assert.equal(overview.weeklyChatActivity.timeZone, 'America/Los_Angeles');
    assert.equal(overview.weeklyChatActivity.days.length, 7);
    const invalidTimezoneResponse = await fetch(`${baseUrl}/api/admin/overview?timeZone=Not%2FA_Timezone`);
    assert.equal(invalidTimezoneResponse.status, 400);

    const manualResponse = await fetch(genderUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gender: 'male' })
    });
    assert.equal(manualResponse.status, 200);
    assert.deepEqual(await manualResponse.json(), {
      number: '249000000009',
      gender: 'male',
      source: 'manual'
    });

    contact = (await (await fetch(contactsUrl)).json()).contacts
      .find(item => item.phoneNumber === '249000000009');
    assert.deepEqual(contact.gender, { value: 'male', source: 'manual' });
    assert.deepEqual(JSON.parse(fs.readFileSync(contactGenderFile, 'utf8')), {
      '249000000009': 'male'
    });
    genderStatistics = (await (await fetch(`${baseUrl}/api/admin/overview`)).json()).genderStatistics;
    assert.deepEqual(genderStatistics, {
      female: 0,
      male: 1,
      unknown: 1,
      manual: 1,
      inferred: 1,
      total: 2
    });

    const autoResponse = await fetch(genderUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gender: 'auto' })
    });
    assert.equal(autoResponse.status, 200);
    contact = (await (await fetch(contactsUrl)).json()).contacts
      .find(item => item.phoneNumber === '249000000009');
    assert.equal(contact.gender.value, 'female');
    assert.equal(contact.gender.source, 'inferred');
    assert.deepEqual(JSON.parse(fs.readFileSync(contactGenderFile, 'utf8')), {});
    genderStatistics = (await (await fetch(`${baseUrl}/api/admin/overview`)).json()).genderStatistics;
    assert.equal(genderStatistics.female, 1);
    assert.equal(genderStatistics.manual, 0);

    const invalidResponse = await fetch(genderUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gender: 'unsure' })
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Es phone-book contact resolves a phone number from a linked LID record', () => {
  const phoneJid = '249000000007@s.whatsapp.net';
  const lidJid = '100000000000007@lid';
  const data = {
    ...sampleData,
    contacts: {
      ...sampleData.contacts,
      [lidJid]: {
        jid: lidJid,
        phoneJid,
        name: 'New Es contact',
        isEs: true,
        savedInAddressBook: true
      }
    }
  };

  const result = listDashboardEsContacts(data);
  assert.ok(result.contacts.some(contact =>
    contact.jid === phoneJid && contact.name === 'New Es contact'));
});

test('banning and deleting a number suppresses it and allows explicit unblocking', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-blocked-contact-test-'));
  const contactsFile = path.join(temporaryDirectory, 'contacts.json');
  const blockedContactsFile = path.join(temporaryDirectory, 'blocked_contacts.json');
  const phoneJid = '249111111111@s.whatsapp.net';
  const lidJid = '100000000000111@lid';
  const contacts = {
    [phoneJid]: { name: 'Es Test Student', isEs: true, savedInAddressBook: true },
    [lidJid]: { jid: phoneJid, name: 'Es Test Student', isEs: true }
  };
  fs.writeFileSync(contactsFile, JSON.stringify(contacts));
  const readData = () => ({
    ...sampleData,
    contacts: JSON.parse(fs.readFileSync(contactsFile, 'utf8'))
  });
  const server = createAdminDashboardServer({ readData, contactsFile, blockedContactsFile });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const origin = baseUrl;
    const numberUrl = `${baseUrl}/api/admin/contacts/249111111111`;
    const rejectedBan = await fetch(`${numberUrl}/ban`, { method: 'POST' });
    assert.equal(rejectedBan.status, 403);

    const banResponse = await fetch(`${numberUrl}/ban`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    assert.equal(banResponse.status, 200);
    assert.equal((await banResponse.json()).reason, 'banned');

    let contactsResponse = await fetch(`${baseUrl}/api/admin/es-contacts`);
    let dashboardContacts = await contactsResponse.json();
    assert.equal(dashboardContacts.contacts[0].canMessage, false);
    assert.equal(dashboardContacts.contacts[0].block.reason, 'banned');
    assert.deepEqual((await (await fetch(`${baseUrl}/api/admin/blocked-contacts`)).json())
      .blockedNumbers.map(record => record.number), ['249111111111']);

    const deleteResponse = await fetch(numberUrl, {
      method: 'DELETE',
      headers: { Origin: origin }
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json()).removedContacts, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(contactsFile, 'utf8')), {});
    assert.equal((await (await fetch(`${baseUrl}/api/admin/blocked-contacts`)).json())
      .blockedNumbers[0].reason, 'deleted');

    const unblockResponse = await fetch(`${numberUrl}/unblock`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    assert.equal(unblockResponse.status, 200);
    assert.deepEqual((await (await fetch(`${baseUrl}/api/admin/blocked-contacts`)).json())
      .blockedNumbers, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('Es contacts API reflects new agent-synced contacts without restarting the dashboard', async () => {
  let data = sampleData;
  const server = createAdminDashboardServer({ readData: () => data });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/es-contacts?limit=50`;
    const firstResponse = await fetch(url);
    assert.equal((await firstResponse.json()).total, 1);

    data = {
      ...sampleData,
      contacts: {
        ...sampleData.contacts,
        '1006@s.whatsapp.net': {
          name: 'New Es Student',
          isEs: true,
          savedInAddressBook: true
        }
      }
    };
    const refreshedResponse = await fetch(url);
    const refreshed = await refreshedResponse.json();
    assert.equal(refreshed.total, 2);
    assert.ok(refreshed.contacts.some(contact => contact.name === 'New Es Student'));

    const eligibleResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/broadcast-recipients?limit=50`
    );
    const eligible = await eligibleResponse.json();
    assert.ok(eligible.contacts.every(contact => contact.gender?.value));

    const invalidDateResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/broadcast-recipients?date=2026-02-30`
    );
    assert.equal(invalidDateResponse.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Es contacts API exposes inferred paid labels', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-paid-contact-test-'));
  const phoneNumber = '249123456789';
  const paymentLabelsFile = path.join(temporaryDirectory, 'contact_payment_labels.json');
  createContactPaymentLabelsStore(paymentLabelsFile)
    .markPaid(phoneNumber, `${phoneNumber}@s.whatsapp.net`);
  const data = {
    ...sampleData,
    contacts: {
      ...sampleData.contacts,
      [`${phoneNumber}@s.whatsapp.net`]: {
        name: 'Paid Es Student',
        isEs: true,
        savedInAddressBook: true
      }
    }
  };
  const server = createAdminDashboardServer({
    readData: () => data,
    paymentLabelsFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/es-contacts?limit=50`
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    const paidContact = result.contacts.find(contact => contact.phoneNumber === phoneNumber);
    assert.equal(paidContact.paid.label, 'paid');
    assert.equal(paidContact.paid.source, 'student-reported');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard manually sets and clears contact paid labels', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-manual-paid-test-'));
  const phoneNumber = '249123456789';
  const paymentLabelsFile = path.join(temporaryDirectory, 'contact_payment_labels.json');
  const data = {
    ...sampleData,
    history: {
      ...sampleData.history,
      [`${phoneNumber}@s.whatsapp.net`]: [
        { role: 'client', text: 'Hello', timestamp: 1_700_000_000 }
      ]
    },
    contacts: {
      ...sampleData.contacts,
      [`${phoneNumber}@s.whatsapp.net`]: {
        name: 'Manual Es Student',
        isEs: true,
        savedInAddressBook: true
      }
    }
  };
  const server = createAdminDashboardServer({
    readData: () => data,
    paymentLabelsFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/contact-payment-label/${phoneNumber}`;
    const paidResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${server.address().port}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'paid' })
    });
    assert.equal(paidResponse.status, 200);
    assert.equal((await paidResponse.json()).label.source, 'manual');

    const contactsResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/es-contacts?limit=50`
    );
    const paidContact = (await contactsResponse.json()).contacts
      .find(contact => contact.phoneNumber === phoneNumber);
    assert.equal(paidContact.paid.source, 'manual');
    const chatResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/chats?q=${phoneNumber}&limit=10`
    );
    const paidChat = (await chatResponse.json()).chats
      .find(chat => chat.jid === `${phoneNumber}@s.whatsapp.net`);
    assert.equal(paidChat.paid.source, 'manual');
    const conversationResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/conversation?jid=${encodeURIComponent(`${phoneNumber}@s.whatsapp.net`)}`
    );
    assert.equal((await conversationResponse.json()).paid.source, 'manual');

    const unpaidResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${server.address().port}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'unpaid' })
    });
    assert.equal(unpaidResponse.status, 200);
    const unpaidLabel = (await unpaidResponse.json()).label;
    assert.equal(unpaidLabel.label, 'unpaid');
    assert.equal(unpaidLabel.whatsappAction, 'remove');

    const clearedContactsResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/es-contacts?limit=50`
    );
    const unpaidContact = (await clearedContactsResponse.json()).contacts
      .find(contact => contact.phoneNumber === phoneNumber);
    assert.equal(unpaidContact.paid, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('agent status only reports connected when its heartbeat is fresh', () => {
  const now = Date.now();
  const freshStatus = {
    connectionState: 'connected',
    updatedAt: new Date(now - 5_000).toISOString(),
    lastConnectedAt: new Date(now - 60_000).toISOString(),
    account: { name: 'WhatsApp User', phoneNumber: '249123456789' }
  };
  const connected = getDashboardAgentStatus(freshStatus, 12, now);
  assert.equal(connected.connectionState, 'connected');
  assert.equal(connected.connected, true);
  assert.equal(connected.handledChats, 12);
  assert.equal(connected.lastConnectedAt, freshStatus.lastConnectedAt);
  assert.deepEqual(connected.account, freshStatus.account);
  assert.equal(getDashboardAgentStatus({
    ...freshStatus,
    account: { name: 'WhatsApp User', phoneNumber: 'not-a-number' }
  }, 12, now).account.phoneNumber, null);

  assert.equal(getDashboardAgentStatus({
    ...freshStatus,
    updatedAt: new Date(now - 60_000).toISOString()
  }, 12, now).connected, false);
  assert.equal(getDashboardAgentStatus({
    ...freshStatus,
    connectionState: 'disconnected'
  }, 12, now).connected, false);
  assert.equal(getDashboardAgentStatus({
    ...freshStatus,
    connectionState: 'connecting'
  }, 12, now).connectionState, 'connecting');
  assert.equal(getDashboardAgentStatus(null, 0, now).connected, false);
  assert.equal(getDashboardAgentStatus(null, 0, now).connectionState, 'unknown');
});

test('agent status API reports live connection heartbeat and handled chat total', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-status-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  fs.writeFileSync(agentStatusFile, JSON.stringify({
    connectionState: 'connected',
    lastConnectedAt: '2026-10-15T10:00:00.000Z',
    account: { name: 'WhatsApp User', phoneNumber: '249123456789' },
    updatedAt: new Date().toISOString()
  }));
  const server = createAdminDashboardServer({ readData: () => sampleData, agentStatusFile });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/agent-status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      connectionState: 'connected',
      connected: true,
      lastConnectedAt: '2026-10-15T10:00:00.000Z',
      lastHeartbeatAt: JSON.parse(fs.readFileSync(agentStatusFile, 'utf8')).updatedAt,
      account: { name: 'WhatsApp User', phoneNumber: '249123456789' },
      handledChats: 1
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard requests contact sync only when the agent is connected', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-contact-sync-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const contactSyncRequestsFile = path.join(temporaryDirectory, 'contact_sync_requests.json');
  const contactSyncStatusFile = path.join(temporaryDirectory, 'contact_sync_status.json');
  fs.writeFileSync(agentStatusFile, JSON.stringify({
    connectionState: 'connected',
    updatedAt: new Date().toISOString()
  }));
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    agentStatusFile,
    contactSyncRequestsFile,
    contactSyncStatusFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const queuedResponse = await fetch(`${baseUrl}/api/admin/contact-sync`, {
      method: 'POST',
      headers: { Origin: baseUrl }
    });
    assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json();
    assert.equal(queued.status, 'queued');
    assert.ok(queued.id);

    const requests = JSON.parse(fs.readFileSync(contactSyncRequestsFile, 'utf8'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, queued.id);
    const statusResponse = await fetch(`${baseUrl}/api/admin/contact-sync/${queued.id}`);
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).status, 'queued');

    const invalidOriginResponse = await fetch(`${baseUrl}/api/admin/contact-sync`, {
      method: 'POST',
      headers: { Origin: 'https://example.com' }
    });
    assert.equal(invalidOriginResponse.status, 403);

    fs.writeFileSync(agentStatusFile, JSON.stringify({
      connectionState: 'disconnected',
      updatedAt: new Date().toISOString()
    }));
    const disconnectedResponse = await fetch(`${baseUrl}/api/admin/contact-sync`, {
      method: 'POST',
      headers: { Origin: baseUrl }
    });
    assert.equal(disconnectedResponse.status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('agent logs API serves recent output and pairing QR only while fresh', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-runtime-test-'));
  const agentLogFile = path.join(temporaryDirectory, 'agent.log');
  const agentQrFile = path.join(temporaryDirectory, 'agent_qr.json');
  appendAgentLog('info', ['Agent is listening'], agentLogFile);
  writeAgentQr('test-pairing-token', agentQrFile);
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    agentLogFile,
    agentQrFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
    const logsResponse = await fetch(`${baseUrl}/agent-logs?limit=10`);
    assert.equal(logsResponse.status, 200);
    assert.match((await logsResponse.json()).lines[0], /\[info\] Agent is listening/);

    const invalidLimit = await fetch(`${baseUrl}/agent-logs?limit=501`);
    assert.equal(invalidLimit.status, 400);

    const qrResponse = await fetch(`${baseUrl}/agent-qr`);
    const qr = await qrResponse.json();
    assert.equal(qrResponse.status, 200);
    assert.match(qr.qrSvg, /^<svg/);

    const expiredQr = JSON.parse(fs.readFileSync(agentQrFile, 'utf8'));
    expiredQr.updatedAt = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(agentQrFile, JSON.stringify(expiredQr));
    assert.equal((await (await fetch(`${baseUrl}/agent-qr`)).json()).qrSvg, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('agent media API exposes live upload progress and delivery results', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-media-test-'));
  const agentMediaActivityFile = path.join(temporaryDirectory, 'agent_media_activity.json');
  writeAgentMediaActivity({
    id: 'video-test',
    mediaType: 'video',
    label: 'Video',
    recipientJid: '1001@s.whatsapp.net',
    description: 'Lesson 2',
    status: 'uploading',
    loaded: 512,
    total: 1024,
    percent: 50,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, agentMediaActivityFile);
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    agentMediaActivityFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/agent-media`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      activities: [{
        id: 'video-test',
        mediaType: 'video',
        label: 'Video',
        recipientJid: '1001@s.whatsapp.net',
        description: 'Lesson 2',
        status: 'uploading',
        loaded: 512,
        total: 1024,
        percent: 50,
        startedAt: JSON.parse(fs.readFileSync(agentMediaActivityFile, 'utf8')).activities[0].startedAt,
        updatedAt: JSON.parse(fs.readFileSync(agentMediaActivityFile, 'utf8')).activities[0].updatedAt
      }]
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('chat queue API returns the current ordered agent workload', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-chat-queue-test-'));
  const incomingChatQueueFile = path.join(temporaryDirectory, 'incoming_chat_queue.json');
  const queueSnapshot = {
    active: {
      jid: '1001@s.whatsapp.net',
      name: 'Ali',
      position: 1,
      queuedAt: '2026-10-20T10:00:00.000Z',
      startedAt: '2026-10-20T10:00:06.000Z'
    },
    waiting: [{
      jid: '1002@s.whatsapp.net',
      name: 'Sara',
      position: 2,
      queuedAt: '2026-10-20T10:00:02.000Z'
    }],
    updatedAt: '2026-10-20T10:00:06.000Z'
  };
  fs.writeFileSync(incomingChatQueueFile, JSON.stringify(queueSnapshot));
  const server = createAdminDashboardServer({ incomingChatQueueFile });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/chat-queue`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), queueSnapshot);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('student workbook API reports current data and downloads an Excel file', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-student-workbook-test-'));
  const studentWorkbookFile = path.join(temporaryDirectory, 'students.xlsx');
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    studentWorkbookFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
    const statusResponse = await fetch(`${baseUrl}/student-workbook`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.state, 'ready');
    assert.ok(status.students > 0);

    const downloadResponse = await fetch(`${baseUrl}/student-workbook.xlsx`);
    assert.equal(downloadResponse.status, 200);
    assert.match(
      downloadResponse.headers.get('content-type'),
      /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await downloadResponse.arrayBuffer()));
    assert.ok(workbook.getWorksheet('Students'));
    assert.ok(workbook.getWorksheet('Conversation History'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard event stream pushes contact gender updates', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-events-test-'));
  const contactGenderFile = path.join(temporaryDirectory, 'contact_gender.json');
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    contactGenderFile
  });
  const controller = new AbortController();
  let reader;

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/events`,
      { signal: controller.signal }
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const initialEvent = decoder.decode((await reader.read()).value);
    assert.match(initialEvent, /event: connected/);

    fs.writeFileSync(contactGenderFile, JSON.stringify({ '1001': 'female' }));
    const update = await Promise.race([
      reader.read().then(result => decoder.decode(result.value)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for dashboard update.')), 2_000))
    ]);
    assert.match(update, /event: dashboard-update/);
    assert.match(update, /contact_gender\.json/);
  } finally {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('broadcast API queues only eligible recipients and supports stopping a queued job', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-broadcast-test-'));
  const server = createAdminDashboardServer({
    readData: () => ({
      ...sampleData,
      whatsappChatActivity: { '1001@s.whatsapp.net': 1_700_000_000 }
    }),
    broadcastFiles: {
      requests: path.join(temporaryDirectory, 'requests.json'),
      state: path.join(temporaryDirectory, 'state.json')
    }
  });

  test('broadcast API lists and queues non-Es tracked chats without accepting Es targets', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-non-es-broadcast-test-'));
    const regularJid = '1006@s.whatsapp.net';
    const data = {
      ...sampleData,
      contacts: {
        ...sampleData.contacts,
        [regularJid]: { name: 'Amina', isEs: false, savedInAddressBook: false }
      },
      history: {
        ...sampleData.history,
        [regularJid]: [{ role: 'client', text: 'Please help', timestamp: 1_700_000_000 }]
      }
    };
    const server = createAdminDashboardServer({
      readData: () => data,
      broadcastFiles: {
        requests: path.join(temporaryDirectory, 'requests.json'),
        state: path.join(temporaryDirectory, 'state.json')
      }
    });

    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const recipientsResponse = await fetch(
        `${origin}/api/admin/broadcast-recipients?recipientType=non-es&limit=5000`
      );
      assert.equal(recipientsResponse.status, 200);
      const recipients = await recipientsResponse.json();
      assert.ok(recipients.contacts.some(contact => contact.jid === regularJid));
      assert.ok(!recipients.contacts.some(contact => contact.jid === '1001@s.whatsapp.net'));
      assert.ok(!recipients.contacts.some(contact => contact.jid === '1005@s.whatsapp.net'));

      const url = `${origin}/api/admin/broadcasts`;
      const mismatchedResponse = await fetch(url, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Hello',
          jids: ['1001@s.whatsapp.net'],
          recipientType: 'non-es'
        })
      });
      assert.equal(mismatchedResponse.status, 400);

      const queuedResponse = await fetch(url, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Hello Amina',
          jids: [regularJid],
          recipientType: 'non-es'
        })
      });
      assert.equal(queuedResponse.status, 202);
      const requests = JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'requests.json'), 'utf8'));
      assert.equal(requests[0].recipientType, 'non-es');
      assert.deepEqual(requests[0].jids, [regularJid]);
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('direct-message API queues a message for a selected chat and rejects opted-out chats', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-message-test-'));
    const messageRequestsFile = path.join(temporaryDirectory, 'messages.json');
    const stateFile = path.join(temporaryDirectory, 'state.json');
    let data = sampleData;
    const server = createAdminDashboardServer({
      readData: () => data,
      messageRequestsFile,
      broadcastFiles: {
        requests: path.join(temporaryDirectory, 'broadcasts.json'),
        state: stateFile
      }
    });

    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = `${origin}/api/admin/messages`;
      const denied = await fetch(url, {
        method: 'POST',
        headers: { Origin: 'http://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid: '1001@s.whatsapp.net', text: 'Hello Ali' })
      });
      assert.equal(denied.status, 403);

      data = { ...sampleData, optedOutJids: ['1001@s.whatsapp.net'] };
      const optedOutResponse = await fetch(url, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jid: '1001@s.whatsapp.net', text: 'Hello Ali' })
      });
      assert.equal(optedOutResponse.status, 400);
      assert.match((await optedOutResponse.json()).error, /opted out/);

      data = {
        ...sampleData,
        contacts: {
          ...sampleData.contacts,
          '1001@s.whatsapp.net': { ...sampleData.contacts['1001@s.whatsapp.net'], ownerBlocked: true }
        }
      };
      const ownerBlockedResponse = await fetch(url, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid: '1001@s.whatsapp.net', text: 'Hello Ali' })
      });
      assert.equal(ownerBlockedResponse.status, 400);
      assert.match((await ownerBlockedResponse.json()).error, /blocked by the owner/);

      data = sampleData;
      const queuedResponse = await fetch(url, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid: '1001@s.whatsapp.net', text: '  Hello Ali  ' })
      });
      assert.equal(queuedResponse.status, 202);
      const queued = await queuedResponse.json();
      const requests = JSON.parse(fs.readFileSync(messageRequestsFile, 'utf8'));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].jid, '1001@s.whatsapp.net');
      assert.equal(requests[0].text, 'Hello Ali');

      const statusResponse = await fetch(`${url}?jid=1001%40s.whatsapp.net`);
      assert.deepEqual((await statusResponse.json()).messages[0], {
        id: queued.id,
        status: 'queued',
        createdAt: queued.createdAt
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/api/admin/broadcasts`;
    const origin = `http://127.0.0.1:${address.port}`;
    const denied = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'http://example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', jids: ['1001@s.whatsapp.net'] })
    });
    assert.equal(denied.status, 403);

    const recipientsResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/admin/broadcast-recipients?limit=5000&date=2023-11-14&timeZone=UTC`
    );
    const recipients = await recipientsResponse.json();
    assert.equal(recipients.total, 1);
    assert.equal(recipients.contacts[0].jid, '1001@s.whatsapp.net');
    assert.equal(recipients.contacts[0].lastIncomingAt, 1_700_000_000_000);
    assert.equal(recipients.contacts[0].lastActivityAt, 1_700_000_000_000);

    const ineligibleResponse = await fetch(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', jids: ['1003@s.whatsapp.net'] })
    });
    assert.equal(ineligibleResponse.status, 400);

    const queuedResponse = await fetch(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello students', jids: ['1001@s.whatsapp.net'] })
    });
    assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json();
    assert.equal(queued.total, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'requests.json'), 'utf8')).length, 1);

    const statusResponse = await fetch(url);
    assert.equal((await statusResponse.json()).jobs[0].status, 'queued');

    const cancelResponse = await fetch(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', id: queued.id })
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await fetch(url);
    assert.equal((await cancelled.json()).jobs[0].status, 'cancelled');

    const datedQueueResponse = await fetch(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Follow up',
        jids: ['1001@s.whatsapp.net'],
        activityDate: '2023-11-14',
        activityTimeZone: 'UTC'
      })
    });
    assert.equal(datedQueueResponse.status, 202);
    const queuedRequests = JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'requests.json'), 'utf8'));
    assert.deepEqual(queuedRequests[1].activityAt, {
      '1001@s.whatsapp.net': 1_700_000_000_000
    });
    assert.equal(queuedRequests[1].activityDate, '2023-11-14');
    assert.equal(queuedRequests[1].activityTimeZone, 'UTC');

    const mismatchedDateResponse = await fetch(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Follow up',
        jids: ['1001@s.whatsapp.net'],
        activityDate: '2023-11-13',
        activityTimeZone: 'UTC'
      })
    });
    assert.equal(mismatchedDateResponse.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
