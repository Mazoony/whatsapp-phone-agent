import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const OVERVIEW_WORKBOOK_FILE = path.join(ROOT_DIR, 'data', 'overview_statistics.xlsx');
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;

const SHEETS = {
  overview: {
    name: 'Daily Overview',
    key: ['snapshotDate'],
    columns: [
      { header: 'Snapshot date', key: 'snapshotDate', width: 16 },
      { header: 'Captured at', key: 'snapshotAt', width: 24 },
      { header: 'Tracked Telegram learners', key: 'telegramStudents', width: 26 },
      { header: 'Female learners', key: 'female', width: 18 },
      { header: 'Male learners', key: 'male', width: 16 },
      { header: 'Gender not identified', key: 'unknown', width: 23 },
      { header: 'Lessons completed', key: 'lessonsCompleted', width: 20 },
      { header: 'Completions · last 7 days', key: 'lessonCompletionsLast7Days', width: 26 },
      { header: 'Joined today', key: 'joinedToday', width: 16 },
      { header: 'Joined · last 7 days', key: 'joinedLast7Days', width: 22 },
      { header: 'Awaiting exercise', key: 'awaitingTask', width: 20 },
      { header: 'Needs another try', key: 'awaitingReattempt', width: 21 },
      { header: 'Completed status', key: 'completed', width: 19 },
      { header: 'Configured lessons', key: 'configuredLessons', width: 20 },
      { header: 'Primary group members', key: 'totalGroupMembers', width: 24 },
      { header: 'Online group members', key: 'onlineGroupMembers', width: 23 },
      { header: 'Online count status', key: 'onlineGroupMembersStatus', width: 22 }
    ]
  },
  classes: {
    name: 'Class History',
    key: ['snapshotDate', 'grade'],
    columns: [
      { header: 'Snapshot date', key: 'snapshotDate', width: 16 },
      { header: 'Captured at', key: 'snapshotAt', width: 24 },
      { header: 'Class', key: 'className', width: 30 },
      { header: 'Class grade', key: 'grade', width: 24 },
      { header: 'Telegram groups', key: 'groupIds', width: 32 },
      { header: 'Learners', key: 'students', width: 13 },
      { header: 'Joined today', key: 'joinedToday', width: 16 },
      { header: 'Joined · last 7 days', key: 'joinedLast7Days', width: 22 },
      { header: 'Lessons completed', key: 'lessonsCompleted', width: 20 },
      { header: 'Completions · last 7 days', key: 'lessonCompletionsLast7Days', width: 26 },
      { header: 'Active learners · last 7 days', key: 'activeLearnersLast7Days', width: 29 },
      { header: 'Awaiting exercise', key: 'awaitingTask', width: 20 },
      { header: 'Needs another try', key: 'awaitingReattempt', width: 21 },
      { header: 'Completed status', key: 'completed', width: 19 }
    ]
  },
  activity: {
    name: 'Telegram Activity',
    key: ['date'],
    columns: [
      { header: 'Activity date', key: 'date', width: 16 },
      { header: 'Recorded joins', key: 'joins', width: 18 },
      { header: 'Active tracked learners', key: 'activeLearners', width: 25 }
    ]
  }
};

function readRows(sheet) {
  if (!sheet || sheet.rowCount < 2) return [];
  const headers = sheet.getRow(1).values.slice(1).map(value => String(value || ''));
  return sheet.getRows(2, sheet.rowCount - 1).map(row =>
    Object.fromEntries(headers.map((header, index) => [header, row.getCell(index + 1).value]))
  );
}

function keyFor(row, headers) {
  return headers.map(header => String(row[header] ?? '')).join('\u0000');
}

function mergeRows(existingRows, incomingRows, keyHeaders) {
  const rows = new Map(existingRows.map(row => [keyFor(row, keyHeaders), row]));
  for (const row of incomingRows) rows.set(keyFor(row, keyHeaders), row);
  return [...rows.values()];
}

function configureSheet(workbook, definition, incomingRows) {
  const existingSheet = workbook.getWorksheet(definition.name);
  const existingRows = readRows(existingSheet);
  const headerKeys = definition.key.map(key =>
    definition.columns.find(column => column.key === key)?.header || key);
  const normalizedIncomingRows = incomingRows.map(row =>
    Object.fromEntries(definition.columns.map(column => [
      column.header,
      row[column.key] ?? null
    ]))
  );
  const rows = mergeRows(existingRows, normalizedIncomingRows, headerKeys)
    .sort((left, right) =>
      String(left[headerKeys[0]] || '').localeCompare(String(right[headerKeys[0]] || '')) ||
      String(left[headerKeys[1]] || '').localeCompare(String(right[headerKeys[1]] || '')));

  if (existingSheet) workbook.removeWorksheet(existingSheet.id);
  const sheet = workbook.addWorksheet(definition.name);
  sheet.columns = definition.columns;
  for (const row of rows) {
    const values = Object.fromEntries(definition.columns.map(column => [
      column.key,
      row[column.header] ?? null
    ]));
    sheet.addRow(values);
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: definition.columns.length }
  };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF176B4D' }
  };
}

