import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendAgentLog } from './agent_runtime.js';
import { writeAgentQr } from './agent_status.js';
import {
  createAdminDashboardServer,
  getDashboardAgentStatus,
  getDashboardConversation,
  getDashboardOverview,
  getDashboardStudentActivity,
  listDashboardChats,
  listDashboardEsContacts
} from './admin_dashboard.js';

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
    '1005@s.whatsapp.net': { name: 'Non-Es Saved', isEs: false, savedInAddressBook: true }
  },
  progress: {
    '1001@s.whatsapp.net': { grade: 'grade_3_secondary', currentLessonIndex: 0, status: 'awaiting_task', deliveredAt: '2026-10-15T10:00:00.000Z' }
  },
  lessons: {
    grade_3_secondary: { name: 'Third Secondary', lessons: [{ title: 'Lesson One' }] }
  }
};

test('overview counts direct chats and lesson states only', () => {
  assert.deepEqual(getDashboardOverview(sampleData, 1_700_000_500), {
    totalChats: 2,
    activeToday: 2,
    handledChats: 1,
    esContacts: 1,
    studentsWithProgress: 1,
    awaitingTask: 1,
    awaitingReattempt: 0,
    completed: 0,
    configuredLessons: 1
  });
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
  const server = createAdminDashboardServer({ readData: () => sampleData });

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
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('conversation detail returns recent messages and rejects non-direct chat IDs', () => {
  const conversation = getDashboardConversation(sampleData, '1001@s.whatsapp.net');
  assert.equal(conversation.name, 'Ali');
  assert.equal(conversation.messages.length, 2);
  assert.equal(getDashboardConversation(sampleData, '1003@g.us'), null);
  assert.equal(getDashboardConversation(sampleData, 'missing@s.whatsapp.net'), null);
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
    canMessage: true
  });

  assert.equal(listDashboardEsContacts(sampleData, '1001').total, 1);
  assert.equal(listDashboardEsContacts(sampleData, 'not found').total, 0);
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
  } finally {
    await new Promise(resolve => server.close(resolve));
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

test('broadcast API queues only eligible recipients and supports stopping a queued job', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-broadcast-test-'));
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    broadcastFiles: {
      requests: path.join(temporaryDirectory, 'requests.json'),
      state: path.join(temporaryDirectory, 'state.json')
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
      `http://127.0.0.1:${address.port}/api/admin/broadcast-recipients?limit=5000`
    );
    const recipients = await recipientsResponse.json();
    assert.equal(recipients.total, 1);
    assert.equal(recipients.contacts[0].jid, '1001@s.whatsapp.net');

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
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
