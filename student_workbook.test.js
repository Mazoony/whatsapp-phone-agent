import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  createStudentWorkbookManager,
  writeStudentWorkbook
} from './student_workbook.js';

function makeData() {
  const phoneJid = '249000000001@s.whatsapp.net';
  const lidJid = '100000000000001@lid';
  return {
    contacts: {
      [phoneJid]: { jid: phoneJid, phoneJid, name: 'A Student Es', isEs: true, savedInAddressBook: true },
      [lidJid]: { jid: lidJid, phoneJid, name: 'A Student Es', isEs: true, savedInAddressBook: true },
      '100000000000002@g.us': { name: 'Ignored group', isEs: true }
    },
    history: {
      [phoneJid]: [
        { role: 'client', text: 'Hello teacher', timestamp: 1_800_000_000 },
        { role: 'agent', text: 'Hello student', timestamp: 1_800_000_100 }
      ],
      [lidJid]: [{ role: 'client', text: 'My answer', timestamp: 1_800_000_200 }],
      '100000000000002@g.us': [{ role: 'client', text: 'Group message', timestamp: 1_800_000_300 }]
    },
    progress: {
      [lidJid]: {
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_task',
        deliveredAt: '2026-01-01T00:00:00.000Z'
      }
    },
    lessons: {
      grade_3_secondary: {
        name: 'Year 3 Secondary',
        lessons: [{ id: 'lesson_1', title: 'Present Simple' }]
      }
    },
    optedOutJids: []
  };
}

test('Excel workbook consolidates student records and includes saved conversations', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-workbook-test-'));
  const filePath = path.join(directory, 'students.xlsx');
  try {
    const result = await writeStudentWorkbook(makeData(), filePath);
    assert.equal(result.students, 1);
    assert.equal(result.messages, 3);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const students = workbook.getWorksheet('Students');
    const conversations = workbook.getWorksheet('Conversation History');
    assert.ok(students);
    assert.ok(conversations);
    assert.equal(students.rowCount, 2);
    assert.equal(conversations.rowCount, 4);
    assert.equal(students.getRow(2).getCell(1).value, 'A Student Es');
    assert.equal(students.getRow(2).getCell(2).value, '249000000001');
    assert.equal(students.getRow(2).getCell(8).value, 'Year 3 Secondary');
    assert.equal(students.getRow(2).getCell(12).value, 3);
    assert.deepEqual(
      [2, 3, 4].map(row => conversations.getRow(row).getCell(5).value),
      ['Student', 'Agent', 'Student']
    );
    assert.equal(conversations.getRow(4).getCell(6).value, 'My answer');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Excel workbook includes Telegram enrollment and lesson progress', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-workbook-telegram-test-'));
  const filePath = path.join(directory, 'students.xlsx');
  const data = {
    ...makeData(),
    telegramProgress: {
      'telegram:-1004418934646:12345': {
        name: 'Telegram Student',
        telegramChatId: '-1004418934646',
        telegramUserId: 12345,
        telegramUsername: 'student_user',
        grade: 'grade_3_secondary',
        currentLessonIndex: 0,
        currentLessonId: 'lesson_1',
        status: 'awaiting_task',
        joinedAt: '2026-10-16T10:00:00.000Z',
        deliveredAt: '2026-10-16T10:01:00.000Z',
        lastActivityAt: '2026-10-16T10:02:00.000Z',
        lessonsCompleted: 2,
        submissionsReceived: 4
      }
    }
  };
  try {
    const result = await writeStudentWorkbook(data, filePath);
    assert.equal(result.students, 2);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const students = workbook.getWorksheet('Students');
    const telegramRow = [2, 3].map(row => students.getRow(row))
      .find(row => row.getCell(1).value === 'Telegram Student');
    assert.ok(telegramRow);
    assert.equal(telegramRow.getCell(16).value, 'Telegram');
    assert.equal(telegramRow.getCell(17).value, '-1004418934646');
    assert.equal(telegramRow.getCell(18).value, 12345);
    assert.equal(telegramRow.getCell(19).value, 'student_user');
    assert.equal(telegramRow.getCell(21).value, 2);
    assert.equal(telegramRow.getCell(22).value, 4);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workbook manager regenerates and reports current student data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'student-workbook-manager-test-'));
  const filePath = path.join(directory, 'students.xlsx');
  let data = makeData();
  const updates = [];
  const manager = createStudentWorkbookManager({
    readData: () => data,
    filePath,
    onUpdated: status => updates.push(status)
  });

  try {
    const initial = await manager.refresh();
    assert.equal(initial.state, 'ready');
    assert.equal(initial.students, 1);

    data.contacts['249000000003@s.whatsapp.net'] = {
      jid: '249000000003@s.whatsapp.net',
      name: 'Another student',
      isEs: false
    };
    const refreshed = await manager.refresh();
    assert.equal(refreshed.state, 'ready');
    assert.equal(refreshed.students, 2);
    assert.equal(updates.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