export async function writeOverviewWorkbook(snapshot, filePath = OVERVIEW_WORKBOOK_FILE) {
  if (!snapshot || typeof snapshot.snapshotDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.snapshotDate) ||
      !Number.isFinite(Date.parse(snapshot.snapshotAt)) ||
      !Array.isArray(snapshot.classes) ||
      !Array.isArray(snapshot.dailyStats)) {
    throw new Error('Overview workbook snapshot is invalid.');
  }

  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(filePath)) await workbook.xlsx.readFile(filePath);
  const overviewRow = { ...snapshot.overview, snapshotDate: snapshot.snapshotDate, snapshotAt: snapshot.snapshotAt };
  const classRows = snapshot.classes.map(classStats => ({
    ...classStats,
    snapshotDate: snapshot.snapshotDate,
    snapshotAt: snapshot.snapshotAt,
    className: classStats.name,
    groupIds: classStats.groupIds.join(', ')
  }));
  configureSheet(workbook, SHEETS.overview, [overviewRow]);
  configureSheet(workbook, SHEETS.classes, classRows);
  configureSheet(workbook, SHEETS.activity, snapshot.dailyStats);

  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await workbook.xlsx.writeFile(temporaryPath);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Overview Workbook] Could not remove temporary workbook:', cleanupError.message);
    }
    throw error;
  }

  return {
    updatedAt: snapshot.snapshotAt,
    snapshots: workbook.getWorksheet(SHEETS.overview.name).rowCount - 1,
    classes: workbook.getWorksheet(SHEETS.classes.name).rowCount - 1,
    activityDays: workbook.getWorksheet(SHEETS.activity.name).rowCount - 1
  };
}

export async function readTelegramGroupMemberHistory(filePath = OVERVIEW_WORKBOOK_FILE) {
  if (!fs.existsSync(filePath)) return [];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(SHEETS.overview.name);
  if (!sheet || sheet.rowCount < 2) return [];

  const headers = sheet.getRow(1).values.slice(1).map(value => String(value || ''));
  const dateColumn = headers.indexOf('Snapshot date') + 1;
  const membersColumn = headers.indexOf('Primary group members') + 1;
  if (dateColumn === 0 || membersColumn === 0) return [];

  const snapshots = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const date = row.getCell(dateColumn).value;
    const members = row.getCell(membersColumn).value;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isSafeInteger(members) || members < 0) {
      continue;
    }
    snapshots.push({ date, members });
  }
  return snapshots.sort((left, right) => left.date.localeCompare(right.date));
}

export function createOverviewWorkbookManager({
  readSnapshot,
  filePath = OVERVIEW_WORKBOOK_FILE,
  onUpdated = () => {}
}) {
  if (typeof readSnapshot !== 'function') {
    throw new TypeError('Overview workbook snapshot provider must be a function.');
  }

  let refreshPromise = null;
  let generated = false;
  let timer = null;
  let stopped = false;
  let status = {
    state: 'updating',
    fileName: path.basename(filePath),
    updatedAt: null,
    snapshots: 0,
    classes: 0,
    activityDays: 0,
    error: null
  };

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      status = { ...status, state: 'updating', error: null };
      try {
        const result = await writeOverviewWorkbook(await readSnapshot(), filePath);
        status = { state: 'ready', fileName: path.basename(filePath), ...result, error: null };
        generated = true;
      } catch (error) {
        status = { ...status, state: 'error', error: error.message };
        console.error('[Overview Workbook] Could not update daily Excel history:', error.message);
      }
      try {
        onUpdated({ ...status });
      } catch (error) {
        console.error('[Overview Workbook] Could not notify dashboard:', error.message);
      }
      return { ...status };
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(async () => {
      const nextStatus = await refresh();
      schedule(nextStatus.error ? RETRY_INTERVAL_MS : DAILY_INTERVAL_MS);
    }, delay);
    timer.unref?.();
  }

  async function start() {
    stopped = false;
    const result = await refresh();
    schedule(result.error ? RETRY_INTERVAL_MS : DAILY_INTERVAL_MS);
    return result;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  async function getStatus() {
    if (!generated && !refreshPromise) await refresh();
    else if (refreshPromise) await refreshPromise;
    return { ...status };
  }

  return { start, stop, refresh, getStatus };
}
