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
  createDashboardDataCache,
  createAdminDashboardServer as createAuthenticatedDashboardServer,
  getDashboardAgentStatus,
  getDashboardTelegramAgentStatus,
  getDashboardConversation,
  getNextLessonToSkip,
  getDashboardOverview,
  listDashboardStudentProgress,
  getDashboardStudentActivity,
  getDashboardWeeklyChatActivity,
  listRecentAgentMessages,
  listDashboardChats,
  listDashboardEsContacts
} from './admin_dashboard.js';
import { createContactPaymentLabelsStore } from './contact_payment_labels.js';
import { config } from './config.js';
import { WhatsAppPresenceManager } from './whatsapp_presence.js';
import { createScheduledLessonStore } from './scheduled_lessons.js';

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

test('dashboard data cache reuses a snapshot and reloads when a source file changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-data-cache-'));
  const sourceFile = path.join(directory, 'source.json');
  fs.writeFileSync(sourceFile, '{"revision":1}', 'utf8');
  let loadCount = 0;
  const readCachedData = createDashboardDataCache(() => {
    loadCount += 1;
    return fs.existsSync(sourceFile)
      ? JSON.parse(fs.readFileSync(sourceFile, 'utf8'))
      : { revision: 0 };
  }, [sourceFile]);

  try {
    const initial = readCachedData();
    assert.strictEqual(readCachedData(), initial);
    assert.equal(loadCount, 1);

    fs.writeFileSync(sourceFile, '{"revision":2}', 'utf8');
    const updated = readCachedData();
    assert.notStrictEqual(updated, initial);
    assert.equal(updated.revision, 2);
    assert.strictEqual(readCachedData(), updated);
    assert.equal(loadCount, 2);

    fs.rmSync(sourceFile);
    assert.deepEqual(readCachedData(), { revision: 0 });
    assert.equal(loadCount, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

test('student progress identifies a configured next lesson for WhatsApp and Telegram learners', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-skip-lesson-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const videoFile = path.join(directory, 'lesson_2.mp4');
  fs.writeFileSync(videoFile, 'video');
  const lessons = {
    grade_3_secondary: {
      name: 'Third Secondary',
      lessons: [
        { id: 'lesson_1', title: 'Lesson One' },
        {
          id: 'lesson_2',
          title: 'Lesson Two',
          videoFile,
          taskMessage: 'Answer this question.',
          answerKey: ['Correct answer']
        }
      ]
    }
  };
  const data = {
    ...sampleData,
    lessons,
    progress: {
      '1001@s.whatsapp.net': {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_task'
      }
    },
    telegramProgress: {
      'telegram:-100123:44': {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_reattempt',
        telegramChatId: '-100123',
        telegramUserId: 44
      }
    }
  };

  const progress = listDashboardStudentProgress(data);
  assert.deepEqual(progress.students.map(student => ({
    platform: student.platform,
    canSkip: student.canSkipToNextLesson,
    nextLessonId: student.nextLessonId,
    nextLessonTitle: student.nextLessonTitle
  })), [
    { platform: 'WhatsApp', canSkip: true, nextLessonId: 'lesson_2', nextLessonTitle: 'Lesson Two' },
    { platform: 'Telegram', canSkip: true, nextLessonId: 'lesson_2', nextLessonTitle: 'Lesson Two' }
  ]);
  assert.equal(getNextLessonToSkip({ ...data.progress['1001@s.whatsapp.net'], status: 'consulting' }, lessons), null);
  assert.equal(getNextLessonToSkip({
    ...data.progress['1001@s.whatsapp.net'],
    currentLessonId: 'lesson_2'
  }, lessons), null);
});

test('dashboard queues validated lesson skips for both platforms and exposes queue state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-skip-api-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const videoFile = path.join(directory, 'lesson_2.mp4');
  const whatsappQueueFile = path.join(directory, 'whatsapp-skip.json');
  const telegramQueueFile = path.join(directory, 'telegram-skip.json');
  const agentStatusFile = path.join(directory, 'agent_status.json');
  fs.writeFileSync(videoFile, 'video');
  fs.writeFileSync(agentStatusFile, JSON.stringify({
    connectionState: 'connected',
    updatedAt: new Date().toISOString()
  }));
  const data = {
    ...sampleData,
    lessons: {
      grade_3_secondary: {
        name: 'Third Secondary',
        lessons: [
          { id: 'lesson_1', title: 'Lesson One' },
          {
            id: 'lesson_2',
            title: 'Lesson Two',
            videoFile,
            taskMessage: 'Answer this question.',
            answerKey: ['Correct answer']
          }
        ]
      }
    },
    progress: {
      '1001@s.whatsapp.net': {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_task'
      }
    },
    telegramProgress: {
      'telegram:-100123:44': {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_task',
        telegramChatId: '-100123',
        telegramUserId: 44
      }
    }
  };
  const server = createAdminDashboardServer({
    readData: () => data,
    agentStatusFile,
    whatsappLessonSkipRequestsFile: whatsappQueueFile,
    telegramLessonSkipRequestsFile: telegramQueueFile
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const postSkip = (platform, jid, currentLessonId = 'lesson_1', includeOrigin = true) =>
    fetch(`${origin}/api/admin/progress/skip-lesson`, {
      method: 'POST',
      headers: {
        ...(includeOrigin ? { Origin: origin } : {}),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ platform, jid, currentLessonId })
    });

  const denied = await postSkip('WhatsApp', '1001@s.whatsapp.net', 'lesson_1', false);
  assert.equal(denied.status, 403);
  assert.equal(fs.existsSync(whatsappQueueFile), false);

  const whatsappResponse = await postSkip('WhatsApp', '1001@s.whatsapp.net');
  assert.equal(whatsappResponse.status, 202);
  assert.equal((await whatsappResponse.json()).status, 'queued');
  assert.equal(JSON.parse(fs.readFileSync(whatsappQueueFile, 'utf8'))[0].nextLessonId, 'lesson_2');

  const telegramResponse = await postSkip('Telegram', 'telegram:-100123:44');
  assert.equal(telegramResponse.status, 202);
  assert.equal((await telegramResponse.json()).status, 'queued');
  assert.equal(JSON.parse(fs.readFileSync(telegramQueueFile, 'utf8'))[0].chatId, '-100123');

  const progressResponse = await fetch(`${origin}/api/admin/progress`);
  assert.equal(progressResponse.status, 200);
  const progress = await progressResponse.json();
  assert.equal(progress.students.find(student => student.platform === 'WhatsApp').skipRequest.status, 'queued');
  assert.equal(progress.students.find(student => student.platform === 'Telegram').skipRequest.status, 'queued');

  data.progress['1001@s.whatsapp.net'].currentLessonId = 'lesson_2';
  data.progress['1001@s.whatsapp.net'].currentLessonIndex = 1;
  const stale = await postSkip('WhatsApp', '1001@s.whatsapp.net');
  assert.equal(stale.status, 409);
});

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
        { date: '2023-11-08', day: 'Wed', chats: 0, newChats: 0, telegramActiveStudents: 0 },
        { date: '2023-11-09', day: 'Thu', chats: 0, newChats: 0, telegramActiveStudents: 0 },
        { date: '2023-11-10', day: 'Fri', chats: 0, newChats: 0, telegramActiveStudents: 0 },
        { date: '2023-11-11', day: 'Sat', chats: 0, newChats: 0, telegramActiveStudents: 0 },
        { date: '2023-11-12', day: 'Sun', chats: 0, newChats: 0, telegramActiveStudents: 0 },
        { date: '2023-11-13', day: 'Mon', chats: 0, newChats: 0, telegramActiveStudents: 0 },
        { date: '2023-11-14', day: 'Tue', chats: 2, newChats: 2, telegramActiveStudents: 0 }
      ]
    },
    studentsWithProgress: 1,
    awaitingTask: 1,
    awaitingReattempt: 0,
    completed: 0,
    telegramStudents: 0,
    telegramJoinedToday: 0,
    telegramJoinedLast7Days: 0,
    telegramDailyJoins: [
      { date: '2023-11-08', students: 0 },
      { date: '2023-11-09', students: 0 },
      { date: '2023-11-10', students: 0 },
      { date: '2023-11-11', students: 0 },
      { date: '2023-11-12', students: 0 },
      { date: '2023-11-13', students: 0 },
      { date: '2023-11-14', students: 0 }
    ],
    configuredLessons: 1
  });
});

