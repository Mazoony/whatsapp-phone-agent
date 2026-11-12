import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeOverviewWorkbook } from './overview_workbook.js';

function snapshot(snapshotDate, telegramStudents) {
  return {
    snapshotDate,
    snapshotAt: `${snapshotDate}T12:00:00.000Z`,
    overview: {
      telegramStudents,
      female: 1,
      male: 1,
      unknown: 0,
      lessonsCompleted: telegramStudents,
      lessonCompletionsLast7Days: 2,
      joinedToday: 1,
      joinedLast7Days: 3,
      awaitingTask: 1,
      awaitingReattempt: 0,
      completed: 1,
      configuredLessons: 10,
      totalGroupMembers: 100,
      onlineGroupMembers: 4,
      onlineGroupMembersStatus: 'available'
    },
    classes: [{
      name: 'Third Secondary',
      grade: 'grade_3_secondary',
      groupIds: ['-100123'],
      students: telegramStudents,
      joinedToday: 1,
      joinedLast7Days: 3,
      lessonsCompleted: telegramStudents,
      lessonCompletionsLast7Days: 2,
      activeLearnersLast7Days: telegramStudents,
      awaitingTask: 1,
      awaitingReattempt: 0,
      completed: 1
    }],
    dailyStats: [
      { date: snapshotDate, joins: 1, activeLearners: telegramStudents },
      { date: '2026-11-11', joins: 0, activeLearners: 2 }
    ]
  };
}

test('Overview workbook keeps dated history and updates the same day instead of duplicating it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-workbook-'));
  const filePath = path.join(directory, 'overview.xlsx');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await writeOverviewWorkbook(snapshot('2026-11-11', 5), filePath);
  await writeOverviewWorkbook(snapshot('2026-11-12', 6), filePath);
  await writeOverviewWorkbook(snapshot('2026-11-12', 7), filePath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const overview = workbook.getWorksheet('Daily Overview');
  assert.equal(overview.rowCount, 3);
  assert.deepEqual(
    overview.getColumn(1).values.slice(2),
    ['2026-11-11', '2026-11-12']
  );
  assert.deepEqual(
    overview.getColumn(3).values.slice(2),
    [5, 7]
  );

  const classes = workbook.getWorksheet('Class History');
  assert.equal(classes.rowCount, 3);
  assert.equal(classes.getRow(3).getCell(6).value, 7);

  const activity = workbook.getWorksheet('Telegram Activity');
  assert.equal(activity.rowCount, 3);
  assert.equal(activity.getRow(2).getCell(1).value, '2026-11-11');
  assert.equal(activity.getRow(3).getCell(3).value, 7);
});
