import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createGoogleSheetsOverviewManager
} from './google_sheets_overview.js';
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
    dailyStats: [{ date: snapshotDate, joins: 1, activeLearners: telegramStudents }]
  };
}

function createFakeGoogleApi() {
  const spreadsheet = {
    spreadsheetId: 'spreadsheet-1',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/spreadsheet-1/edit',
    sheets: [
      { properties: { sheetId: 1, title: 'Daily Overview' } },
      { properties: { sheetId: 2, title: 'Class History' } },
      { properties: { sheetId: 3, title: 'Telegram Activity' } }
    ]
  };
  const rowsBySheetId = new Map();
  const calls = { creates: 0, permissionsCreated: 0 };
  const sheets = {
    spreadsheets: {
      create: async () => {
        calls.creates += 1;
        return { data: spreadsheet };
      },
      get: async () => ({ data: spreadsheet }),
      values: {
        batchGet: async ({ ranges }) => ({
          data: {
            valueRanges: ranges.map(range => {
              const title = range.slice(1, range.indexOf("'!"));
              const sheet = spreadsheet.sheets.find(item => item.properties.title === title);
              return { range, values: rowsBySheetId.get(sheet.properties.sheetId) || [] };
            })
          }
        })
      },
      batchUpdate: async ({ requestBody }) => {
        for (const request of requestBody.requests) {
          if (!request.updateCells) continue;
          const { sheetId } = request.updateCells.range;
          rowsBySheetId.set(sheetId, request.updateCells.rows.map(row =>
            row.values.map(cell =>
              cell.userEnteredValue?.numberValue ??
              cell.userEnteredValue?.boolValue ??
              cell.userEnteredValue?.stringValue ??
              ''
            )
          ));
        }
        return { data: {} };
      }
    }
  };
  const drive = {
    permissions: {
      list: async () => ({ data: { permissions: [] } }),
      create: async () => {
        calls.permissionsCreated += 1;
        return { data: { id: 'permission-1' } };
      }
    }
  };
  return { client: { sheets, drive }, rowsBySheetId, calls };
}

test('Google Sheets sync mirrors dated history and shares the created spreadsheet', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-google-sheet-'));
  const workbookFilePath = path.join(directory, 'overview.xlsx');
  const stateFilePath = path.join(directory, 'google-sheet.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await writeOverviewWorkbook(snapshot('2026-11-11', 5), workbookFilePath);
  const fake = createFakeGoogleApi();
  const manager = createGoogleSheetsOverviewManager({
    workbookFilePath,
    stateFilePath,
    credentialsJson: JSON.stringify({
      client_email: 'overview-bot@example.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    }),
    shareWith: 'owner@example.com',
    createClient: async () => fake.client
  });
  t.after(() => manager.stop());

  const firstStatus = await manager.start();
  assert.equal(firstStatus.state, 'ready');
  assert.equal(firstStatus.spreadsheetUrl, 'https://docs.google.com/spreadsheets/d/spreadsheet-1/edit');
  assert.equal(firstStatus.snapshots, 1);
  assert.equal(fake.calls.creates, 1);
  assert.equal(fake.calls.permissionsCreated, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).spreadsheetId, 'spreadsheet-1');

  await writeOverviewWorkbook(snapshot('2026-11-12', 6), workbookFilePath);
  const updatedStatus = await manager.refresh();
  assert.equal(updatedStatus.state, 'ready');
  assert.equal(updatedStatus.snapshots, 2);
  assert.equal(fake.calls.creates, 1);

  await writeOverviewWorkbook(snapshot('2026-11-12', 7), workbookFilePath);
  const sameDayStatus = await manager.refresh();
  assert.equal(sameDayStatus.snapshots, 2);

  const overviewRows = fake.rowsBySheetId.get(1);
  assert.deepEqual(overviewRows.slice(1).map(row => row[0]), ['2026-11-11', '2026-11-12']);
  assert.deepEqual(overviewRows.slice(1).map(row => row[2]), [5, 7]);
});

test('Google Sheets sync reports when service account configuration is missing', async () => {
  const manager = createGoogleSheetsOverviewManager({
    workbookFilePath: path.join(os.tmpdir(), 'missing-overview.xlsx'),
    credentialsJson: ''
  });
  assert.equal((await manager.start()).state, 'not_configured');
  manager.stop();
});