test('overview and student progress report Telegram learner joins and lesson activity', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const nowSeconds = Math.floor(now / 1000);
  const day = 24 * 60 * 60 * 1000;
  const data = {
    ...sampleData,
    telegramProgress: {
      'telegram:-100123:41': {
        name: 'Amina Telegram',
        telegramChatId: '-100123',
        telegramUserId: 41,
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_task',
        joinedAt: new Date(now).toISOString(),
        groupJoinedAt: new Date(now).toISOString(),
        deliveredAt: new Date(now).toISOString(),
        lastActivityAt: new Date(now).toISOString(),
        submissionsReceived: 2,
        lessonsCompleted: 1,
        activityTimestamps: [
          new Date(now - day).toISOString(),
          new Date(now).toISOString()
        ]
      },
      'telegram:-100123:42': {
        name: 'Musa Telegram',
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_reattempt',
        groupJoinedAt: new Date(now - day).toISOString(),
        deliveredAt: new Date(now - day).toISOString(),
        submissionsReceived: 1,
      }
    }
  };

  const overview = getDashboardOverview(data, nowSeconds, 'UTC');
  assert.equal(overview.studentsWithProgress, 3);
  assert.equal(overview.awaitingTask, 2);
  assert.equal(overview.awaitingReattempt, 1);
  assert.equal(overview.telegramStudents, 2);
  assert.equal(overview.telegramJoinedToday, 1);
  assert.equal(overview.telegramJoinedLast7Days, 2);
  assert.equal(overview.telegramDailyJoins.at(-1).students, 1);
  assert.equal(overview.telegramDailyJoins.at(-2).students, 1);

  const progress = listDashboardStudentProgress(data, nowSeconds, 'UTC');
  assert.equal(progress.total, 3);
  const telegram = progress.students.filter(student => student.platform === 'Telegram');
  assert.deepEqual(telegram.map(student => student.name).sort(), ['Amina Telegram', 'Musa Telegram']);
  const amina = telegram.find(student => student.name === 'Amina Telegram');
  assert.equal(amina.totalIncomingMessages, 2);
  assert.equal(amina.incomingMessagesLast7Days, 2);
  assert.equal(amina.activeDaysLast30Days, 2);
  assert.equal(amina.lessonsCompleted, 1);
  assert.equal(progress.insights.engagementTrend.at(-1).telegramActiveStudents, 1);
  assert.equal(progress.insights.engagementTrend.at(-2).telegramActiveStudents, 2);
  assert.equal(progress.insights.telegramEnrollment.joinedToday, 1);
  assert.equal(progress.insights.telegramEnrollment.joinedLast7Days, 2);
  assert.equal(progress.insights.engagementTrend.at(-1).activeStudents, 1);
  const musa = telegram.find(student => student.name === 'Musa Telegram');
  assert.equal(musa.joinedAt, new Date(now - day).toISOString());
  assert.equal(musa.incomingMessagesLast7Days, 1);
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
      { date: '2026-10-10', day: 'Sat', chats: 2, newChats: 2, telegramActiveStudents: 0 },
      { date: '2026-10-11', day: 'Sun', chats: 0, newChats: 0, telegramActiveStudents: 0 },
      { date: '2026-10-12', day: 'Mon', chats: 1, newChats: 0, telegramActiveStudents: 0 },
      { date: '2026-10-13', day: 'Tue', chats: 0, newChats: 0, telegramActiveStudents: 0 },
      { date: '2026-10-14', day: 'Wed', chats: 0, newChats: 0, telegramActiveStudents: 0 },
      { date: '2026-10-15', day: 'Thu', chats: 0, newChats: 0, telegramActiveStudents: 0 },
      { date: '2026-10-16', day: 'Fri', chats: 1, newChats: 0, telegramActiveStudents: 0 }
    ]
  });
});

test('weekly dashboard activity counts distinct Telegram learners per local calendar day', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const activity = getDashboardWeeklyChatActivity({
    ...sampleData,
    telegramProgress: {
      'telegram:-100123:41': {
        activityTimestamps: [
          '2026-10-10T09:00:00.000Z',
          '2026-10-10T10:00:00.000Z',
          '2026-10-12T12:00:00.000Z'
        ]
      },
      'telegram:-100123:42': {
        activityTimestamps: ['2026-10-10T11:00:00.000Z']
      },
      'telegram:-100123:43': {
        deliveredAt: '2026-10-15T12:00:00.000Z'
      },
      'telegram:-100123:44': {
        deliveredAt: '2026-10-09T12:00:00.000Z'
      }
    }
  }, 'UTC', now);

  assert.deepEqual(
    activity.days.map(day => day.telegramActiveStudents),
    [2, 0, 1, 0, 0, 1, 0]
  );
});

test('weekly dashboard activity counts a returning chat once as new across linked phone and LID histories', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const activity = getDashboardWeeklyChatActivity({
    ...sampleData,
    contacts: {
      ...sampleData.contacts,
      '2001@s.whatsapp.net': { name: 'New student' },
      '9001@lid': { jid: '2001@s.whatsapp.net' },
      '2002@s.whatsapp.net': { name: 'Returning student' }
    },
    history: {
      '2001@s.whatsapp.net': [
        { role: 'client', text: 'Joined', timestamp: Date.parse('2026-10-10T10:00:00.000Z') }
      ],
      '9001@lid': [
        { role: 'client', text: 'Returned', timestamp: Date.parse('2026-10-12T10:00:00.000Z') }
      ],
      '2002@s.whatsapp.net': [
        { role: 'client', text: 'Older conversation', timestamp: Date.parse('2026-10-03T10:00:00.000Z') },
        { role: 'client', text: 'Returned this week', timestamp: Date.parse('2026-10-15T10:00:00.000Z') }
      ]
    }
  }, 'UTC', now);

  assert.equal(activity.days[0].chats, 1);
  assert.equal(activity.days[0].newChats, 1);
  assert.equal(activity.days[2].chats, 1);
  assert.equal(activity.days[2].newChats, 0);
  assert.equal(activity.days[5].chats, 1);
  assert.equal(activity.days[5].newChats, 0);
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
  assert.equal(losAngeles.days.at(-1).newChats, 1);
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

test('student progress insights show calendar-day engagement and stale lesson follow-ups', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  const day = 24 * 60 * 60 * 1000;
  const result = listDashboardStudentProgress({
    ...sampleData,
    contacts: {
      ...sampleData.contacts,
      '1001@lid': {
        jid: '1001@s.whatsapp.net',
        phoneJid: '1001@s.whatsapp.net',
        name: 'Ali LID'
      },
      '2001@s.whatsapp.net': { name: 'Needs support' },
      '2002@s.whatsapp.net': { name: 'Recently delivered' },
      '2003@s.whatsapp.net': { name: 'Recently replied' }
    },
    progress: {
      ...sampleData.progress,
      '2001@s.whatsapp.net': {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        status: 'awaiting_task',
        deliveredAt: new Date(now - 9 * day).toISOString()
      },
      '2002@s.whatsapp.net': {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        status: 'awaiting_task',
        deliveredAt: new Date(now - 6 * day).toISOString()
      },
      '2003@s.whatsapp.net': {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        status: 'awaiting_reattempt',
        deliveredAt: new Date(now - 10 * day).toISOString()
      }
    },
    history: {
      ...sampleData.history,
      '1001@lid': [
        { role: 'client', text: 'Yesterday', timestamp: (now - day) / 1000 },
        { role: 'client', text: 'Another message today', timestamp: now / 1000 }
      ],
      '2003@s.whatsapp.net': [
        { role: 'client', text: 'I tried again', timestamp: (now - 5 * day) / 1000 }
      ]
    }
  }, now, 'UTC');

  assert.equal(result.insights.activeStudentsLast7Days, 2);
  const today = result.insights.engagementTrend.at(-1);
  assert.deepEqual(today, {
    date: '2026-10-16',
    activeStudents: 1,
    telegramActiveStudents: 0,
    incomingMessages: 1
  });
  assert.deepEqual(result.insights.followUpStudents.map(student => ({
    jid: student.jid,
    daysSinceActivity: student.daysSinceActivity
  })), [{ jid: '2001@s.whatsapp.net', daysSinceActivity: 9 }]);
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

test('conversation detail merges linked WhatsApp histories and pages older messages', () => {
  const phoneJid = '249000000030@s.whatsapp.net';
  const lidJid = '100000000000030@lid';
  const data = {
    ...sampleData,
    history: {
      ...sampleData.history,
      [phoneJid]: [
        { id: 'first', role: 'client', text: 'First question', timestamp: 1_700_000_000_000 },
        { id: 'reply', role: 'agent', text: 'First answer', timestamp: 1_700_000_001_000 }
      ],
      [lidJid]: [
        { id: 'reply', role: 'agent', text: 'First answer', timestamp: 1_700_000_001_000 },
        { id: 'latest', role: 'client', text: 'Follow-up question', timestamp: 1_700_000_002_000 }
      ]
    },
    contacts: {
      ...sampleData.contacts,
      [phoneJid]: { jid: phoneJid, phoneJid, name: 'Linked student', isEs: true },
      [lidJid]: { jid: lidJid, phoneJid, name: 'Linked student', isEs: true }
    }
  };

  const latestPage = getDashboardConversation(data, lidJid, 0, 2);
  assert.equal(latestPage.totalMessages, 3);
  assert.equal(latestPage.hasMore, true);
  assert.deepEqual(latestPage.messages.map(message => message.text), [
    'First answer',
    'Follow-up question'
  ]);

  const earlierPage = getDashboardConversation(data, lidJid, 2, 2);
  assert.equal(earlierPage.hasMore, false);
  assert.deepEqual(earlierPage.messages.map(message => message.text), ['First question']);
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
    const banResult = await banResponse.json();
    assert.equal(banResult.name, 'Es Test Student');
    assert.equal(banResult.reason, 'banned');

    let contactsResponse = await fetch(`${baseUrl}/api/admin/es-contacts`);
    let dashboardContacts = await contactsResponse.json();
    assert.equal(dashboardContacts.contacts[0].canMessage, false);
    assert.equal(dashboardContacts.contacts[0].block.reason, 'banned');
    let blockedContacts = (await (await fetch(`${baseUrl}/api/admin/blocked-contacts`)).json())
      .blockedNumbers;
    assert.deepEqual(blockedContacts.map(record => record.number), ['249111111111']);
    assert.equal(blockedContacts[0].name, 'Es Test Student');

    const deleteResponse = await fetch(numberUrl, {
      method: 'DELETE',
      headers: { Origin: origin }
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json()).removedContacts, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(contactsFile, 'utf8')), {});
    blockedContacts = (await (await fetch(`${baseUrl}/api/admin/blocked-contacts`)).json())
      .blockedNumbers;
    assert.equal(blockedContacts[0].reason, 'deleted');
    assert.equal(blockedContacts[0].name, 'Es Test Student');

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

test('Es contacts API does not treat student-reported claims as confirmed payments', async () => {
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
    readContacts: () => data.contacts,
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
    assert.equal(paidContact.paid, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard lists and reviews rolling student payment-ledger records', async t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-payment-ledger-test-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const paymentLedgerFile = path.join(temporaryDirectory, 'student_payment_ledger.json');
  const enrolledAt = '2026-01-01T12:00:00.000Z';
  const studentKey = '1001@s.whatsapp.net';
  const data = {
    ...sampleData,
    progress: {
      [studentKey]: {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        status: 'awaiting_task',
        enrolledAt,
        deliveredAt: enrolledAt
      }
    }
  };
  const server = createAdminDashboardServer({
    readData: () => data,
    paymentLedgerFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ledgerUrl = `${origin}/api/admin/payment-ledger`;
    const initialResponse = await fetch(ledgerUrl);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.students.length, 1);
    assert.equal(initial.students[0].studentKey, studentKey);
    assert.equal(initial.students[0].payment.status, 'unpaid');

    const deniedResponse = await fetch(ledgerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentKey, status: 'paid' })
    });
    assert.equal(deniedResponse.status, 403);

    const reviewResponse = await fetch(ledgerUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentKey,
        status: 'paid',
        amount: 17000,
        currency: 'SDG'
      })
    });
    assert.equal(reviewResponse.status, 200);
    const reviewed = await reviewResponse.json();
    assert.equal(reviewed.payment.status, 'paid');
    assert.equal(reviewed.payment.amount, 17000);
    assert.equal(reviewed.payment.currency, 'SDG');

    const invalidResponse = await fetch(ledgerUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentKey, status: 'verified' })
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
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
    readContacts: () => data.contacts,
    paymentLabelsFile
  });

  test('dashboard lists and manages student-confirmed lesson schedules', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-scheduled-lessons-'));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    const scheduledLessonsFile = path.join(temporaryDirectory, 'scheduled_lessons.json');
    const store = createScheduledLessonStore({ filePath: scheduledLessonsFile });
    const schedule = store.create({
      jid: '1001@s.whatsapp.net',
      phoneJid: '1001@s.whatsapp.net',
      studentName: 'Ali',
      gradeKey: 'grade_3_secondary',
      lessonIndex: 0,
      lessonId: 'lesson_1',
      lessonTitle: 'Lesson One',
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString()
    });
    const server = createAdminDashboardServer({
      readData: () => sampleData,
      scheduledLessonsFile
    });

    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const listResponse = await fetch(`${origin}/api/admin/scheduled-lessons`);
      assert.equal(listResponse.status, 200);
      assert.equal((await listResponse.json()).schedules[0].id, schedule.id);

      const denied = await fetch(`${origin}/api/admin/scheduled-lessons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id: schedule.id })
      });
      assert.equal(denied.status, 403);

      const rescheduledAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
      const editResponse = await fetch(`${origin}/api/admin/scheduled-lessons`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reschedule',
          id: schedule.id,
          scheduledAt: rescheduledAt
        })
      });
      assert.equal(editResponse.status, 200);
      assert.equal((await editResponse.json()).schedule.scheduledAt, rescheduledAt);

      const sendNowResponse = await fetch(`${origin}/api/admin/scheduled-lessons`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send_now', id: schedule.id })
      });
      assert.equal(sendNowResponse.status, 200);
      assert.equal((await sendNowResponse.json()).schedule.status, 'scheduled');

      const cancelResponse = await fetch(`${origin}/api/admin/scheduled-lessons`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id: schedule.id })
      });
      assert.equal(cancelResponse.status, 200);
      assert.equal((await cancelResponse.json()).schedule.status, 'cancelled');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
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
    const paidResult = await paidResponse.json();
    assert.equal(paidResult.label.source, 'manual');

    const paymentCalendarResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/payment-calendar`
    );
    assert.equal(paymentCalendarResponse.status, 200);
    assert.deepEqual(await paymentCalendarResponse.json(), {
      payments: [{
        phoneNumber,
        jid: `${phoneNumber}@s.whatsapp.net`,
        studentName: 'Manual Es Student',
        paidAt: paidResult.label.paymentHistory[0].paidAt
      }]
    });

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

test('manual lesson scheduling exposes eligible choices and creates only validated future schedules', async t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-manual-schedule-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const mediaDirectory = path.join(temporaryDirectory, 'lesson-media');
  fs.mkdirSync(mediaDirectory);
  const videoPath = path.join(mediaDirectory, 'lesson-1.mp4');
  fs.writeFileSync(videoPath, 'video');
  const lessonsFile = path.join(temporaryDirectory, 'lessons.json');
  const progressFile = path.join(temporaryDirectory, 'student_progress.json');
  const scheduledLessonsFile = path.join(temporaryDirectory, 'scheduled_lessons.json');
  fs.writeFileSync(lessonsFile, JSON.stringify({
    grade_3_secondary: {
      name: 'Third Secondary',
      lessons: [{
        id: 'lesson_1',
        title: 'Lesson One',
        videoFile: videoPath,
        taskMessage: 'Answer the question.',
        answerKey: ['Correct answer']
      }]
    }
  }));
  fs.writeFileSync(progressFile, JSON.stringify({
    '249123456789@s.whatsapp.net': { grade: 'grade_3_secondary' }
  }));
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    readContacts: () => ({
      '249123456789@s.whatsapp.net': { name: 'Manual Student' }
    }),
    lessonsFile,
    lessonMediaDirectory: mediaDirectory,
    progressFile,
    scheduledLessonsFile
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const optionsResponse = await fetch(`${origin}/api/admin/scheduled-lessons/options`);
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json();
  assert.deepEqual(options.students, [{
    jid: '249123456789@s.whatsapp.net',
    phoneJid: '249123456789@s.whatsapp.net',
    name: 'Manual Student',
    gradeKey: 'grade_3_secondary'
  }]);
  assert.equal(options.lessons.length, 1);
  assert.equal(options.lessons[0].lessonId, 'lesson_1');
  assert.equal(options.lessons[0].gradeName, 'Third Secondary');

  const deniedResponse = await fetch(`${origin}/api/admin/scheduled-lessons/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(deniedResponse.status, 403);

  const response = await fetch(`${origin}/api/admin/scheduled-lessons/manual`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jid: '249123456789@s.whatsapp.net',
      gradeKey: 'grade_3_secondary',
      lessonId: 'lesson_1',
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString()
    })
  });
  assert.equal(response.status, 201);
  const { schedule } = await response.json();
  assert.equal(schedule.studentName, 'Manual Student');
  assert.equal(schedule.lessonTitle, 'Lesson One');
  assert.equal(schedule.lessonIndex, 0);
  assert.equal(schedule.status, 'scheduled');

  const invalidStudentResponse = await fetch(`${origin}/api/admin/scheduled-lessons/manual`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jid: '999999999999@s.whatsapp.net',
      gradeKey: 'grade_3_secondary',
      lessonId: 'lesson_1',
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString()
    })
  });
  assert.equal(invalidStudentResponse.status, 404);

  const invalidLessonResponse = await fetch(`${origin}/api/admin/scheduled-lessons/manual`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jid: '249123456789@s.whatsapp.net',
      gradeKey: 'grade_3_secondary',
      lessonId: 'unconfigured_lesson',
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString()
    })
  });
  assert.equal(invalidLessonResponse.status, 409);

  const pastTimeResponse = await fetch(`${origin}/api/admin/scheduled-lessons/manual`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jid: '249123456789@s.whatsapp.net',
      gradeKey: 'grade_3_secondary',
      lessonId: 'lesson_1',
      scheduledAt: new Date(Date.now() - 60 * 60_000).toISOString()
    })
  });
  assert.equal(pastTimeResponse.status, 409);
});

test('payment calendar loads without reading conversation history', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-payment-calendar-test-'));
  const paymentLabelsFile = path.join(temporaryDirectory, 'contact_payment_labels.json');
  const phoneNumber = '249123456789';
  createContactPaymentLabelsStore(paymentLabelsFile)
    .setManualStatus(phoneNumber, `${phoneNumber}@s.whatsapp.net`, 'paid');
  const server = createAdminDashboardServer({
    readData: () => {
      throw new Error('Conversation history should not be read for payment calendar data.');
    },
    readContacts: () => ({
      [`${phoneNumber}@s.whatsapp.net`]: { name: 'Calendar Student' }
    }),
    paymentLabelsFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/payment-calendar`
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.payments.length, 1);
    assert.equal(result.payments[0].studentName, 'Calendar Student');
    assert.equal(result.payments[0].phoneNumber, phoneNumber);
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
  assert.equal(connected.respondingEnabled, true);
  assert.equal(getDashboardAgentStatus({
    ...freshStatus,
    respondingEnabled: false
  }, 12, now).respondingEnabled, false);
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
      respondingEnabled: true,
      queuePaused: false,
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

test('Telegram agent status requires a fresh heartbeat and is exposed through the dashboard API', async t => {
  const now = Date.now();
  const connectedStatus = {
    connectionState: 'connected',
    botUsername: 'lesson_bot',
    lastConnectedAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 5_000).toISOString()
  };
  assert.deepEqual(getDashboardTelegramAgentStatus(connectedStatus, now), {
    connectionState: 'connected',
    connected: true,
    botUsername: 'lesson_bot',
    lastConnectedAt: connectedStatus.lastConnectedAt,
    lastHeartbeatAt: connectedStatus.updatedAt
  });
  assert.equal(getDashboardTelegramAgentStatus({
    ...connectedStatus,
    connectionState: 'retrying'
  }, now).connectionState, 'retrying');
  assert.equal(getDashboardTelegramAgentStatus({
    ...connectedStatus,
    updatedAt: new Date(now - 60_000).toISOString()
  }, now).connectionState, 'disconnected');
  assert.equal(getDashboardTelegramAgentStatus(null, now).connectionState, 'unknown');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-telegram-agent-status-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const telegramAgentStatusFile = path.join(directory, 'telegram_agent_status.json');
  fs.writeFileSync(telegramAgentStatusFile, JSON.stringify(connectedStatus));
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    telegramAgentStatusFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/telegram-agent-status`
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      connectionState: 'connected',
      connected: true,
      botUsername: 'lesson_bot',
      lastConnectedAt: connectedStatus.lastConnectedAt,
      lastHeartbeatAt: connectedStatus.updatedAt
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('dashboard reply-mode endpoint queues pause and resume for a connected agent', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-replies-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const agentControlFile = path.join(temporaryDirectory, 'agent_control.json');
  fs.writeFileSync(agentStatusFile, JSON.stringify({
    connectionState: 'connected',
    updatedAt: new Date().toISOString()
  }));
  const server = createAdminDashboardServer({ agentStatusFile, agentControlFile });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const requestMode = enabled => fetch(`${origin}/api/admin/agent-replies`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });

    const pauseResponse = await requestMode(false);
    assert.equal(pauseResponse.status, 202);
    assert.equal((await pauseResponse.json()).status, 'pausing_replies');
    assert.equal(JSON.parse(fs.readFileSync(agentControlFile, 'utf8')).action, 'pause_replies');

    const resumeResponse = await requestMode(true);
    assert.equal(resumeResponse.status, 202);
    assert.equal((await resumeResponse.json()).status, 'resuming_replies');
    assert.equal(JSON.parse(fs.readFileSync(agentControlFile, 'utf8')).action, 'resume_replies');

    const invalidResponse = await fetch(`${origin}/api/admin/agent-replies`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'false' })
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard chat queue control pauses and resumes handling only for a connected agent', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-chat-queue-control-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const agentControlFile = path.join(temporaryDirectory, 'agent_control.json');
  fs.writeFileSync(agentStatusFile, JSON.stringify({
    connectionState: 'connected',
    updatedAt: new Date().toISOString()
  }));
  const server = createAdminDashboardServer({ agentStatusFile, agentControlFile });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const setPaused = paused => fetch(`${origin}/api/admin/chat-queue-control`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused })
    });

    const pauseResponse = await setPaused(true);
    assert.equal(pauseResponse.status, 202);
    assert.equal((await pauseResponse.json()).status, 'pausing_queue');
    assert.equal(JSON.parse(fs.readFileSync(agentControlFile, 'utf8')).action, 'pause_queue');

    const resumeResponse = await setPaused(false);
    assert.equal(resumeResponse.status, 202);
    assert.equal((await resumeResponse.json()).status, 'resuming_queue');
    assert.equal(JSON.parse(fs.readFileSync(agentControlFile, 'utf8')).action, 'resume_queue');

    const invalidResponse = await fetch(`${origin}/api/admin/chat-queue-control`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: 'true' })
    });
    assert.equal(invalidResponse.status, 400);

    fs.writeFileSync(agentStatusFile, JSON.stringify({
      connectionState: 'disconnected',
      updatedAt: new Date().toISOString()
    }));
    const disconnectedResponse = await setPaused(true);
    assert.equal(disconnectedResponse.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard cancels waiting chats but does not allow cancelling the active chat', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-chat-queue-cancel-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const agentControlFile = path.join(temporaryDirectory, 'agent_control.json');
  const incomingChatQueueFile = path.join(temporaryDirectory, 'incoming_chat_queue.json');
  fs.writeFileSync(agentStatusFile, JSON.stringify({
    connectionState: 'connected',
    updatedAt: new Date().toISOString()
  }));
  fs.writeFileSync(incomingChatQueueFile, JSON.stringify({
    active: { jid: '1001@s.whatsapp.net', name: 'Ali', position: 1 },
    waiting: [{ jid: '1002@s.whatsapp.net', name: 'Sara', position: 2 }],
    paused: false,
    updatedAt: new Date().toISOString()
  }));
  const server = createAdminDashboardServer({
    agentStatusFile,
    agentControlFile,
    incomingChatQueueFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const cancel = jid => fetch(`${origin}/api/admin/chat-queue-cancel`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid })
    });

    const waitingResponse = await cancel('1002@s.whatsapp.net');
    assert.equal(waitingResponse.status, 202);
    assert.equal((await waitingResponse.json()).status, 'cancellation_requested');
    assert.deepEqual(JSON.parse(fs.readFileSync(agentControlFile, 'utf8')).jid, '1002@s.whatsapp.net');

    const activeResponse = await cancel('1001@s.whatsapp.net');
    assert.equal(activeResponse.status, 409);
    assert.match((await activeResponse.json()).error, /already being handled/);

    const invalidResponse = await cancel('1003@g.us');
    assert.equal(invalidResponse.status, 400);

    fs.writeFileSync(agentStatusFile, JSON.stringify({
      connectionState: 'disconnected',
      updatedAt: new Date().toISOString()
    }));
    const disconnectedResponse = await cancel('1002@s.whatsapp.net');
    assert.equal(disconnectedResponse.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard disconnect endpoint queues a stop request only for a live agent', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-disconnect-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const agentControlFile = path.join(temporaryDirectory, 'agent_control.json');
  fs.writeFileSync(agentStatusFile, JSON.stringify({
    connectionState: 'connected',
    updatedAt: new Date().toISOString()
  }));
  const server = createAdminDashboardServer({
    agentStatusFile,
    agentControlFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/admin/agent-disconnect`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'disconnecting');
    assert.deepEqual(JSON.parse(fs.readFileSync(agentControlFile, 'utf8')).action, 'disconnect');

    fs.writeFileSync(agentStatusFile, JSON.stringify({
      connectionState: 'disconnected',
      updatedAt: new Date().toISOString()
    }));
    const disconnectedResponse = await fetch(`${origin}/api/admin/agent-disconnect`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    assert.equal(disconnectedResponse.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard can request older chat history only while the agent is connected', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-history-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const agentControlFile = path.join(temporaryDirectory, 'agent_control.json');
  const server = createAdminDashboardServer({ agentStatusFile, agentControlFile });
  const requestBody = {
    jid: '100000000000023@lid',
    messageKey: {
      remoteJid: '249000000023@s.whatsapp.net',
      id: 'oldest-message-id',
      fromMe: false
    },
    timestamp: 1_700_000_000_000
  };

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(agentStatusFile, JSON.stringify({
      connectionState: 'connected',
      updatedAt: new Date().toISOString()
    }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/admin/agent-history`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'requested');
    const controlRequest = JSON.parse(fs.readFileSync(agentControlFile, 'utf8'));
    assert.equal(controlRequest.action, 'fetch_message_history');
    assert.deepEqual(controlRequest.messageKey, requestBody.messageKey);

    fs.writeFileSync(agentStatusFile, JSON.stringify({
      connectionState: 'disconnected',
      updatedAt: new Date().toISOString()
    }));
    const disconnectedResponse = await fetch(`${origin}/api/admin/agent-history`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    assert.equal(disconnectedResponse.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('dashboard connect endpoint starts one local agent process when disconnected', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-connect-test-'));
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 12345;
  child.unref = () => {};
  let launchCount = 0;
  const server = createAdminDashboardServer({
    agentStatusFile,
    launchAgent: () => {
      launchCount += 1;
      return child;
    }
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(agentStatusFile, JSON.stringify({
      connectionState: 'connected',
      updatedAt: new Date().toISOString()
    }));
    const activeResponse = await fetch(`${origin}/api/admin/agent-connect`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    assert.equal(activeResponse.status, 409);
    assert.equal(launchCount, 0);

    fs.rmSync(agentStatusFile);
    const response = await fetch(`${origin}/api/admin/agent-connect`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'connecting', processId: child.pid });
    assert.equal(launchCount, 1);

    const duplicateResponse = await fetch(`${origin}/api/admin/agent-connect`, {
      method: 'POST',
      headers: { Origin: origin }
    });
    assert.equal(duplicateResponse.status, 409);
    assert.equal(launchCount, 1);
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
    readData: () => { throw new Error('Media activity must not read conversation history.'); },
    readContacts: () => sampleData.contacts,
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
        studentName: 'Ali',
        description: 'Lesson 2',
        status: 'uploading',
        retryAvailable: false,
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

test('failed lesson videos expose a retry action and queue the exact activity', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-agent-media-retry-test-'));
  const agentMediaActivityFile = path.join(temporaryDirectory, 'agent_media_activity.json');
  const agentStatusFile = path.join(temporaryDirectory, 'agent_status.json');
  const agentMediaRetryRequestsFile = path.join(temporaryDirectory, 'media_retry_requests.json');
  const lessonsFile = path.join(temporaryDirectory, 'lessons.json');
  const activity = {
    id: 'failed-video-1',
    mediaType: 'video',
    label: 'Video',
    recipientJid: '1001@s.whatsapp.net',
    description: 'Lesson one caption',
    status: 'failed',
    loaded: 256,
    total: 1024,
    percent: 25,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeAgentMediaActivity(activity, agentMediaActivityFile);
  writeAgentStatus('connected', new Date().toISOString(), null, agentStatusFile);
  fs.writeFileSync(lessonsFile, JSON.stringify({
    grade_3_secondary: {
      lessons: [{
        id: 'lesson_1',
        title: 'Lesson one',
        videoFile: 'media/lesson_1.mp4',
        caption: 'Lesson one caption'
      }]
    }
  }));
  const server = createAdminDashboardServer({
    readData: () => sampleData,
    readContacts: () => sampleData.contacts,
    agentMediaActivityFile,
    agentMediaRetryRequestsFile,
    agentStatusFile,
    lessonsFile
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const activitiesResponse = await fetch(`${origin}/api/admin/agent-media`);
    const activities = await activitiesResponse.json();
    assert.equal(activities.activities[0].retryAvailable, true);

    const retryResponse = await fetch(`${origin}/api/admin/agent-media/failed-video-1/retry`, {
      method: 'POST',
      headers: { origin },
      body: '{}'
    });
    assert.equal(retryResponse.status, 202);
    assert.deepEqual(await retryResponse.json(), {
      status: 'retrying',
      activityId: 'failed-video-1'
    });
    assert.equal(
      JSON.parse(fs.readFileSync(agentMediaActivityFile, 'utf8')).activities[0].status,
      'retrying'
    );
    assert.equal(
      JSON.parse(fs.readFileSync(agentMediaRetryRequestsFile, 'utf8'))[0].activityId,
      'failed-video-1'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('lesson broadcast preview queues only eligible Es contacts inactive for over ten days', async () => {
  const previousAllowedNumbers = config.allowedNumbers;
  const previousBlockedNumbers = config.blockedNumbers;
  config.allowedNumbers = 'all';
  config.blockedNumbers = [];
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-lesson-broadcast-test-'));
  const lessonMediaDirectory = path.join(temporaryDirectory, 'media', 'lessons');
  const videoPath = path.join(lessonMediaDirectory, 'grade_1_primary', 'lesson.mp4');
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  fs.writeFileSync(videoPath, Buffer.from('lesson video'));
  const lessonsFile = path.join(temporaryDirectory, 'lessons.json');
  fs.writeFileSync(lessonsFile, JSON.stringify({
    grade_1_primary: {
      lessons: [{
        id: 'lesson_1',
        title: 'Lesson One',
        caption: 'Watch lesson one',
        videoFile: videoPath
      }]
    }
  }));
  const now = Date.now();
  const contacts = {
    '249111111111@s.whatsapp.net': {
      name: 'Inactive Es',
      isEs: true,
      savedInAddressBook: true
    },
    '249222222222@s.whatsapp.net': {
      name: 'Recent Es',
      isEs: true,
      savedInAddressBook: true
    },
    '249333333333@s.whatsapp.net': {
      name: 'Opted Out Es',
      isEs: true,
      savedInAddressBook: true
    },
    '249444444444@s.whatsapp.net': {
      name: 'Unknown Activity Es',
      isEs: true,
      savedInAddressBook: true
    }
  };
  const whatsappChatActivityFile = path.join(temporaryDirectory, 'chat_activity.json');
  fs.writeFileSync(whatsappChatActivityFile, JSON.stringify({
    '249111111111@s.whatsapp.net': now - 11 * 24 * 60 * 60 * 1000,
    '249222222222@s.whatsapp.net': now - 2 * 24 * 60 * 60 * 1000,
    '249333333333@s.whatsapp.net': now - 15 * 24 * 60 * 60 * 1000
  }));
  const followUpStateFile = path.join(temporaryDirectory, 'follow-up.json');
  fs.writeFileSync(followUpStateFile, JSON.stringify({
    optedOutJids: ['249333333333@s.whatsapp.net']
  }));
  const requestsFile = path.join(temporaryDirectory, 'broadcast_requests.json');
  const server = createAdminDashboardServer({
    readData: () => { throw new Error('Lesson broadcast must not read conversation history.'); },
    readContacts: () => contacts,
    whatsappChatActivityFile,
    followUpStateFile,
    blockedContactsFile: path.join(temporaryDirectory, 'blocked.json'),
    broadcastFiles: {
      requests: requestsFile,
      state: path.join(temporaryDirectory, 'broadcast_state.json')
    },
    lessonsFile,
    lessonMediaDirectory
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const query = new URLSearchParams({
      gradeKey: 'grade_1_primary',
      lessonId: 'lesson_1',
      isStandalone: 'false'
    });
    const previewResponse = await fetch(`${origin}/api/admin/curriculum/lesson-broadcast?${query}`);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.title, 'Lesson One');
    assert.equal(preview.total, 1);
    assert.equal(preview.inactiveDays, 10);

    fs.writeFileSync(whatsappChatActivityFile, JSON.stringify({
      '249111111111@s.whatsapp.net': now - 1 * 24 * 60 * 60 * 1000,
      '249222222222@s.whatsapp.net': now - 2 * 24 * 60 * 60 * 1000,
      '249333333333@s.whatsapp.net': now - 15 * 24 * 60 * 60 * 1000
    }));
    const changedRecipientsResponse = await fetch(`${origin}/api/admin/curriculum/lesson-broadcast`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewId: preview.previewId })
    });
    assert.equal(changedRecipientsResponse.status, 409);
    assert.equal(fs.existsSync(requestsFile), false);

    fs.writeFileSync(whatsappChatActivityFile, JSON.stringify({
      '249111111111@s.whatsapp.net': now - 11 * 24 * 60 * 60 * 1000,
      '249222222222@s.whatsapp.net': now - 2 * 24 * 60 * 60 * 1000,
      '249333333333@s.whatsapp.net': now - 15 * 24 * 60 * 60 * 1000
    }));
    const queuedResponse = await fetch(`${origin}/api/admin/curriculum/lesson-broadcast`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewId: preview.previewId })
    });
    assert.equal(queuedResponse.status, 202);
    assert.equal((await queuedResponse.json()).total, 1);
    const [job] = JSON.parse(fs.readFileSync(requestsFile, 'utf8'));
    assert.deepEqual(job.jids, ['249111111111@s.whatsapp.net']);
    assert.deepEqual(job.lessonVideo, {
      title: 'Lesson One',
      caption: 'Watch lesson one',
      videoFile: path.join('grade_1_primary', 'lesson.mp4')
    });
    assert.equal(job.recipientType, 'es');
    assert.equal(job.inactiveDays, 10);
  } finally {
    config.allowedNumbers = previousAllowedNumbers;
    config.blockedNumbers = previousBlockedNumbers;
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
    paused: false,
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

test('curriculum API endpoints allow viewing, saving, uploading video, and managing lessons', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-api-test-'));
  const testLessonsFile = path.join(temporaryDirectory, 'lessons.json');
  const testMediaDir = path.join(temporaryDirectory, 'media', 'lessons');
  fs.mkdirSync(path.join(testMediaDir, 'grade_3_secondary'), { recursive: true });

  const initialLessons = {
    grade_3_secondary: {
      name: 'الصف الثالث ثانوي',
      keywords: ['تالتة ثانوي'],
      lessons: [
        {
          id: 'lesson_1',
          title: 'Lesson 1: Intro',
          videoFile: 'media/lessons/grade_3_secondary/lesson_1.mp4',
          taskMessage: '1. What is X?',
          answerKey: ['1. X is Y']
        }
      ]
    }
  };
  fs.writeFileSync(testLessonsFile, JSON.stringify(initialLessons, null, 2), 'utf8');

  const server = createAdminDashboardServer({
    readData: () => ({ ...sampleData, lessons: JSON.parse(fs.readFileSync(testLessonsFile, 'utf8')) }),
    lessonsFile: testLessonsFile,
    lessonMediaDirectory: testMediaDir
  });

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;

    // 1. GET /api/admin/curriculum
    const overviewRes = await fetch(`${origin}/api/admin/curriculum`);
    assert.equal(overviewRes.status, 200);
    const overviewData = await overviewRes.json();
    assert.ok(Array.isArray(overviewData.stages));
    assert.equal(overviewData.totalLessons, 1);

    // 2. GET /api/admin/curriculum/grade
    const gradeRes = await fetch(`${origin}/api/admin/curriculum/grade?key=grade_3_secondary`);
    assert.equal(gradeRes.status, 200);
    const gradeData = await gradeRes.json();
    assert.equal(gradeData.key, 'grade_3_secondary');
    assert.equal(gradeData.lessons.length, 1);

    // 3. POST /api/admin/curriculum/video (upload lesson video)
    const videoBuffer = Buffer.from('simulated-mp4-stream');
    const uploadRes = await fetch(`${origin}/api/admin/curriculum/video`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'video/mp4',
        'x-grade-key': 'grade_3_secondary',
        'x-file-name': 'lesson_2.mp4'
      },
      body: videoBuffer
    });
    assert.equal(uploadRes.status, 201);
    const uploadData = await uploadRes.json();
    assert.equal(uploadData.success, true);
    assert.equal(uploadData.fileName, 'lesson_2.mp4');

    // 4. POST /api/admin/curriculum/lesson (add new lesson)
    const saveRes = await fetch(`${origin}/api/admin/curriculum/lesson`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        gradeKey: 'grade_3_secondary',
        lesson: {
          title: 'Lesson 2: Past Simple',
          videoFile: 'media/lessons/grade_3_secondary/lesson_2.mp4',
          taskMessage: '1. Conjugate verb.',
          answerKey: ['1. went']
        }
      })
    });
    assert.equal(saveRes.status, 200);
    const saveData = await saveRes.json();
    assert.equal(saveData.success, true);
    assert.equal(saveData.lesson.id, 'lesson_2');

    // Verify it was persisted to file
    const fileContent = JSON.parse(fs.readFileSync(testLessonsFile, 'utf8'));
    assert.equal(fileContent.grade_3_secondary.lessons.length, 2);

    const treasureUploadRes = await fetch(`${origin}/api/admin/curriculum/video`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'video/mp4',
        'x-grade-key': 'grade_3_secondary',
        'x-collection-id': 'treasure_island',
        'x-file-name': 'chapter_1.mp4'
      },
      body: Buffer.from('treasure-island-video')
    });
    assert.equal(treasureUploadRes.status, 201);
    const treasureUpload = await treasureUploadRes.json();
    assert.equal(treasureUpload.relativePath, 'media/lessons/grade_3_secondary/treasure_island/chapter_1.mp4');

    const treasureSaveRes = await fetch(`${origin}/api/admin/curriculum/lesson`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gradeKey: 'grade_3_secondary',
        collectionId: 'treasure_island',
        lesson: {
          id: 'chapter_1',
          title: 'Chapter One',
          videoFile: treasureUpload.relativePath,
          taskMessage: 'Answer the Chapter One questions.',
          answerKey: ['Jim Hawkins is the narrator.']
        }
      })
    });
    assert.equal(treasureSaveRes.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(testLessonsFile, 'utf8'))
      .grade_3_secondary.collections.treasure_island.lessons[0].id, 'chapter_1');

    // 5. POST /api/admin/curriculum/reorder
    const reorderRes = await fetch(`${origin}/api/admin/curriculum/reorder`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        gradeKey: 'grade_3_secondary',
        lessonIds: ['lesson_2', 'lesson_1']
      })
    });
    assert.equal(reorderRes.status, 200);
    const reorderData = await reorderRes.json();
    assert.equal(reorderData.lessons[0].id, 'lesson_2');

    // 6. DELETE /api/admin/curriculum/lesson
    const deleteRes = await fetch(`${origin}/api/admin/curriculum/lesson?gradeKey=grade_3_secondary&lessonId=lesson_2`, {
      method: 'DELETE',
      headers: { Origin: origin }
    });
    assert.equal(deleteRes.status, 200);
    const postDelContent = JSON.parse(fs.readFileSync(testLessonsFile, 'utf8'));
    assert.equal(postDelContent.grade_3_secondary.lessons.length, 1);
    assert.equal(postDelContent.grade_3_secondary.lessons[0].id, 'lesson_1');

    const treasureDeleteRes = await fetch(`${origin}/api/admin/curriculum/lesson?gradeKey=grade_3_secondary&lessonId=chapter_1&collectionId=treasure_island`, {
      method: 'DELETE',
      headers: { Origin: origin }
    });
    assert.equal(treasureDeleteRes.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(testLessonsFile, 'utf8'))
      .grade_3_secondary.collections.treasure_island.lessons.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
